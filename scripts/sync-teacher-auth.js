const admin = require('firebase-admin');
const fs = require('fs');

// Config
const LOGIN = '0831234003';
const AUTH_EMAIL = '0831234003@ideaclub.local';
const AUTH_UID = 'j4CJLX9AyoXcoY2wukzz5uJ7hzE3';

function normalizeRole(role) {
  const value = String(role || 'Teacher').trim();
  const lower = value.toLowerCase();
  if (value === 'Super Admin' || value === 'super_admin' || lower === 'superadmin') return 'SuperAdmin';
  if (lower === 'admin') return 'Admin';
  if (lower === 'manager') return 'Manager';
  if (lower === 'academic') return 'Academic';
  if (lower === 'finance' || lower === 'financeadmin') return 'Finance';
  if (lower === 'assistant' || lower === 'assistantteacher') return 'Assistant';
  if (lower === 'viewer') return 'Viewer';
  if (lower === 'teacher' || lower === 'teacheradmin') return 'Teacher';
  return value || 'Teacher';
}

function isAdminLikeRole(role) {
  return ['SuperAdmin', 'Admin', 'Manager', 'Academic', 'Finance', 'Viewer'].includes(normalizeRole(role));
}

async function main() {
  // Load service account
  const path = require('path');
  const keyPath = path.join(__dirname, '..', 'functions', 'service-account-drive.json');
  if (!fs.existsSync(keyPath)) {
    console.error('Service account not found:', keyPath);
    process.exit(1);
  }
  const serviceAccount = require(keyPath);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const db = admin.firestore();

  console.log('Searching teachers collection for login:', LOGIN);

  const candidates = new Map();

  // Helper to add results
  function pushDoc(doc) {
    if (!doc || !doc.id) return;
    if (!candidates.has(doc.id)) candidates.set(doc.id, { id: doc.id, data: doc.data() });
  }

  // Queries to run
  const queries = [
    db.collection('teachers').where('authUid', '==', AUTH_UID).limit(5).get(),
    db.collection('teachers').where('authEmail', '==', AUTH_EMAIL).limit(5).get(),
    db.collection('teachers').where('username', '==', LOGIN).limit(5).get(),
    db.collection('teachers').where('phone', '==', LOGIN).limit(5).get(),
    db.collection('teachers').where('teacherId', '==', LOGIN).limit(5).get(),
    db.collection('teachers').where('loginId', '==', LOGIN).limit(5).get(),
    db.collection('teachers').where('email', '==', AUTH_EMAIL).limit(5).get(),
  ];

  for (const q of queries) {
    try {
      const snap = await q;
      snap.forEach(doc => pushDoc(doc));
    } catch (e) {
      console.warn('Query error (continuing):', e.message);
    }
  }

  const results = Array.from(candidates.values());
  if (!results.length) {
    console.log('No matching teacher record found for queries. Listing some teachers with similar empty/nearby fields...');
    const sample = await db.collection('teachers').limit(10).get();
    const sampleList = [];
    sample.forEach(d => sampleList.push({ id: d.id, ...d.data() }));
    console.log(JSON.stringify({ found: false, sample: sampleList }, null, 2));
    console.log('Will not create a new teacher record automatically. Please review the samples and decide next steps.');
    process.exit(0);
  }

  // Choose best match: prefer authUid, then authEmail, then username/phone
  let chosen = null;
  for (const r of results) {
    const d = r.data;
    if (d.authUid === AUTH_UID) { chosen = r; break; }
  }
  if (!chosen) {
    for (const r of results) {
      const d = r.data;
      if (d.authEmail === AUTH_EMAIL) { chosen = r; break; }
    }
  }
  if (!chosen) {
    for (const r of results) {
      const d = r.data;
      if (d.username === LOGIN || d.phone === LOGIN || d.teacherId === LOGIN) { chosen = r; break; }
    }
  }

  if (!chosen) chosen = results[0];

  console.log('Selected teacher to update:', chosen.id, chosen.data.name || '(no name)');

  const appRole = normalizeRole(chosen.data.appRole || chosen.data.role || 'Teacher');
  const accountType = isAdminLikeRole(appRole) ? 'staff' : 'teacher';
  const userRole = isAdminLikeRole(appRole) ? 'admin' : 'teacher';

  // Build update payload for teacher
  const teacherMerge = Object.assign({}, {
    authUid: AUTH_UID,
    authEmail: AUTH_EMAIL,
    email: AUTH_EMAIL,
    username: LOGIN,
    phone: LOGIN,
    loginId: LOGIN,
    role: appRole,
    appRole: appRole,
    permissionMode: chosen.data.permissionMode || 'custom',
    status: 'Active'
  });

  // Merge loginKeys
  const existingLoginKeys = Array.isArray(chosen.data.loginKeys) ? chosen.data.loginKeys.slice() : [];
  if (!existingLoginKeys.includes(LOGIN)) existingLoginKeys.push(LOGIN);
  if (!existingLoginKeys.includes(AUTH_EMAIL)) existingLoginKeys.push(AUTH_EMAIL);
  teacherMerge.loginKeys = existingLoginKeys;

  // Preserve other fields (do not delete)
  await db.collection('teachers').doc(chosen.id).set(teacherMerge, { merge: true });
  console.log('Updated teachers/' + chosen.id + ' with fields:', teacherMerge);

  // Update users/{authUid}
  const usersDocRef = db.collection('users').doc(AUTH_UID);
  const userMerge = Object.assign({}, {
    uid: AUTH_UID,
    authUid: AUTH_UID,
    accountType: accountType,
    role: userRole,
    appRole: appRole,
    permissionMode: chosen.data.permissionMode || 'custom',
    status: 'Active',
    username: LOGIN,
    phone: LOGIN,
    authEmail: AUTH_EMAIL,
    email: AUTH_EMAIL,
    loginKeys: existingLoginKeys
  });

  // Merge teacher-specific fields if available
  const toCopy = ['teacherId', 'name', 'subject', 'branch', 'permissions'];
  toCopy.forEach(k => {
    if (chosen.data[k] !== undefined) userMerge[k] = chosen.data[k];
  });

  await usersDocRef.set(userMerge, { merge: true });
  console.log('Updated users/' + AUTH_UID + ' with fields:', userMerge);

  console.log('Sync complete. Teacher doc updated:', chosen.id, 'Users doc updated:', AUTH_UID);
  process.exit(0);
}

main().catch(err => {
  console.error('Error during sync:', err);
  process.exit(1);
});
