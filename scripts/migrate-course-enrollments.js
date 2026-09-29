#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const rootDir = path.resolve(__dirname, '..');
const write = process.argv.includes('--write');
const keyCandidates = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  path.join(rootDir, 'functions', 'service-account-drive.json'),
  path.join(rootDir, 'service-account-drive.json')
].filter(Boolean);
const keyPath = keyCandidates.find((candidate) => fs.existsSync(candidate));

if (keyPath) {
  admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
} else {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

const db = admin.firestore();
db.settings({ preferRest: true });

function enrollmentId(studentId, courseId) {
  return String(studentId) + '__' + String(courseId);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function resolveLegacyCourseId(item, student, courses) {
  const explicit = String(item && (item.courseId || item.id) || '').trim();
  if (explicit) return explicit;
  const name = normalize(item && (item.course || item.courseName) || '');
  if (!name) return '';
  const grade = normalize(item && item.grade || student.grade || '');
  const location = normalize(item && item.location || student.preferredLocation || '');
  const matches = Array.from(courses.values()).filter((course) => {
    if (normalize(course.name || course.title) !== name) return false;
    if (grade && normalize(course.grade) !== grade) return false;
    if (location && normalize(course.location) !== location) return false;
    return true;
  });
  return matches.length === 1 ? String(matches[0].id || '') : '';
}

function courseSnapshot(course, fallback) {
  const source = course || {};
  const old = fallback || {};
  return {
    courseName: source.name || source.title || old.course || old.courseName || '',
    courseAccess: source.access || old.courseAccess || '',
    grade: old.grade || source.grade || '',
    location: old.location || old.preferredLocation || source.location || ''
  };
}

function buildEnrollment(studentId, student, courseId, course, source, status) {
  const snap = courseSnapshot(course, Object.assign({}, student, source || {}));
  const id = enrollmentId(studentId, courseId);
  const originalStatus = String(source && (source.courseStatus || source.completedCourseStatus) || status || '');
  const everApproved = source && source.everApproved === true
    || originalStatus === 'อนุมัติแล้ว'
    || (status === 'จบคอร์ส' && source && source.enrollmentStatus === 'completed');
  const historicalMediaStatus = status === 'จบคอร์ส'
    ? (source && (source.historicalMediaStatus === 'revoked' || source._promotionRevoked) ? 'revoked' : everApproved ? 'allowed' : 'not_eligible')
    : 'not_applicable';
  const parsedCompletedAt = Date.parse(source && source.completedAtText || '');
  return {
    id,
    firebaseDocId: id,
    studentId,
    authUid: student.authUid || student.studentAuthUid || '',
    memberId: student.memberId || student.studentId || '',
    studentName: student.name || '',
    courseId,
    courseName: snap.courseName,
    courseAccess: snap.courseAccess,
    grade: snap.grade,
    location: snap.location,
    courseStatus: status,
    paymentStatus: (source && source.paymentStatus) || student.paymentStatus || (status === 'จบคอร์ส' ? 'ชำระแล้ว' : 'รอชำระเงิน'),
    registeredCourseMonth: (source && (source.registeredCourseMonth || source.completedAtMonth)) || student.registeredCourseMonth || '',
    enrollmentStatus: status === 'จบคอร์ส' ? 'completed' : status === 'ยกเลิก' ? 'cancelled' : 'active',
    everApproved,
    approvedAtMs: Number(source && source.approvedAtMs || 0),
    historicalMediaStatus,
    completedAtText: source && source.completedAtText || '',
    completedAtMonth: source && source.completedAtMonth || '',
    completedAtMs: Number(source && source.completedAtMs || (Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : 0)),
    completedBy: source && source.completedBy || '',
    historicalMediaRevokedAt: historicalMediaStatus === 'revoked' ? source && source.historicalMediaRevokedAt || '' : '',
    historicalMediaRevokedAtMs: historicalMediaStatus === 'revoked' ? Number(source && source.historicalMediaRevokedAtMs || 0) : 0,
    historicalMediaRevokedReason: historicalMediaStatus === 'revoked' ? 'grade_promotion' : '',
    deleted: false,
    migratedFromLegacy: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

async function main() {
  console.log(write ? 'Preparing course enrollment migration...' : 'Preparing course enrollment migration dry-run...');
  const [studentSnap, courseSnap, enrollmentSnap] = await Promise.all([
    db.collection('students').get(),
    db.collection('courses').get(),
    db.collection('courseEnrollments').get()
  ]);
  const courses = new Map(courseSnap.docs.map((doc) => [doc.id, Object.assign({ id: doc.id }, doc.data())]));
  const existing = new Map(enrollmentSnap.docs.map((doc) => [doc.id, doc.data() || {}]));
  const planned = new Map();
  const unresolvedHistory = [];

  studentSnap.docs.forEach((doc) => {
    const student = doc.data() || {};
    if (student.deleted === true) return;
    const history = Array.isArray(student.courseCompletionHistory) ? student.courseCompletionHistory.slice() : [];
    if ((student.completedCourseId || student.completedCourse) && !history.some((item) => {
      return String(item && item.courseId || '') === String(student.completedCourseId || '')
        && normalize(item && (item.course || item.courseName)) === normalize(student.completedCourse || '');
    })) {
      history.push({
        courseId: student.completedCourseId || '',
        course: student.completedCourse || '',
        courseAccess: student.completedCourseAccess || '',
        courseStatus: student.completedCourseStatus || '',
        paymentStatus: student.completedCoursePaymentStatus || '',
        grade: student.completedCourseGrade || student.grade || '',
        location: student.preferredLocation || '',
        completedAtText: student.completedAtText || '',
        completedAtMonth: student.completedAtMonth || ''
      });
    }
    const promotions = Array.isArray(student.gradePromotionHistory) ? student.gradePromotionHistory : [];
    history.forEach((item) => {
      const courseId = resolveLegacyCourseId(item, student, courses);
      if (!courseId) {
        unresolvedHistory.push({ studentId: doc.id, course: item && (item.course || item.courseName) || '', grade: item && item.grade || '' });
        return;
      }
      const id = enrollmentId(doc.id, courseId);
      const promotionRevoked = promotions.some((promotion) => {
        const revokedIds = Array.isArray(promotion && promotion.revokedHistoricalCourseIds) ? promotion.revokedHistoricalCourseIds.map(String) : [];
        if (revokedIds.includes(courseId)) return true;
        return String(promotion && promotion.previousGrade || '') === String(item && item.grade || '')
          && (String(student.grade || '') !== String(item && item.grade || '') || promotion.promotedToGrade === 'จบการศึกษา');
      });
      planned.set(id, buildEnrollment(doc.id, student, courseId, courses.get(courseId), Object.assign({}, item, { _promotionRevoked: promotionRevoked }), 'จบคอร์ส'));
    });
    const currentCourseId = String(student.courseId || '').trim();
    if (currentCourseId && String(student.course || '') !== 'ยังไม่ได้สมัครคอร์ส') {
      const status = student.courseStatus || 'รออนุมัติคอร์ส';
      const id = enrollmentId(doc.id, currentCourseId);
      planned.set(id, buildEnrollment(doc.id, student, currentCourseId, courses.get(currentCourseId), student, status));
    }
  });

  enrollmentSnap.docs.forEach((doc) => {
    if (planned.has(doc.id)) return;
    const old = doc.data() || {};
    const isCompleted = String(old.courseStatus || '') === 'จบคอร์ส';
    const everApproved = old.everApproved === true
      || old.courseStatus === 'อนุมัติแล้ว'
      || old.courseStatusBeforeCompletion === 'อนุมัติแล้ว'
      || (isCompleted && old.enrollmentStatus === 'completed');
    const completedAtParsed = Date.parse(old.completedAtText || '');
    planned.set(doc.id, Object.assign({}, old, {
      everApproved,
      approvedAtMs: Number(old.approvedAtMs || 0),
      historicalMediaStatus: isCompleted
        ? (old.historicalMediaStatus === 'revoked' ? 'revoked' : everApproved ? 'allowed' : 'not_eligible')
        : 'not_applicable',
      completedAtMs: Number(old.completedAtMs || (Number.isFinite(completedAtParsed) ? completedAtParsed : 0)),
      historicalMediaRevokedAt: old.historicalMediaRevokedAt || '',
      historicalMediaRevokedAtMs: Number(old.historicalMediaRevokedAtMs || 0),
      historicalMediaRevokedReason: old.historicalMediaStatus === 'revoked' ? old.historicalMediaRevokedReason || 'grade_promotion' : ''
    }));
  });

  const creates = Array.from(planned.entries()).filter(([id]) => !existing.has(id));
  const managedFields = ['everApproved', 'approvedAtMs', 'historicalMediaStatus', 'completedAtMs', 'historicalMediaRevokedAt', 'historicalMediaRevokedAtMs', 'historicalMediaRevokedReason'];
  const updates = Array.from(planned.entries()).filter(([id, data]) => {
    if (!existing.has(id)) return false;
    const old = existing.get(id);
    return managedFields.some((field) => old[field] !== data[field]);
  });
  console.log(JSON.stringify({
    mode: write ? 'write' : 'dry-run',
    students: studentSnap.size,
    existingEnrollments: existing.size,
    planned: planned.size,
    creates: creates.length,
    updates: updates.length,
    unresolvedHistory: unresolvedHistory.length,
    unresolvedHistorySamples: unresolvedHistory.slice(0, 20)
  }, null, 2));
  if (!write || (!creates.length && !updates.length)) return;

  const writes = creates.map(([id, data]) => ({ id, data, create: true }))
    .concat(updates.map(([id, data]) => ({ id, data, create: false })));
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    writes.slice(offset, offset + 400).forEach(({ id, data, create }) => {
      const ref = db.collection('courseEnrollments').doc(id);
      if (create) {
        batch.create(ref, Object.assign({}, data, { createdAt: admin.firestore.FieldValue.serverTimestamp() }));
      } else {
        const patch = {};
        managedFields.forEach((field) => { patch[field] = data[field]; });
        patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        batch.set(ref, patch, { merge: true });
      }
    });
    await batch.commit();
  }
  console.log('Migration complete:', creates.length, 'created,', updates.length, 'updated.');
}

main()
  .catch((error) => {
    console.error('Migration failed:', error && (error.stack || error.message) || error);
    process.exitCode = 1;
  })
  .finally(() => admin.app().delete());
