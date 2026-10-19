const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const firestoreRules = fs.readFileSync(path.join(__dirname, '../firestore.rules'), 'utf8');
const start = html.indexOf('    function getCourseEnrollmentDocId(');
const end = html.indexOf('    function studentCanReceiveIdCard(', start);
const promotionStart = html.indexOf('    function getPromotionHistoricalMediaEnrollments(');
const promotionEnd = html.indexOf('    async function confirmGradePromotionRound(', promotionStart);
const bulkEligibilityStart = html.indexOf('    function getAdminBulkEligibleStudents(');
const bulkEligibilityEnd = html.indexOf('    function renderAdminBulkEnrollmentControls(', bulkEligibilityStart);
const courseLocationsStart = html.indexOf('    function getCourseLocations(');
const courseLocationsEnd = html.indexOf('    function subjectOptionsHtml(', courseLocationsStart);
const concurrencyStart = html.indexOf('    async function runAdminEnrollmentTasksWithConcurrency(');
const concurrencyEnd = html.indexOf('    async function adminBulkEnrollStudents(', concurrencyStart);
const source = html.slice(start, end) + '\n' + html.slice(promotionStart, promotionEnd) + '\n' +
  html.slice(courseLocationsStart, courseLocationsEnd) + '\n' + html.slice(bulkEligibilityStart, bulkEligibilityEnd) + '\n' + html.slice(concurrencyStart, concurrencyEnd);

function createContext() {
  const context = {
    courseEnrollments: [],
    courses: [],
    students: [],
    currentStudent: null,
    currentStudentCourseId: null,
    firebaseUser: null,
    localStorage: { getItem() { return ''; }, setItem() {} },
    isCourseStatusApproved(status) { return status === 'อนุมัติแล้ว'; },
    getThaiMonthFromDate() { return 'ตุลาคม 2569'; },
    courseFeatureEnabled() { return true; },
    escapeHtml(value) { return String(value || ''); },
    getElement() { return null; },
    updateStudentCourseDisplay() {},
    safeRun(fn) { if (typeof fn === 'function') fn(); },
    renderStudentMonthlyPlan() {},
    renderStudentMobileLearning() {},
    renderStudentReceipts() {},
    renderStudentCourses() {},
    setTimeout
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
  assert.equal(context.isCourseEnrollmentCurrent({ courseStatus: 'ไม่อนุมัติ' }), false);
  assert.equal(context.isCourseEnrollmentCurrent({ courseStatus: 'ยังไม่ได้สมัครคอร์ส' }), false);
  assert.equal(context.isCourseEnrollmentCurrent({ courseStatus: 'รออนุมัติคอร์ส' }), true);
});

test('completed or archived courses are never open for a new enrollment', () => {
  const context = createContext();
  assert.equal(context.isCourseOpenForEnrollment({ status: 'open' }), true);
  assert.equal(context.isCourseOpenForEnrollment({ status: 'open', courseEndStatus: 'completed' }), false);
  assert.equal(context.isCourseOpenForEnrollment({ status: 'open', courseEndStatus: 'completed_manually' }), false);
  assert.equal(context.isCourseOpenForEnrollment({ status: 'open', courseEndedAtMs: 100 }), false);
  assert.equal(context.isCourseOpenForEnrollment({ status: 'open', archived: true }), false);
  assert.equal(context.isCourseOpenForEnrollment({ status: 'closed' }), false);
});

test('admin course choices allow cancelled enrollment again but still block completed history', () => {
  const context = createContext();
  const student = { id: 'student-1', authUid: 'uid-1', grade: 'ม.1', preferredLocation: 'ศูนย์ A' };
  context.courses.push(
    { id: 'available', name: 'Available', grade: 'ม.1', location: 'ศูนย์ A', status: 'open' },
    { id: 'closed', name: 'Closed', grade: 'ม.1', location: 'ศูนย์ A', status: 'closed' },
    { id: 'wrong-grade', name: 'Wrong grade', grade: 'ม.2', location: 'ศูนย์ A', status: 'open' },
    { id: 'wrong-center', name: 'Wrong center', grade: 'ม.1', location: 'ศูนย์ B', status: 'open' },
    { id: 'history', name: 'History', grade: 'ม.1', location: 'ศูนย์ A', status: 'open' },
    { id: 'cancelled', name: 'Cancelled', grade: 'ม.1', location: 'ศูนย์ A', status: 'open' }
  );
  context.courseEnrollments.push(
    { studentId: 'student-1', authUid: 'uid-1', courseId: 'history', courseStatus: 'จบคอร์ส' },
    { studentId: 'student-1', authUid: 'uid-1', courseId: 'cancelled', courseStatus: 'ยกเลิก', enrollmentStatus: 'cancelled' }
  );
  assert.deepEqual(Array.from(context.getAdminAvailableCoursesForStudent(student), item => item.id), ['available', 'cancelled']);
});

