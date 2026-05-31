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
  console.log('mode: AUDIT ONLY');

  if (write || repairOrphanAdmin) {
    throw new Error('audit-account-links.js เป็นโหมดตรวจอย่างเดียวแล้ว กรุณาใช้ scripts/bootstrap-admin.js สำหรับซ่อม admin/staff');
  }

  const students = await listCollection('students');
  const teachers = await listCollection('teachers');
  const users = await listCollection('users');
  const usersById = new Map(users.map(function(doc) { return [doc.id, doc.data]; }));

  function normalized(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isAdminLike(role) {
    return ['superadmin', 'admin', 'manager', 'academic', 'finance', 'financeadmin', 'teacheradmin', 'staff'].includes(normalized(role));
  }

  function isActiveStatus(value) {
    const status = normalized(value || 'active');
    return status === 'active' || status === 'ใช้งาน';
  }

  function isStudentUser(user) {
    return user
      && (normalized(user.accountType) === 'student'
        || normalized(user.role) === 'student'
        || normalized(user.appRole) === 'student');
  }

  function isStaffOrTeacherUser(user) {
    return user
      && !isStudentUser(user)
      && (
        ['staff', 'teacher', 'admin'].includes(normalized(user.accountType))
        || ['admin', 'teacher', 'staff', 'manager', 'academic', 'finance', 'superadmin'].includes(normalized(user.role))
        || ['superadmin', 'admin', 'manager', 'academic', 'finance', 'teacher', 'assistantteacher'].includes(normalized(user.appRole))
      );
  }

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

  const studentPermissionLeaks = users.filter(function(doc) {
    return isStudentUser(doc.data) && hasStaffPermissions(doc.data);
  });
  const adminMissingFull = users.filter(function(doc) {
    return ['superadmin', 'admin'].includes(normalized(doc.data.appRole || doc.data.role))
      && isActiveStatus(doc.data.status)
      && !isStudentUser(doc.data)
      && (!Array.isArray(doc.data.permissions) || !doc.data.permissions.includes('admin.full'));
  });
  const usersRoleIssues = users.filter(function(doc) {
    const user = doc.data;
    if (!user.authUid || String(user.authUid) !== doc.id) return true;
    if (isStudentUser(user)) return normalized(user.accountType) !== 'student' || normalized(user.role) !== 'student';
    if (isAdminLike(user.appRole || user.role)) return !isStaffOrTeacherUser(user) || normalized(user.role) !== 'admin';
    if (normalized(user.appRole) === 'teacher' || normalized(user.role) === 'teacher') return !isStaffOrTeacherUser(user);
    return false;
  });
  const teacherRoleIssues = teachers.filter(function(doc) {
    const user = doc.data.authUid ? usersById.get(String(doc.data.authUid)) : null;
    if (!doc.data.authUid || !user) return false;
    const role = doc.data.appRole || doc.data.role || 'Teacher';
    return isAdminLike(role)
      ? !(normalized(user.accountType) === 'staff' && normalized(user.role) === 'admin')
      : !(normalized(user.accountType) === 'teacher' || normalized(user.role) === 'teacher');
  });

  console.log('student users มี staff/admin permission ค้าง:', studentPermissionLeaks.length);
  console.log('admin/SuperAdmin ไม่มี admin.full:', adminMissingFull.length);
  console.log('users role/accountType/status น่าสงสัย:', usersRoleIssues.length);
  console.log('teachers role ไม่ตรง users/{authUid}:', teacherRoleIssues.length);

  studentUserIssues.slice(0, 10).forEach(function(doc) {
    console.log('- student fix:', doc.id, doc.data.name || '-', doc.data.authUid);
  });
  teacherUserIssues.slice(0, 10).forEach(function(doc) {
    console.log('- teacher fix:', doc.id, doc.data.name || '-', doc.data.authUid);
  });
  studentPermissionLeaks.slice(0, 10).forEach(function(doc) {
    console.log('- student permission leak:', doc.id, doc.data.name || '-', doc.data.permissions || []);
  });
  adminMissingFull.slice(0, 10).forEach(function(doc) {
    console.log('- admin missing admin.full:', doc.id, doc.data.name || '-', doc.data.appRole || doc.data.role || '-');
  });
  usersRoleIssues.slice(0, 10).forEach(function(doc) {
    console.log('- user role issue:', doc.id, doc.data.name || '-', {
      accountType: doc.data.accountType,
      role: doc.data.role,
      appRole: doc.data.appRole,
      status: doc.data.status
    });
  });
  teacherRoleIssues.slice(0, 10).forEach(function(doc) {
    console.log('- teacher role mismatch:', doc.id, doc.data.name || '-', doc.data.authUid);
  });

  console.log('AUDIT ONLY: ไม่มีการบันทึกใดๆ');
})();
