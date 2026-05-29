const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function normalizeLoginKey(value) {
  return String(value || '').trim().toLowerCase();
}

function buildLoginKeys(fields) {
  const keys = new Set();
  const add = value => {
    const text = String(value || '').trim();
    if (!text) return;
    keys.add(normalizeLoginKey(text));
  };
  if (!fields) return [];
  add(fields.phone);
  add(fields.username);
  add(fields.email);
  add(fields.authEmail);
  add(fields.teacherId);
  return Array.from(keys);
}

function buildTeacherAuthEmail(teacher) {
  const username = String((teacher && teacher.username) || '').trim();
  const phone = String((teacher && teacher.phone) || '').replace(/[^0-9]/g, '');
  const teacherId = String((teacher && teacher.teacherId) || '').trim();
  if (username && username.includes('@')) return username;
  if (username && /^[0-9]+$/.test(username)) return username + '@ideaclub.local';
  if (phone) return phone + '@ideaclub.local';
  if (teacherId) return 'teacher_' + teacherId + '@ideaclub.local';
  return 'teacher_' + (teacherId || Date.now()) + '@ideaclub.local';
}

async function getServiceAccount() {
  const keyPath = path.join(__dirname, '..', 'functions', 'service-account-drive.json');
  if (!fs.existsSync(keyPath)) {
    throw new Error('Service account not found: ' + keyPath);
  }
  return require(keyPath);
}

async function ensureAuthUser(auth, authUid, authEmail, teacherId, name) {
  if (authUid) {
    try {
      const user = await auth.getUser(authUid);
      return user.uid;
    } catch (error) {
      if (error.code !== 'auth/user-not-found') {
        throw error;
      }
      authUid = '';
    }
  }

  if (authEmail) {
    try {
      const user = await auth.getUserByEmail(authEmail);
      return user.uid;
    } catch (error) {
      if (error.code !== 'auth/user-not-found') {
        throw error;
      }
    }
  }

  if (!authEmail) {
    authEmail = 'teacher_' + (teacherId || Date.now()) + '@ideaclub.local';
  }

  const user = await auth.createUser({
    email: authEmail,
    password: '000000',
    displayName: name || ''
  });
  return user.uid;
}

async function main() {
  const serviceAccount = await getServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const auth = admin.auth();
  const db = admin.firestore();

  const teacherSnapshot = await db.collection('teachers').get();
  const summary = {
    total: 0,
    repaired: 0,
    skipped: 0,
    authCreated: 0,
    usersSynced: 0,
    failed: []
  };

  for (const doc of teacherSnapshot.docs) {
    const data = doc.data() || {};
    const status = String(data.status || data.Status || '').toLowerCase();
    if (status !== 'active') continue;

    summary.total += 1;
    const teacherId = String(data.teacherId || data.id || doc.id || '').trim();
    const username = String(data.username || '').trim();
    const phone = String(data.phone || '').trim();
    const authEmail = String(data.authEmail || '').trim() || buildTeacherAuthEmail({ username, phone, teacherId });
    const email = String(data.email || '').trim() || authEmail;
    const loginId = String(data.loginId || '').trim() || teacherId || username || phone || authEmail;
    const loginKeys = buildLoginKeys({ phone, username, email, authEmail, teacherId });

    let authUid = String(data.authUid || '').trim();
    let createdAuth = false;
    let repaired = false;
    try {
      const needsTeacherUpdate = !authUid || !authEmail || !email || !username || !phone || !loginId || !Array.isArray(data.loginKeys) || loginKeys.length === 0;
      const usersDocRef = async uid => db.collection('users').doc(uid).get();

      if (!authUid) {
        authUid = await ensureAuthUser(auth, authUid, authEmail, teacherId, data.name);
        createdAuth = true;
      }

      const teacherPayload = {
        authUid: authUid,
        authEmail: authEmail,
        email: email,
        username: username || phone || authEmail,
        phone: phone || username || '',
        loginId: loginId,
        loginKeys: loginKeys,
        role: data.role || data.appRole || 'Teacher',
        status: data.status || 'Active'
      };

      await db.collection('teachers').doc(doc.id).set(teacherPayload, { merge: true });
      repaired = true;

      const usersPayload = {
        uid: authUid,
        authUid: authUid,
        accountType: 'teacher',
        role: teacherPayload.role,
        status: teacherPayload.status,
        teacherId: teacherId,
        username: teacherPayload.username,
        phone: teacherPayload.phone,
        authEmail: authEmail,
        email: email,
        loginKeys: loginKeys,
        name: data.name || '',
        subject: data.subject || '',
        branch: data.branch || '',
        permissions: Array.isArray(data.permissions) ? data.permissions : [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('users').doc(authUid).set(usersPayload, { merge: true });
      summary.usersSynced += 1;
      if (createdAuth) summary.authCreated += 1;
      if (repaired) summary.repaired += 1;
    } catch (error) {
      summary.failed.push({ teacherId: teacherId || doc.id, id: doc.id, reason: String(error.message || error.code || error) });
      summary.skipped += 1;
      console.error('Failed to repair teacher', teacherId || doc.id, error);
    }
  }

  console.log('Repair summary');
  console.log('Total active teachers scanned:', summary.total);
  console.log('Repaired teachers:', summary.repaired);
  console.log('Skipped/failed teachers:', summary.skipped);
  console.log('New Auth users created:', summary.authCreated);
  console.log('Users profiles synced:', summary.usersSynced);
  if (summary.failed.length) {
    console.log('Failed items:', JSON.stringify(summary.failed, null, 2));
  }
}

main().catch(err => {
  console.error('Repair run failed:', err);
  process.exit(1);
});
