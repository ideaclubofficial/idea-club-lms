#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const keyCandidates = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  path.join(rootDir, 'functions', 'service-account-drive.json'),
  path.join(rootDir, 'service-account-drive.json')
].filter(Boolean);

const keyPath = keyCandidates.find(function(candidate) { return fs.existsSync(candidate); });
if (!keyPath) {
  console.error('ERROR: ไม่พบ service account JSON file');
  process.exit(1);
}

const serviceAccount = require(keyPath);
const projectId = serviceAccount.project_id;
const args = process.argv.slice(2);
const write = args.includes('--write');
const teacherIdArg = (args.find(function(arg) { return arg.indexOf('--teacher-id=') === 0; }) || '').split('=')[1] || '';
const repairOrphanAdmin = args.includes('--repair-orphan-admin');
const optionValue = function(name) {
  const prefix = '--' + name + '=';
  return (args.find(function(arg) { return arg.indexOf(prefix) === 0; }) || '').slice(prefix.length);
};
const adminUidArg = optionValue('uid');
const adminPhoneArg = optionValue('phone');
const adminEmailArg = optionValue('email');
const adminNameArg = optionValue('name') || 'Admin IDEA CLUB';
const adminAppRoleArg = optionValue('app-role') || 'Admin';
let accessToken = null;

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function requestJson(options, body) {
  return new Promise(function(resolve, reject) {
    const req = https.request(options, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        let parsed = {};
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch (error) {
          reject(new Error('Invalid JSON response: ' + data.slice(0, 200)));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error((parsed.error && parsed.error.message) || ('HTTP ' + res.statusCode)));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  if (accessToken) return accessToken;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: unsigned + '.' + signature
  }).toString();
  const response = await requestJson({
    method: 'POST',
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  accessToken = response.access_token;
  return accessToken;
}

function fromFirestoreValue(value) {
  if (!value) return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in value) return fromFirestoreFields(value.mapValue.fields || {});
  return undefined;
}

function fromFirestoreFields(fields) {
  const data = {};
  Object.keys(fields || {}).forEach(function(key) {
    data[key] = fromFirestoreValue(fields[key]);
  });
  return data;
}

function toFirestoreValue(value) {
  if (Array.isArray(value)) return { arrayValue: value.length ? { values: value.map(toFirestoreValue) } : {} };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (value === null || value === undefined) return { nullValue: null };
  return { stringValue: String(value) };
}

async function listCollection(collectionName) {
  const token = await getAccessToken();
  const docs = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ pageSize: '300' });
    if (pageToken) query.set('pageToken', pageToken);
    const response = await requestJson({
      method: 'GET',
      hostname: 'firestore.googleapis.com',
      path: '/v1/projects/' + encodeURIComponent(projectId) + '/databases/(default)/documents/' + collectionName + '?' + query.toString(),
      headers: { Authorization: 'Bearer ' + token }
    });
    (response.documents || []).forEach(function(doc) {
      docs.push({ id: doc.name.split('/').pop(), data: fromFirestoreFields(doc.fields || {}) });
    });
    pageToken = response.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function patchDocument(collectionName, id, updates) {
  const token = await getAccessToken();
  const fields = {};
  const query = new URLSearchParams();
  Object.keys(updates).forEach(function(field) {
    query.append('updateMask.fieldPaths', field);
    fields[field] = toFirestoreValue(updates[field]);
  });
  await requestJson({
    method: 'PATCH',
    hostname: 'firestore.googleapis.com',
    path: '/v1/projects/' + encodeURIComponent(projectId) + '/databases/(default)/documents/' + collectionName + '/' + encodeURIComponent(id) + '?' + query.toString(),
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({ fields: fields }));
}

function loginKeys(record) {
  const values = [record.phone, record.username, record.email, record.authEmail, record.memberId, record.studentId, record.teacherId];
  return Array.from(new Set(values.map(function(value) { return String(value || '').trim().toLowerCase(); }).filter(Boolean)));
}

function hasStaffPermissions(record) {
  return Array.isArray(record.permissions) && record.permissions.some(function(permission) {
    return /^admin\.|^teacher\./i.test(String(permission || ''));
  });
}

function studentUserProfile(student, uid) {
  const email = String(student.authEmail || student.email || '').trim().toLowerCase();
  return {
    uid: uid,
    authUid: uid,
    accountType: 'student',
    role: 'student',
    appRole: 'student',
    permissions: [],
    permissionMode: 'student',
    status: 'active',
    memberId: student.memberId || student.studentId || '',
    studentId: student.studentId || student.memberId || '',
    linkedStudentId: student.firebaseDocId || student.id || '',
    name: student.name || '',
    nickname: student.nickname || '',
    parentName: student.parentName || '',
    phone: student.phone || '',
    authEmail: email,
    email: email,
    grade: student.grade || '',
    loginId: student.loginId || student.phone || student.memberId || student.studentId || email,
    loginKeys: loginKeys(student)
  };
}

function teacherUserProfile(teacher, uid) {
  const role = String(teacher.appRole || teacher.role || 'Teacher');
  const staffRole = ['SuperAdmin', 'Admin', 'Manager', 'Academic', 'Finance'].includes(role);
  const email = String(teacher.authEmail || teacher.email || '').trim().toLowerCase();
  return {
    uid: uid,
    authUid: uid,
    accountType: staffRole ? 'staff' : 'teacher',
    role: staffRole ? 'admin' : 'teacher',
    appRole: role,
    permissionMode: teacher.permissionMode || 'custom',
    permissions: Array.isArray(teacher.permissions) ? teacher.permissions : [],
    status: teacher.status === 'Inactive' ? 'inactive' : 'active',
    teacherId: teacher.teacherId || '',
    linkedTeacherId: teacher.firebaseDocId || teacher.id || '',
    name: teacher.name || '',
    username: teacher.username || '',
    phone: teacher.phone || '',
    authEmail: email,
    email: email,
    loginId: teacher.loginId || teacher.teacherId || teacher.username || teacher.phone || email,
    loginKeys: loginKeys(teacher)
  };
}

function adminUserProfile(input) {
  const uid = String(input.uid || '').trim();
  const phone = String(input.phone || '').replace(/[^0-9]/g, '');
  const email = String(input.email || (phone ? phone + '@ideaclub.local' : '')).trim().toLowerCase();
  const appRole = String(input.appRole || 'Admin').trim() || 'Admin';
  const permissions = appRole === 'SuperAdmin' || appRole === 'Admin' ? ['admin.full'] : ['admin.dashboard'];
  return {
    uid: uid,
    authUid: uid,
    accountType: 'staff',
    role: 'admin',
    appRole: appRole,
    permissions: permissions,
    permissionMode: 'custom',
    status: 'active',
    name: input.name || 'Admin IDEA CLUB',
    phone: phone,
    authEmail: email,
    email: email,
    loginId: phone || email,
    loginKeys: loginKeys({ phone: phone, email: email, authEmail: email })
  };
}

function userNeedsStudentFix(user) {
  return !user
    || user.accountType !== 'student'
    || user.role !== 'student'
    || user.appRole !== 'student'
    || hasStaffPermissions(user);
}

function userNeedsTeacherFix(user, teacher) {
  if (!user) return true;
  const expected = teacherUserProfile(teacher, teacher.authUid);
  return user.accountType !== expected.accountType
    || user.role !== expected.role
    || user.appRole !== expected.appRole
    || user.linkedTeacherId !== expected.linkedTeacherId;
}

(async function main() {
  console.log('==== audit-account-links.js ====');
  console.log('mode:', write ? 'WRITE' : 'DRY-RUN');

  if (repairOrphanAdmin) {
    if (!adminUidArg) throw new Error('ต้องระบุ --uid=<firebase auth uid> สำหรับ --repair-orphan-admin');
    if (!adminEmailArg && !adminPhoneArg) throw new Error('ต้องระบุ --email หรือ --phone สำหรับ --repair-orphan-admin');
    const profile = adminUserProfile({
      uid: adminUidArg,
      phone: adminPhoneArg,
      email: adminEmailArg,
      name: adminNameArg,
      appRole: adminAppRoleArg
    });
    console.log('orphan admin repair target:', {
      uid: profile.uid,
      email: profile.email,
      phone: profile.phone,
      appRole: profile.appRole,
      permissions: profile.permissions
    });
    if (!write) {
      console.log('DRY-RUN: ไม่มีการบันทึกใดๆ');
      return;
    }
    await patchDocument('users', profile.uid, profile);
    console.log('เขียนซ่อม orphan admin users/' + profile.uid + ' เรียบร้อย');
    return;
  }

  const students = await listCollection('students');
  const teachers = await listCollection('teachers');
  const users = await listCollection('users');
  const usersById = new Map(users.map(function(doc) { return [doc.id, doc.data]; }));

  const studentsMissingAuth = students.filter(function(doc) { return !doc.data.authUid; });
  const teachersMissingAuth = teachers.filter(function(doc) { return !doc.data.authUid; });
  const studentUserIssues = students.filter(function(doc) {
    return doc.data.authUid && userNeedsStudentFix(usersById.get(String(doc.data.authUid)));
  });
  const teacherUserIssues = teachers.filter(function(doc) {
    return doc.data.authUid && userNeedsTeacherFix(usersById.get(String(doc.data.authUid)), Object.assign({ id: doc.id }, doc.data));
  });

  console.log('students ไม่มี authUid:', studentsMissingAuth.length);
  console.log('teachers ไม่มี authUid:', teachersMissingAuth.length);
  console.log('student users/{uid} ต้องซ่อม:', studentUserIssues.length);
  console.log('teacher users/{uid} ต้องซ่อม:', teacherUserIssues.length);

  studentUserIssues.slice(0, 10).forEach(function(doc) {
    console.log('- student fix:', doc.id, doc.data.name || '-', doc.data.authUid);
  });
  teacherUserIssues.slice(0, 10).forEach(function(doc) {
    console.log('- teacher fix:', doc.id, doc.data.name || '-', doc.data.authUid);
  });

  if (!write) {
    console.log('DRY-RUN: ไม่มีการบันทึกใดๆ');
    return;
  }

  for (const doc of studentUserIssues) {
    await patchDocument('users', String(doc.data.authUid), studentUserProfile(Object.assign({ id: doc.id, firebaseDocId: doc.id }, doc.data), String(doc.data.authUid)));
  }

  const allowedTeacherIssues = teacherIdArg === 'all'
    ? teacherUserIssues
    : teacherUserIssues.filter(function(doc) { return doc.id === teacherIdArg || doc.data.teacherId === teacherIdArg; });

  if (teacherUserIssues.length && !teacherIdArg) {
    console.log('SKIP teacher repair: ระบุ --teacher-id=<docId|teacherId|all> ถ้าต้องการซ่อมครูแบบเจาะจง');
  }

  for (const doc of allowedTeacherIssues) {
    await patchDocument('users', String(doc.data.authUid), teacherUserProfile(Object.assign({ id: doc.id, firebaseDocId: doc.id }, doc.data), String(doc.data.authUid)));
  }

  console.log('เขียนซ่อม student users:', studentUserIssues.length);
  console.log('เขียนซ่อม teacher users:', allowedTeacherIssues.length);
})();
