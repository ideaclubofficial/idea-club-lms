#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const ADMIN_PERMISSIONS = [
  'admin.full',
  'admin.dashboard',
  'admin.students',
  'admin.courses',
  'admin.online',
  'admin.ondemand',
  'admin.finance',
  'admin.receipts',
  'admin.exams',
  'admin.monthlyPlanner',
  'admin.users',
  'admin.announcements',
  'admin.settings',
  'admin.logs',
  'teacher.dashboard',
  'teacher.online',
  'teacher.attendance',
  'teacher.students'
];

const rootDir = path.resolve(__dirname, '..');
const keyCandidates = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  path.join(rootDir, 'service-account-drive.json'),
  path.join(rootDir, 'functions', 'service-account-drive.json')
].filter(Boolean);

const keyPath = keyCandidates.find(function(candidate) { return fs.existsSync(candidate); });
if (!keyPath) {
  console.error('ERROR: ไม่พบ service account JSON file');
  process.exit(1);
}

const serviceAccount = require(keyPath);
const projectId = serviceAccount.project_id;
let accessToken = null;

function getArg(name, fallback) {
  const prefix = '--' + name + '=';
  const inline = process.argv.find(function(arg) { return arg.indexOf(prefix) === 0; });
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf('--' + name);
  if (index !== -1 && process.argv[index + 1] && process.argv[index + 1].indexOf('--') !== 0) {
    return process.argv[index + 1];
  }
  return fallback;
}

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
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const unsigned = header + '.' + claim;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const response = await requestJson({
    method: 'POST',
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: unsigned + '.' + signature
  }).toString());
  accessToken = response.access_token;
  return accessToken;
}

function toFirestoreValue(value) {
  if (Array.isArray(value)) return { arrayValue: value.length ? { values: value.map(toFirestoreValue) } : {} };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (value === null || value === undefined) return { nullValue: null };
  return { stringValue: String(value) };
}

async function patchDocument(collectionName, id, payload) {
  const token = await getAccessToken();
  const fields = {};
  const query = new URLSearchParams();
  Object.keys(payload).forEach(function(field) {
    query.append('updateMask.fieldPaths', field);
    fields[field] = toFirestoreValue(payload[field]);
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

async function lookupAuthUserByEmail(email) {
  const token = await getAccessToken();
  const response = await requestJson({
    method: 'POST',
    hostname: 'identitytoolkit.googleapis.com',
    path: '/v1/projects/' + encodeURIComponent(projectId) + '/accounts:lookup',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({ email: [email] }));
  const user = response.users && response.users[0] ? response.users[0] : null;
  return user ? { uid: user.localId, email: user.email, disabled: user.disabled === true } : null;
}

async function updateAuthUser(uid, name, password) {
  const token = await getAccessToken();
  const body = {
    localId: uid,
    displayName: name,
    disableUser: false
  };
  if (password) body.password = password;
  await requestJson({
    method: 'POST',
    hostname: 'identitytoolkit.googleapis.com',
    path: '/v1/projects/' + encodeURIComponent(projectId) + '/accounts:update',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify(body));
}

async function createAuthUser(email, name, password) {
  const token = await getAccessToken();
  if (!password) {
    throw new Error('ไม่พบ Auth user นี้ และไม่ได้ส่ง --password จึงไม่สร้าง user ใหม่เพื่อหลีกเลี่ยงบัญชีที่ไม่มีรหัสผ่าน');
  }
  const response = await requestJson({
    method: 'POST',
    hostname: 'identitytoolkit.googleapis.com',
    path: '/v1/projects/' + encodeURIComponent(projectId) + '/accounts',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({
    email: email,
    password: password,
    displayName: name,
    emailVerified: true,
    disabled: false
  }));
  return { uid: response.localId, email: response.email, disabled: response.disabled === true };
}

function normalizeRole(role) {
  const value = String(role || 'SuperAdmin').trim();
  if (value === 'Super Admin' || value === 'super_admin') return 'SuperAdmin';
  return value || 'SuperAdmin';
}

function buildPayloads(uid, email, name, phone, role) {
  const appRole = normalizeRole(role);
  const loginKeys = [email];
  const base = {
    uid: uid,
    authUid: uid,
    email: email,
    authEmail: email,
    username: email,
    loginId: email,
    phone: phone,
    name: name,
    status: 'Active',
    permissionMode: 'custom',
    permissions: ADMIN_PERMISSIONS.slice(),
    loginKeys: loginKeys
  };

  return {
    usersPayload: Object.assign({}, base, {
      accountType: 'staff',
      role: 'admin',
      appRole: appRole,
      teacherId: 'SUPERADMIN',
      linkedTeacherId: uid
    }),
    teachersPayload: {
      id: uid,
      firebaseDocId: uid,
      authUid: uid,
      authEmail: email,
      email: email,
      username: email,
      loginId: email,
      loginKeys: loginKeys,
      name: name,
      teacherId: 'SUPERADMIN',
      role: appRole,
      appRole: appRole,
      status: 'Active',
      subject: 'ผู้ดูแลระบบ',
      branch: 'IDEA CLUB',
      permissionMode: 'custom',
      permissions: ADMIN_PERMISSIONS.slice()
    }
  };
}

async function main() {
  const email = String(getArg('email', 'ideaclubofficial@gmail.com')).trim().toLowerCase();
  const name = String(getArg('name', 'IDEA CLUB Super Admin')).trim();
  const role = normalizeRole(getArg('role', 'SuperAdmin'));
  const phone = String(getArg('phone', '')).trim();
  const password = String(getArg('password', '') || '');

  if (!email) throw new Error('ต้องระบุ --email');

  let authUser = await lookupAuthUserByEmail(email);
  let authCreated = false;
  if (!authUser) {
    authUser = await createAuthUser(email, name, password);
    authCreated = true;
  } else if (password || authUser.disabled) {
    await updateAuthUser(authUser.uid, name, password);
  } else {
    await updateAuthUser(authUser.uid, name, '');
  }

  const uid = authUser.uid;
  const payloads = buildPayloads(uid, email, name, phone, role);
  await patchDocument('users', uid, payloads.usersPayload);
  await patchDocument('teachers', uid, payloads.teachersPayload);

  console.log('==== bootstrap-admin.js ====');
  console.log('Auth user uid:', uid);
  console.log('Auth user created:', authCreated ? 'yes' : 'no, reused existing user');
  console.log('users/' + uid + ' updated: yes');
  console.log('teachers/' + uid + ' updated: yes');
  console.log('reset password:', password ? 'yes (--password was provided)' : 'no');
  console.log('deleted user: no');
}

main().catch(function(error) {
  console.error('bootstrap admin failed:', error.message || error);
  process.exit(1);
});
