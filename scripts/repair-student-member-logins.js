const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

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
  add(fields.email);
  add(fields.authEmail);
  add(fields.memberId);
  add(fields.studentId);
  return Array.from(keys);
}

function gradeCode(grade) {
  const map = { 'ม.6': '001', 'ม.5': '002', 'ม.4': '003', 'ม.3': '004', 'ม.2': '005', 'ม.1': '006', 'ป.6': '007', 'ป.5': '008', 'ป.4': '009' };
  return map[grade] || '000';
}

function padNumber(num, size) {
  return String(num).padStart(size, '0');
}

function buildStudentAuthEmail(memberId) {
  const cleanMemberId = String(memberId || '').trim().toLowerCase();
  return cleanMemberId ? cleanMemberId + '@ideaclub.local' : '';
}

function isNewMemberId(value) {
  return /^(001|002|003|004|005|006|007|008|009)\d{4}$/.test(String(value || '').trim());
}

async function getServiceAccount() {
  const keyPath = path.join(__dirname, '..', 'functions', 'service-account-drive.json');
  if (!fs.existsSync(keyPath)) {
    throw new Error('Service account not found: ' + keyPath);
  }
  return require(keyPath);
}

function buildNextMemberIdAllocator(studentDocs) {
  const maxByPrefix = {};
  studentDocs.forEach(doc => {
    const data = doc.data() || {};
    const memberId = String(data.memberId || data.studentId || '').trim();
    if (!isNewMemberId(memberId)) return;
    const prefix = memberId.slice(0, 3);
    const running = Number(memberId.slice(3)) || 0;
    maxByPrefix[prefix] = Math.max(maxByPrefix[prefix] || 0, running);
  });
  return grade => {
    const prefix = gradeCode(grade);
    const next = (maxByPrefix[prefix] || 0) + 1;
    maxByPrefix[prefix] = next;
    return prefix + padNumber(next, 4);
  };
}

async function getAuthUserByEmail(auth, email) {
  if (!email) return null;
  try {
    return await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code === 'auth/user-not-found') return null;
    throw error;
  }
}

async function getAuthUserByUid(auth, uid) {
  if (!uid) return null;
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (error.code === 'auth/user-not-found') return null;
    throw error;
  }
}

async function ensureStudentAuth(auth, student, targetEmail) {
  let authUid = String(student.authUid || '').trim();
  const existingTargetUser = await getAuthUserByEmail(auth, targetEmail);

  if (authUid) {
    const currentUser = await getAuthUserByUid(auth, authUid);
    if (!currentUser) {
      authUid = '';
    } else {
      if (existingTargetUser && existingTargetUser.uid !== authUid) {
        return { conflict: true, reason: 'target email belongs to another uid: ' + existingTargetUser.uid };
      }
      if (!DRY_RUN && currentUser.email !== targetEmail) {
        await auth.updateUser(authUid, { email: targetEmail, displayName: student.name || currentUser.displayName || '' });
      }
      return { authUid, updatedAuthEmail: currentUser.email !== targetEmail };
    }
  }

  if (existingTargetUser) {
    return { authUid: existingTargetUser.uid, linkedExistingAuth: true };
  }

  if (DRY_RUN) {
    return { authUid: 'DRY_RUN_NEW_AUTH_UID', createdAuth: true };
  }

  const created = await auth.createUser({
    email: targetEmail,
    password: '000000',
    displayName: student.name || ''
  });
  return { authUid: created.uid, createdAuth: true };
}

async function main() {
  console.log((DRY_RUN ? '[dry-run] ' : '') + 'Starting student Member ID login repair...');
  const serviceAccount = await getServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const auth = admin.auth();
  const db = admin.firestore();

  const studentSnapshot = await db.collection('students').get();
  const allocateMemberId = buildNextMemberIdAllocator(studentSnapshot.docs);
  const summary = {
    dryRun: DRY_RUN,
    scanned: 0,
    repaired: 0,
    authEmailUpdated: 0,
    authCreated: 0,
    authLinked: 0,
    assignedMemberId: 0,
    conflicts: [],
    failed: []
  };

  for (const doc of studentSnapshot.docs) {
    const data = doc.data() || {};
    if (data.deleted === true) continue;
    summary.scanned += 1;

    const currentMemberId = String(data.memberId || data.studentId || '').trim();
    const memberId = currentMemberId || allocateMemberId(data.grade || '');
    const targetEmail = buildStudentAuthEmail(memberId);
    if (!targetEmail) {
      summary.failed.push({ id: doc.id, name: data.name || '', reason: 'missing memberId and cannot build auth email' });
      continue;
    }

    try {
      const authResult = await ensureStudentAuth(auth, data, targetEmail);
      if (authResult.conflict) {
        summary.conflicts.push({ id: doc.id, memberId, name: data.name || '', reason: authResult.reason });
        continue;
      }

      const authUid = authResult.authUid;
      const loginKeys = buildLoginKeys({ memberId, studentId: memberId, email: targetEmail, authEmail: targetEmail });
      const studentPayload = {
        authUid,
        authEmail: targetEmail,
        email: targetEmail,
        memberId,
        studentId: memberId,
        loginId: memberId,
        loginKeys,
        role: 'student',
        appRole: 'student',
        accountType: 'student',
        permissionMode: 'student',
        permissions: [],
        updatedAtText: new Date().toLocaleString('th-TH')
      };
      const usersPayload = Object.assign({}, studentPayload, {
        uid: authUid,
        linkedStudentId: doc.id,
        name: data.name || '',
        nickname: data.nickname || '',
        parentName: data.parentName || '',
        phone: data.phone || '',
        lineId: data.lineId || '',
        contactEmail: data.contactEmail || '',
        grade: data.grade || '',
        school: data.school || '',
        preferredLocation: data.preferredLocation || '',
        status: data.status || 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (!DRY_RUN) {
        await db.collection('students').doc(doc.id).set(studentPayload, { merge: true });
        await db.collection('users').doc(authUid).set(usersPayload, { merge: true });
      }

      if (!currentMemberId) summary.assignedMemberId += 1;
      if (authResult.createdAuth) summary.authCreated += 1;
      if (authResult.linkedExistingAuth) summary.authLinked += 1;
      if (authResult.updatedAuthEmail) summary.authEmailUpdated += 1;
      summary.repaired += 1;
      console.log((DRY_RUN ? '[dry-run] ' : '') + 'student repaired:', doc.id, data.name || '-', memberId, targetEmail);
    } catch (error) {
      summary.failed.push({ id: doc.id, memberId, name: data.name || '', reason: String(error.message || error.code || error) });
      console.error('student repair failed:', doc.id, data.name || '-', error);
    }
  }

  console.log('Repair student member login summary');
  console.log(JSON.stringify(summary, null, 2));
  if (summary.conflicts.length || summary.failed.length) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('Repair run failed:', error);
  process.exit(1);
});
