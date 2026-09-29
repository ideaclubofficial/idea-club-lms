const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('    function getCourseEnrollmentDocId(');
const end = html.indexOf('    function studentCanReceiveIdCard(', start);
const promotionStart = html.indexOf('    function getPromotionHistoricalMediaEnrollments(');
const promotionEnd = html.indexOf('    async function confirmGradePromotionRound(', promotionStart);
const source = html.slice(start, end) + '\n' + html.slice(promotionStart, promotionEnd);

function createContext() {
  const context = {
    courseEnrollments: [],
    courses: [],
    currentStudent: null,
    currentStudentCourseId: null,
    firebaseUser: null,
    localStorage: { getItem() { return ''; }, setItem() {} },
    isCourseStatusApproved(status) { return status === 'อนุมัติแล้ว'; },
    courseFeatureEnabled() { return true; },
    escapeHtml(value) { return String(value || ''); },
    getElement() { return null; },
    updateStudentCourseDisplay() {},
    safeRun(fn) { if (typeof fn === 'function') fn(); },
    renderStudentMonthlyPlan() {},
    renderStudentMobileLearning() {},
    renderStudentReceipts() {},
    renderStudentCourses() {}
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test('legacy single course remains visible until migration', () => {
  const context = createContext();
  const student = { id: 'student-1', authUid: 'uid-1', courseId: 'course-a', course: 'A', courseStatus: 'อนุมัติแล้ว' };
  const list = context.getStudentCourseEnrollments(student);
  assert.equal(list.length, 1);
  assert.equal(list[0].legacy, true);
  assert.equal(list[0].courseId, 'course-a');
});

test('new enrollment replaces duplicate legacy projection and keeps additional courses', () => {
  const context = createContext();
  const student = { id: 'student-1', authUid: 'uid-1', courseId: 'course-a', course: 'A', courseStatus: 'อนุมัติแล้ว' };
  context.courseEnrollments.push(
    { id: 'student-1__course-a', studentId: 'student-1', authUid: 'uid-1', courseId: 'course-a', courseStatus: 'อนุมัติแล้ว' },
    { id: 'student-1__course-b', studentId: 'student-1', authUid: 'uid-1', courseId: 'course-b', courseStatus: 'รออนุมัติคอร์ส' }
  );
  const list = context.getStudentCourseEnrollments(student);
  assert.deepEqual(Array.from(list, item => item.courseId).sort(), ['course-a', 'course-b']);
  assert.equal(list.some(item => item.legacy), false);
});

test('selected course context is independent and deterministic', () => {
  const context = createContext();
  const student = { id: 'student-1', authUid: 'uid-1' };
  context.currentStudent = student;
  context.courseEnrollments.push(
    { studentId: 'student-1', authUid: 'uid-1', courseId: 'course-a', courseStatus: 'อนุมัติแล้ว' },
    { studentId: 'student-1', authUid: 'uid-1', courseId: 'course-b', courseStatus: 'รออนุมัติคอร์ส' }
  );
  context.currentStudentCourseId = 'course-b';
  assert.equal(context.getSelectedStudentCourseEnrollment(student).courseId, 'course-b');
  assert.equal(context.getCourseEnrollmentDocId('student-1', 'course-b'), 'student-1__course-b');
});

test('completed and cancelled enrollments are not current', () => {
  const context = createContext();
  assert.equal(context.isCourseEnrollmentCurrent({ courseStatus: 'จบคอร์ส' }), false);
  assert.equal(context.isCourseEnrollmentCurrent({ courseStatus: 'ยกเลิก' }), false);
  assert.equal(context.isCourseEnrollmentCurrent({ courseStatus: 'รออนุมัติคอร์ส' }), true);
});

test('approved completed enrollment keeps media access until revoked', () => {
  const context = createContext();
  const student = { id: 'student-1', authUid: 'uid-1', learningStatus: 'เรียนอยู่' };
  context.currentStudent = student;
  context.courses.push({ id: 'course-old', name: 'Old', access: 'Online / On-demand', grade: 'ม.1' });
  context.courseEnrollments.push({
    studentId: 'student-1', authUid: 'uid-1', courseId: 'course-old', courseStatus: 'จบคอร์ส',
    enrollmentStatus: 'completed', everApproved: true, historicalMediaStatus: 'allowed'
  });
  assert.deepEqual(Array.from(context.getStudentMediaEntitledCourses(student), item => item.id), ['course-old']);
  context.courseEnrollments[0].historicalMediaStatus = 'revoked';
  assert.deepEqual(Array.from(context.getStudentMediaEntitledCourses(student), item => item.id), []);
});

test('pending, cancelled, and unapproved completed enrollments do not grant historical media', () => {
  const context = createContext();
  const student = { id: 'student-1', authUid: 'uid-1', learningStatus: 'เรียนอยู่' };
  context.currentStudent = student;
  context.courses.push({ id: 'pending', access: 'Online' }, { id: 'cancelled', access: 'Online' }, { id: 'completed', access: 'Online' });
  context.courseEnrollments.push(
    { studentId: 'student-1', authUid: 'uid-1', courseId: 'pending', courseStatus: 'รออนุมัติคอร์ส' },
    { studentId: 'student-1', authUid: 'uid-1', courseId: 'cancelled', courseStatus: 'ยกเลิก', everApproved: true },
    { studentId: 'student-1', authUid: 'uid-1', courseId: 'completed', courseStatus: 'จบคอร์ส', everApproved: false, historicalMediaStatus: 'not_eligible' }
  );
  assert.deepEqual(Array.from(context.getStudentMediaEntitledCourses(student), item => item.id), []);
});

test('legacy approved history is denied after promotion revokes its course id', () => {
  const context = createContext();
  const student = {
    id: 'student-1', authUid: 'uid-1', learningStatus: 'เรียนอยู่', grade: 'ม.2',
    courseCompletionHistory: [{ courseId: 'course-old', course: 'Old', courseStatus: 'อนุมัติแล้ว', grade: 'ม.1' }],
    gradePromotionHistory: [{ previousGrade: 'ม.1', promotedToGrade: 'ม.2', revokedHistoricalCourseIds: ['course-old'] }]
  };
  context.currentStudent = student;
  context.courses.push({ id: 'course-old', name: 'Old', access: 'Online / On-demand', grade: 'ม.1' });
  assert.deepEqual(Array.from(context.getStudentMediaEntitledCourses(student), item => item.id), []);
});

test('promotion targets only eligible completed media from the source grade', () => {
  const context = createContext();
  const student = { id: 'student-1', authUid: 'uid-1', learningStatus: 'เรียนอยู่' };
  context.courseEnrollments.push(
    { studentId: 'student-1', courseId: 'm1-allowed', courseStatus: 'จบคอร์ส', courseStatusBeforeCompletion: 'อนุมัติแล้ว', grade: 'ม.1', historicalMediaStatus: 'allowed' },
    { studentId: 'student-1', courseId: 'm1-revoked', courseStatus: 'จบคอร์ส', everApproved: true, grade: 'ม.1', historicalMediaStatus: 'revoked' },
    { studentId: 'student-1', courseId: 'm2-allowed', courseStatus: 'จบคอร์ส', everApproved: true, grade: 'ม.2', historicalMediaStatus: 'allowed' }
  );
  assert.deepEqual(
    Array.from(context.getPromotionHistoricalMediaEnrollments(student, 'ม.1'), item => item.courseId),
    ['m1-allowed']
  );
});