test('course can accept enrollment from both configured centers while legacy single-center courses still work', () => {
  const context = createContext();
  const dualCenterCourse = {
    id: 'dual', grade: 'ม.1', status: 'open', location: 'ศูนย์ A', locations: ['ศูนย์ A', 'ศูนย์ B']
  };
  const legacyCourse = { id: 'legacy', grade: 'ม.1', status: 'open', location: 'ศูนย์ A' };
  assert.equal(context.courseMatchesLocation(dualCenterCourse, 'ศูนย์ A'), true);
  assert.equal(context.courseMatchesLocation(dualCenterCourse, 'ศูนย์ B'), true);
  assert.equal(context.courseMatchesLocation(dualCenterCourse, 'ศูนย์ C'), false);
  assert.equal(context.courseMatchesLocation(legacyCourse, 'ศูนย์ A'), true);
  assert.equal(context.courseMatchesLocation(legacyCourse, 'ศูนย์ B'), false);

  context.courses.push(dualCenterCourse, legacyCourse);
  const centerBStudent = { id: 'student-b', grade: 'ม.1', preferredLocation: 'ศูนย์ B' };
  assert.deepEqual(Array.from(context.getAdminAvailableCoursesForStudent(centerBStudent), item => item.id), ['dual']);
  context.students.push(centerBStudent);
  assert.deepEqual(Array.from(context.getAdminBulkEligibleStudents(dualCenterCourse), item => item.id), ['student-b']);
});

test('course admin exposes two-center controls and rules accept locations array', () => {
  assert.match(html, /id="adminCourseLocationNakhonSawan"/);
  assert.match(html, /id="adminCourseLocationNongChang"/);
  assert.match(html, /locations: locations/);
  assert.match(firestoreRules, /studentLocation in courseData\.locations/);
  assert.match(firestoreRules, /courseAcceptsStudentLocation\(request\.resource\.data\.courseId, request\.resource\.data\.studentId\)/);
});

test('admin enrollment builder creates independent pending payment state and approval evidence', () => {
  const context = createContext();
  const student = {
    id: 'student-1', authUid: 'uid-1', memberId: 'IC001', name: 'Student',
    grade: 'ม.1', preferredLocation: 'ศูนย์ A', paymentStatus: 'ชำระแล้ว'
  };
  const course = { id: 'course-new', name: 'New course', grade: 'ม.1', location: 'ศูนย์ A', access: 'Online' };
  const approved = context.buildAdminCourseEnrollment(student, course, 'อนุมัติแล้ว', { nowMs: 1000 });
  const pending = context.buildAdminCourseEnrollment(student, course, 'รออนุมัติคอร์ส', { nowMs: 2000 });
  assert.equal(approved.firebaseDocId, 'student-1__course-new');
  assert.equal(approved.paymentStatus, 'รอชำระเงิน');
  assert.equal(approved.everApproved, true);
  assert.equal(approved.approvedAtMs, 1000);
  assert.equal(pending.paymentStatus, 'รอชำระเงิน');
  assert.equal(pending.everApproved, false);
  assert.equal(pending.approvedAtMs, 0);
});

test('latest enrollment projection keeps legacy student course fields in sync', () => {
  const context = createContext();
  const course = { id: 'course-new', name: 'New course', access: 'Online' };
  const enrollment = {
    courseId: 'course-new', courseName: 'New course', courseAccess: 'Online',
    courseStatus: 'รออนุมัติคอร์ส', paymentStatus: 'รอชำระเงิน',
    registeredCourseMonth: 'ตุลาคม 2569'
  };
  assert.deepEqual(JSON.parse(JSON.stringify(context.buildStudentMainCourseFields(enrollment, course))), {
    courseId: 'course-new', course: 'New course', courseAccess: 'Online',
    courseStatus: 'รออนุมัติคอร์ส', paymentStatus: 'รอชำระเงิน',
    registeredCourseMonth: 'ตุลาคม 2569'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.buildStudentMainCourseFields(null, null))), {
    courseId: null, course: 'ยังไม่ได้สมัครคอร์ส', courseAccess: '-',
    courseStatus: 'ยังไม่ได้สมัครคอร์ส', paymentStatus: 'ยังไม่ได้สมัครคอร์ส',
    registeredCourseMonth: ''
  });
});

