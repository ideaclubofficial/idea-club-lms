#!/usr/bin/env node

const admin = require('firebase-admin');
const fs = require('fs');
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
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const args = process.argv.slice(2);
const write = args.includes('--write');
const verbose = args.includes('--verbose');

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
  const snapshot = await db.collection('students').get();
  const reports = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const fixes = buildStudentFixes(data);
    if (Object.keys(fixes).length) {
      reports.push({ id: doc.id, path: `students/${doc.id}`, data, fixes });
    }
  }
  return reports;
}

async function scanUsers() {
  const studentSnapshot = await db.collection('students').get();
  const studentPhones = new Set(studentSnapshot.docs.map(function(doc) {
    return String(doc.data().phone || '').replace(/[^0-9]/g, '');
  }).filter(function(phone) { return phone; }));

  const snapshot = await db.collection('users').get();
  const reports = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
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
    const ref = db.collection(collectionName).doc(item.id);
    const updates = Object.assign({}, item.fixes);
    const hasAppRoleDelete = Object.prototype.hasOwnProperty.call(updates, 'appRole') && updates.appRole === admin.firestore.FieldValue.delete();
    if (hasAppRoleDelete) {
      delete updates.appRole;
    }

    if (Object.keys(updates).length) {
      await ref.update(updates);
    }
    if (hasAppRoleDelete) {
      await ref.update({ appRole: admin.firestore.FieldValue.delete() });
    }

    if (verbose) {
      console.log(`UPDATED ${collectionName}/${item.id}`, item.fixes);
    }
  }
}

(async function main() {
  console.log('==== repair-student-roles.js ====');
  console.log(`mode: ${write ? 'WRITE' : 'DRY-RUN'}`);

  const studentSnapshot = await db.collection('students').get();
  const studentCount = studentSnapshot.size;
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
