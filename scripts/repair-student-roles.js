#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const envKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const defaultKeyPaths = [
  envKeyPath,
  path.join(rootDir, 'functions', 'service-account-drive.json'),
  path.join(rootDir, 'service-account-drive.json')
].filter(function(p) { return p; });

let keyPath = null;
for (const candidate of defaultKeyPaths) {
  if (fs.existsSync(candidate)) {
    keyPath = candidate;
    break;
  }
}

if (!keyPath) {
  console.error('ERROR: ไม่พบ service account JSON file. ตั้งค่า GOOGLE_APPLICATION_CREDENTIALS หรือสร้างไฟล์ functions/service-account-drive.json หรือ service-account-drive.json');
  process.exit(1);
}

const serviceAccount = require(keyPath);
const projectId = serviceAccount.project_id;
const args = process.argv.slice(2);
const write = args.includes('--write');
const verbose = args.includes('--verbose');
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
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch (error) {
          reject(new Error('Invalid JSON response: ' + data.slice(0, 200)));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error((parsed && (parsed.error_description || parsed.error && parsed.error.message)) || ('HTTP ' + res.statusCode)));
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
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const unsigned = header + '.' + claim;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const assertion = unsigned + '.' + signature;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: assertion
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

function firestoreValueToJs(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    return (value.arrayValue.values || []).map(firestoreValueToJs);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) {
    return firestoreFieldsToJs(value.mapValue.fields || {});
  }
  return undefined;
}

function firestoreFieldsToJs(fields) {
  const data = {};
  Object.keys(fields || {}).forEach(function(key) {
    data[key] = firestoreValueToJs(fields[key]);
  });
  return data;
}

function jsToFirestoreValue(value) {
  if (Array.isArray(value)) {
    return { arrayValue: value.length ? { values: value.map(jsToFirestoreValue) } : {} };
  }
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
      docs.push({
        id: doc.name.split('/').pop(),
        name: doc.name,
        data: firestoreFieldsToJs(doc.fields || {})
      });
    });
    pageToken = response.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function updateDocument(collectionName, id, updates) {
  const token = await getAccessToken();
  const fieldNames = Object.keys(updates);
  if (!fieldNames.length) return;
  const query = new URLSearchParams();
  fieldNames.forEach(function(field) { query.append('updateMask.fieldPaths', field); });
  const fields = {};
  fieldNames.forEach(function(field) {
    fields[field] = jsToFirestoreValue(updates[field]);
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

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase();
}

function isStudentRole(value) {
  return normalizeRole(value) === 'student';
}

function isStaffRole(value) {
  const normalized = normalizeRole(value);
  return ['super_admin', 'admin', 'manager', 'academic', 'finance', 'teacher', 'assistant', 'viewer'].includes(normalized);
}

function isStudentCandidate(user) {
  return isStudentRole(user.role) || String(user.accountType || '').trim().toLowerCase() === 'student' || !!user.studentId || !!user.memberId;
}

function hasAdminOrTeacherPermissions(record) {
  const permissions = Array.isArray(record.permissions) ? record.permissions : [];
  return permissions.some(function(permission) {
    return /^admin\.|^teacher\./i.test(String(permission || ''));
  });
}

function buildStudentFixes(data) {
  const updates = {};
  if (!isStudentRole(data.role)) updates.role = 'student';
  if (String(data.accountType || '').trim().toLowerCase() !== 'student') updates.accountType = 'student';
  if (String(data.appRole || '').trim().toLowerCase() !== 'student') updates.appRole = 'student';
  if (hasAdminOrTeacherPermissions(data)) updates.permissions = [];
  if (String(data.permissionMode || '').trim().toLowerCase() !== 'student') updates.permissionMode = 'student';
  if (!data.status) updates.status = 'active';
  return updates;
}

function buildUserFixes(data) {
  const updates = {};
  if (!isStudentRole(data.role)) updates.role = 'student';
  if (String(data.accountType || '').trim().toLowerCase() !== 'student') updates.accountType = 'student';
  if (String(data.appRole || '').trim().toLowerCase() !== 'student') updates.appRole = 'student';
  if (hasAdminOrTeacherPermissions(data)) updates.permissions = [];
  if (String(data.permissionMode || '').trim().toLowerCase() !== 'student') updates.permissionMode = 'student';
  if (!data.status) updates.status = 'active';
  return updates;
}

async function scanStudents() {
  const docs = await listCollection('students');
  const reports = [];
  for (const doc of docs) {
    const data = doc.data;
    const fixes = buildStudentFixes(data);
    if (Object.keys(fixes).length) {
      reports.push({ id: doc.id, path: `students/${doc.id}`, data, fixes });
    }
  }
  return reports;
}

async function scanUsers() {
  const studentDocs = await listCollection('students');
  const studentPhones = new Set(studentDocs.map(function(doc) {
    return String(doc.data.phone || '').replace(/[^0-9]/g, '');
  }).filter(function(phone) { return phone; }));

  const docs = await listCollection('users');
  const reports = [];
  for (const doc of docs) {
    const data = doc.data;
    const phone = String(data.phone || '').replace(/[^0-9]/g, '');
    const candidate = isStudentCandidate(data) || (phone && studentPhones.has(phone));
    if (!candidate) continue;
    const fixes = buildUserFixes(data);
    if (Object.keys(fixes).length) {
      reports.push({ id: doc.id, path: `users/${doc.id}`, data, fixes });
    }
  }
  return reports;
}

function prettyPrintIssues(items, label) {
  if (!items.length) {
    console.log(`OK: ไม่มี ${label} ที่ต้องซ่อมแซม`);
    return;
  }
  console.log(`FOUND ${items.length} ${label} ที่พบปัญหา`);
  items.slice(0, 10).forEach(function(item) {
    console.log(`- ${item.path} role=${item.data.role || '-'} accountType=${item.data.accountType || '-'} permissions=${JSON.stringify(item.data.permissions || [])} status=${item.data.status || '-'}${item.data.appRole ? ' appRole=' + item.data.appRole : ''}`);
  });
  if (items.length > 10) {
    console.log(`  ...แสดง 10 รายการแรก จากทั้งหมด ${items.length}`);
  }
}

async function applyRepairs(items, collectionName) {
  for (const item of items) {
    const updates = Object.assign({}, item.fixes);
    if (Object.keys(updates).length) {
      await updateDocument(collectionName, item.id, updates);
    }

    if (verbose) {
      console.log(`UPDATED ${collectionName}/${item.id}`, item.fixes);
    }
  }
}

(async function main() {
  console.log('==== repair-student-roles.js ====');
  console.log(`mode: ${write ? 'WRITE' : 'DRY-RUN'}`);

  const studentDocs = await listCollection('students');
  const studentCount = studentDocs.length;
  const studentIssues = await scanStudents();
  const userIssues = await scanUsers();

  console.log(`นักเรียนทั้งหมด: ${studentCount}`);
  prettyPrintIssues(studentIssues, 'student documents');
  prettyPrintIssues(userIssues, 'user profiles');

  if (write) {
    if (!studentIssues.length && !userIssues.length) {
      console.log('ไม่มีรายการต้องแก้ไข');
      process.exit(0);
    }
    console.log('เริ่มเขียนแก้ไขข้อมูล...');
    await applyRepairs(studentIssues, 'students');
    await applyRepairs(userIssues, 'users');
    console.log('เสร็จสิ้นการซ่อมแซมข้อมูลนักเรียน');
  } else {
    console.log('DRY-RUN: ไม่มีการบันทึกใดๆ หากต้องการแก้จริง ให้รันด้วย --write');
  }

  process.exit(0);
})();