test('latest current enrollment fallback ignores ended courses and uses newest timestamp', () => {
  const context = createContext();
  const student = { id: 'student-1', authUid: 'uid-1' };
  context.courseEnrollments.push(
    { id: 'old', studentId: 'student-1', courseId: 'old', courseStatus: 'อนุมัติแล้ว', createdAtMs: 100 },
    { id: 'new', studentId: 'student-1', courseId: 'new', courseStatus: 'รออนุมัติคอร์ส', createdAtMs: 300 },
    { id: 'ended', studentId: 'student-1', courseId: 'ended', courseStatus: 'จบคอร์ส', createdAtMs: 500 }
  );
  assert.equal(context.getLatestCurrentStudentEnrollment(student).courseId, 'new');
  assert.equal(context.getLatestCurrentStudentEnrollment(student, 'new').courseId, 'old');
});

test('bulk enrollment candidates include cancelled enrollment for reactivation', () => {
  const context = createContext();
  const course = { id: 'course-a', grade: 'ม.1', location: 'ศูนย์ A', status: 'open' };
  context.students.push(
    { id: 'eligible', name: 'Eligible', grade: 'ม.1', preferredLocation: 'ศูนย์ A' },
    { id: 'wrong-grade', name: 'Wrong grade', grade: 'ม.2', preferredLocation: 'ศูนย์ A' },
    { id: 'wrong-center', name: 'Wrong center', grade: 'ม.1', preferredLocation: 'ศูนย์ B' },
    { id: 'history', name: 'History', grade: 'ม.1', preferredLocation: 'ศูนย์ A' }
  );
  context.courseEnrollments.push({ studentId: 'history', courseId: 'course-a', courseStatus: 'ยกเลิก' });
  assert.deepEqual(Array.from(context.getAdminBulkEligibleStudents(course), student => student.id), ['eligible', 'history']);
  course.status = 'closed';
  assert.equal(context.getAdminBulkEligibleStudents(course).length, 0);
});

test('bulk enrollment runner limits concurrency and preserves per-student failures', async () => {
  const context = createContext();
  let active = 0;
  let maxActive = 0;
  const results = await context.runAdminEnrollmentTasksWithConcurrency(['a', 'b', 'c', 'd'], 2, async item => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (item === 'c') throw new Error('failed-c');
    return item.toUpperCase();
  });
  assert.equal(maxActive, 2);
  assert.deepEqual(Array.from(results, result => result.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[0].value, 'A');
  assert.equal(results[2].reason.message, 'failed-c');
});

test('course admin markup exposes three separate subtabs and panels', () => {
  const ids = [
    'adminCourseSubtabBtnManage', 'adminCourseSubtabBtnEnroll', 'adminCourseSubtabBtnList',
    'adminCourseSubtabManage', 'adminCourseSubtabEnroll', 'adminCourseSubtabList'
  ];
  ids.forEach(id => assert.match(html, new RegExp('id="' + id + '"')));
  assert.ok(html.indexOf('adminCourseSubtabManage') < html.indexOf('adminCourseSubtabEnroll'));
  assert.ok(html.indexOf('adminCourseSubtabEnroll') < html.indexOf('adminCourseSubtabList'));
});

test('course management separates completed courses into a historical subsection', () => {
  assert.match(html, /id="adminCompletedCourseTableBody"/);
  assert.match(html, /id="adminCompletedCourseCount"/);
  assert.match(html, /คอร์สที่จบแล้ว/);
  assert.match(html, /const activeCourses = \(courses \|\| \[\]\)\.filter\(function\(course\) \{ return course && course\.deleted !== true && !isCourseCompleted\(course\); \}\)/);
  assert.match(html, /const completedCourses = \(courses \|\| \[\]\)\.filter\(function\(course\) \{ return course && course\.deleted !== true && isCourseCompleted\(course\); \}\)/);
});

