const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  buildEnrollmentCompletionPatch,
  hasCourseCompletionHistory,
  isCourseEndDue,
  isCurrentApprovedEnrollment,
} = require('../functions/course-end-helpers');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('scheduled course becomes due only when enabled and its time has passed', () => {
  const now = Date.parse('2026-10-01T10:00:00+07:00');
  assert.equal(isCourseEndDue({ courseEndEnabled: true, courseEndStatus: 'scheduled', courseEndAt: { toMillis: () => now - 1 } }, now), true);
  assert.equal(isCourseEndDue({ courseEndEnabled: true, courseEndStatus: 'scheduled', courseEndAt: { toMillis: () => now + 1 } }, now), false);
  assert.equal(isCourseEndDue({ courseEndEnabled: false, courseEndAt: { toMillis: () => now - 1 } }, now), false);
  assert.equal(isCourseEndDue({ courseEndEnabled: true, courseEndStatus: 'completed', courseEndAt: { toMillis: () => now - 1 } }, now), false);
});

test('only active approved enrollment is a completion target', () => {
  assert.equal(isCurrentApprovedEnrollment({ courseStatus: 'อนุมัติแล้ว', enrollmentStatus: 'active' }), true);
  assert.equal(isCurrentApprovedEnrollment({ courseStatus: 'รออนุมัติคอร์ส', enrollmentStatus: 'active' }), false);
  assert.equal(isCurrentApprovedEnrollment({ courseStatus: 'อนุมัติแล้ว', enrollmentStatus: 'completed' }), false);
  assert.equal(isCurrentApprovedEnrollment({ courseStatus: 'อนุมัติแล้ว', deleted: true }), false);
});

test('completion preserves historical media access for an approved enrollment', () => {
  const patch = buildEnrollmentCompletionPatch(
    { courseStatus: 'อนุมัติแล้ว', everApproved: false },
    12345,
    '1/10/2569 10:00:00',
    'ตุลาคม 2569'
  );
  assert.equal(patch.courseStatus, 'จบคอร์ส');
  assert.equal(patch.enrollmentStatus, 'completed');
  assert.equal(patch.everApproved, true);
  assert.equal(patch.historicalMediaStatus, 'allowed');
  assert.equal(patch.completedAtMs, 12345);
});

test('legacy completion history check prevents duplicate course records', () => {
  const history = [{ courseId: 'course-a' }];
  assert.equal(hasCourseCompletionHistory(history, 'course-a'), true);
  assert.equal(hasCourseCompletionHistory(history, 'course-b'), false);
});

test('manual completion closes an empty course without writing student records', async () => {
  const course = { id: 'empty-course', name: 'Empty course', grade: 'ม.1', status: 'open' };
  const writes = [];
  const alerts = [];
  let confirmation = '';
  const context = {
    courses: [course],
    hasPermission(permission) { return permission === 'admin.courses'; },
    getCourseCompletionTargets() { return []; },
    confirm(message) { confirmation = message; return true; },
    alert(message) { alerts.push(message); },
    getThaiMonthFromDate() { return 'ตุลาคม 2569'; },
    getElement() { return null; },
    async setFirebaseDocument(collection, value) { writes.push({ collection, value: { ...value } }); },
    async addActivityLog(action, detail) { writes.push({ collection: 'activityLogs', action, detail }); },
    renderAdminCourses() {}, renderAdminStudents() {}, renderAdminDashboard() {},
    renderAdminStudentCourseOptions() {}, renderStudentCourses() {}, updateStudentCourseDisplay() {},
    console
  };
  vm.createContext(context);
  const start = html.indexOf('    async function completeCourseForStudents(');
  const end = html.indexOf('    function onlineClassHasAccess(', start);
  assert.ok(start >= 0 && end > start, 'missing completeCourseForStudents source');
  vm.runInContext(html.slice(start, end), context);

  const result = await context.completeCourseForStudents('empty-course');
  assert.equal(result, true);
  assert.match(confirmation, /ยังไม่มีนักเรียน/);
  assert.equal(course.status, 'closed');
  assert.equal(course.courseEndStatus, 'completed_manually');
  assert.equal(course.courseClosureReason, 'no_students');
  assert.equal(writes.filter(write => write.collection === 'students').length, 0);
  assert.equal(writes.filter(write => write.collection === 'courseEnrollments').length, 0);
  assert.equal(writes.filter(write => write.collection === 'courses').length, 1);
  assert.equal(writes.find(write => write.collection === 'activityLogs').action, 'ปิดคอร์สไม่มีนักเรียน');
  assert.deepEqual(alerts, ['ปิดคอร์สเรียบร้อย']);
});

test('empty active course renders an enabled close-course action', () => {
  const start = html.indexOf('    function renderAdminCourseTableRow(');
  const end = html.indexOf('    function renderAdminCourses(', start);
  const source = html.slice(start, end);
  assert.match(source, /completeActionLabel = completionTargets\.length \? 'จบคอร์ส' : 'ปิดคอร์ส'/);
  assert.doesNotMatch(source, /completeDisabled/);
});