test('all enrollment entry points use the completed-course guard', () => {
  assert.match(html, /function getAdminBulkEligibleStudents\(course\) \{\s+if \(!isCourseOpenForEnrollment\(course\)\) return \[\]/);
  assert.match(html, /const openCourses = sortCoursesByGrade\(\(courses \|\| \[\]\)\.filter\(isCourseOpenForEnrollment\)\)/);
  assert.match(html, /return c\.grade === grade && isCourseOpenForEnrollment\(c\) && isCourseInCurrentStudentCenter\(c\) && !existing/);
  assert.match(html, /if \(!isCourseOpenForEnrollment\(latestCourse\)\) throw new Error\('course-closed'\)/);
  assert.match(firestoreRules, /isCourseOpenForStudentEnrollment\(request\.resource\.data\.courseId\)/);
});

test('course enrollment screens expose bulk controls, filters, summaries, and guarded actions', () => {
  [
    'adminEnrollStudentSearch', 'adminEnrollStudentGradeFilter', 'adminEnrollStudentLocationFilter',
    'adminEnrollStudentTableBody', 'adminEnrollStudentPagination',
    'adminBulkEnrollCourse', 'adminBulkEnrollSearch', 'adminBulkEnrollStatus',
    'adminBulkEnrollSelectAll', 'adminBulkEnrollStudentList', 'adminBulkEnrollResult',
    'adminEnrollmentSummaryCards', 'adminEnrollmentListSearch', 'adminEnrollmentListCourse',
    'adminEnrollmentListGrade', 'adminEnrollmentListLocation', 'adminEnrollmentListStatus',
    'adminEnrollmentListPayment', 'adminEnrollmentListTableBody', 'adminEnrollmentListPagination'
  ].forEach(id => assert.match(html, new RegExp('id="' + id + '"')));
  assert.match(html, /onclick="adminEnrollStudentInCourseFromRow\(this\)"/);
  assert.match(html, /class="admin-enroll-row-course"/);
  assert.match(html, /class="admin-enroll-row-status"/);
  assert.match(html, /นักเรียน \/ ชื่อเล่น/);
  assert.match(html, /ชื่อเล่น: ' \+ escapeHtml\(student\.nickname \|\| '-'\)/);
  assert.match(html, /function approveStudentCourse\(id, courseId\) \{\s+if \(!canManageAdminCourseEnrollments\(\)\)/);
  assert.match(html, /function cancelStudentCourse\(id, courseId\) \{\s+if \(!canManageAdminCourseEnrollments\(\)\)/);
  assert.match(html, /function adminBulkEnrollStudents\(\) \{\s+if \(!canManageAdminCourseEnrollments\(\)\)/);
});

test('student and admin enrollment writes also update the main student course projection', () => {
  assert.match(html, /studentMainUpdate = Object\.assign\(\{\}, buildStudentMainCourseFields\(savedEnrollment, currentCourseData\)/);
  assert.match(html, /transaction\.set\(studentRef, studentMainUpdate, \{ merge: true \}\)/);
  assert.match(html, /transaction\.set\(studentRef, buildStudentMainCourseFields\(enrollment, latestCourse\), \{ merge: true \}\)/);
  assert.match(html, /Object\.assign\(activeStudent, buildStudentMainCourseFields\(enrollment, c\)\)/);
});

test('editing a student can reactivate an existing cancelled enrollment', async () => {
  const writes = [];
  const enrollment = {
    id: 'student-1__course-1', firebaseDocId: 'student-1__course-1',
    studentId: 'student-1', courseId: 'course-1', courseName: 'Course 1',
    courseStatus: 'ยกเลิก', paymentStatus: 'ยกเลิก', enrollmentStatus: 'cancelled'
  };
  const context = {
    courseEnrollments: [enrollment], payments: [], firebaseReady: false, db: null,
    getEnrollmentStudentId: student => student.id,
    getCourseEnrollmentDocId: (studentId, courseId) => studentId + '__' + courseId,
    isCourseStatusApproved: status => status === 'อนุมัติแล้ว',
    hasPermission: () => false,
    setFirebaseDocument: async (collection, value) => writes.push({ collection, value: { ...value } })
  };
  vm.createContext(context);
  const helperStart = html.indexOf('    function buildStudentMainCourseFields(');
  const helperEnd = html.indexOf('    function getCourseEnrollmentProjectionTime(', helperStart);
  vm.runInContext(html.slice(helperStart, helperEnd), context);
  const ensureStart = html.indexOf('    async function ensureAdminCourseEnrollment(');
  const ensureEnd = html.indexOf('    function canManageAdminCourseEnrollments(', ensureStart);
  vm.runInContext(html.slice(ensureStart, ensureEnd), context);
  await context.ensureAdminCourseEnrollment(
    { id: 'student-1', registeredCourseMonth: 'ตุลาคม 2569' },
    { id: 'course-1', name: 'Course 1', access: 'Online' },
    'อนุมัติแล้ว'
  );
  assert.equal(enrollment.courseStatus, 'อนุมัติแล้ว');
  assert.equal(enrollment.enrollmentStatus, 'active');
  assert.equal(enrollment.paymentStatus, 'รอชำระเงิน');
  assert.equal(enrollment.everApproved, true);
  assert.equal(writes.some(write => write.collection === 'courseEnrollments'), true);
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
