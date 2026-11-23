const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function load(context, names) {
  for (const name of names) {
    const match = new RegExp('^    (?:async )?function ' + name + '\\(', 'm').exec(html);
    assert.ok(match, name);
    const end = html.indexOf('\n    }', match.index) + 6;
    vm.runInContext(html.slice(match.index, end), context);
  }
}
const exam = { firebaseDocId: 'exam-1', grade: 'ป.6', subject: 'คณิตศาสตร์', location: '', examMonth: 'พฤศจิกายน 2569' };
const student = (id, extra = {}) => ({ id, name: id, grade: 'ป.6', preferredLocation: 'A', ...extra });
const enrollment = (id, status = 'อนุมัติแล้ว', extra = {}) => ({ id: id + '__course', studentId: id, courseId: 'course', courseStatus: status, ...extra });

function setup() {
  const c = {
    students: [], courseEnrollments: [], currentStudent: null, currentStudentCourseId: '',
    firebaseUser: { uid: 'admin' }, studentDataSessionVersion: 1,
    getOnlineExamLinkedCourseGrade: () => '', compareThaiMonthYear: () => 0, compareOnlineExamSubjects: () => 0,
    escapeHtml: value => String(value || ''),
    loadCourseEnrollmentsForStudentPage: async () => [],
    mergeCourseEnrollmentEntityRecords(records) {
      for (const record of records) {
        const index = c.courseEnrollments.findIndex(e => e.id === record.id);
        if (index < 0) c.courseEnrollments.push(record);
        else c.courseEnrollments[index] = record;
      }
    }
  };
  vm.createContext(c);
  load(c, [
    'getOnlineExamCandidateStudents', 'getOnlineExamExpectedStudents', 'refreshOnlineExamStudentEnrollments',
    'getOnlineExamMissingStudents', 'renderOnlineExamMissingStudentsHtml',
    'getStudentOnlineExamIdentitySet', 'getOnlineExamCourseGrade', 'getOnlineExamCourseLocation',
    'getStudentOnlineExamLocation', 'getOnlineExamCourseAudienceKey', 'filterOnlineExamCoursesForStudentLocation',
    'isActiveStudentForDashboard', 'studentCanParticipateInExams', 'studentCanUseCourseEntitlements',
    'studentHasApprovedCourse', 'getSelectedStudentCourseEnrollment', 'getStudentCourseEnrollments',
    'isCourseEnrollmentCurrent', 'buildLegacyCourseEnrollment', 'getCourseEnrollmentDocId',
    'getEnrollmentStudentId', 'enrollmentBelongsToStudent', 'getStudentIdentityKeys',
    'isCourseStatusApproved', 'isStudentLimitedAccess', 'isStudentOnLearningPause', 'isStudentWithdrawn', 'getStudentLearningStatus'
  ]);
  return c;
}

test('only current approved enrollments enter the exam roster, including legacy and multiple courses', () => {
  const c = setup();
  c.students = [student('none', { course: 'ยังไม่ได้สมัครคอร์ส' }), student('pending'), student('cancelled'),
    student('completed'), student('rejected'), student('deleted'), student('approved'), student('multi'),
    student('legacy', { courseId: 'old', course: 'Old', courseStatus: 'อนุมัติแล้ว' }),
    student('stale-legacy', { courseId: 'course', course: 'Old', courseStatus: 'อนุมัติแล้ว' })];
  c.courseEnrollments = [enrollment('pending', 'รออนุมัติคอร์ส'), enrollment('cancelled', 'ยกเลิก'),
    enrollment('completed', 'จบคอร์ส'), enrollment('rejected', 'ไม่อนุมัติ'), enrollment('deleted', 'อนุมัติแล้ว', { deleted: true }),
    enrollment('approved'), enrollment('multi', 'รออนุมัติคอร์ส', { id: 'multi__pending', courseId: 'pending' }),
    enrollment('multi'), enrollment('stale-legacy', 'ยกเลิก')];
  assert.deepEqual(Array.from(c.getOnlineExamExpectedStudents('ป.6', [exam]), s => s.id).sort(), ['approved', 'legacy', 'multi']);
  for (const status of ['Active', 'สมัครแล้ว']) {
    c.courseEnrollments.find(e => e.studentId === 'approved').courseStatus = status;
    assert.ok(c.getOnlineExamExpectedStudents('ป.6', [exam]).some(s => s.id === 'approved'));
  }
});

test('grade, center, pause, withdrawal and archived exclusions remain intact', () => {
  const c = setup();
  c.students = [student('ok'), student('paused', { learningStatus: 'พักเรียน' }), student('withdrawn', { learningStatus: 'ลาออก' }),
    student('archived', { archived: true }), student('grade', { grade: 'ป.5' }), student('center', { preferredLocation: 'B' })];
  c.courseEnrollments = c.students.map(s => enrollment(s.id));
  assert.deepEqual(Array.from(c.getOnlineExamExpectedStudents('ป.6', [{ ...exam, location: 'A' }]), s => s.id), ['ok']);
});

test('missing and completed counts use eligible students; exemption and center overrides still apply', () => {
  const c = setup();
  c.students = ['none', 'missing', 'done', 'exempt'].map(id => student(id));
  c.courseEnrollments = ['missing', 'done', 'exempt'].map(id => enrollment(id));
  const exams = [exam, { ...exam, firebaseDocId: 'center-exam', location: 'A', exemptStudentIds: ['exempt'] }];
  const expected = c.getOnlineExamExpectedStudents('ป.6', exams);
  const missing = c.getOnlineExamMissingStudents(exams, expected, [{ courseId: 'center-exam', studentId: 'done' }]);
  assert.deepEqual(Array.from(missing, row => row.student.id), ['missing']);
  assert.equal(missing[0].missingCourses[0].firebaseDocId, 'center-exam');
  const output = c.renderOnlineExamMissingStudentsHtml(missing, exams, expected.length);
  assert.match(output, /นักเรียนเป้าหมาย 3 คน/);
  assert.match(output, /<p>2 คน<\/p>/);
});

function setupReport() {
  const c = setup();
  const report = { style: {}, innerHTML: '' };
  const filters = {};
  Object.assign(c, {
    firebaseReady: true, db: {}, onlineExamGradeRefreshSeq: 0, onlineExamGradeMissingItems: [],
    hasPermission: () => true, getElement: id => id === 'onlineExamGradingReport' ? report : filters[id] || null,
    getOnlineExamGradeFilterScope: () => ({ grade: 'ป.6', month: '', subject: '' }),
    syncAdminScoreFiltersFromOnlineExamFilters() {}, renderAdminScoreTables() {}, setOnlineExamGradeRefreshLoading() {},
    loadOnlineExamResultsForGradeScope: async () => [], getOnlineExamGradingTargetCourses: () => [exam],
    loadOnlineExamGradingStudents: async () => c.students,
    mergeStudentEntityRecords() {}, rebuildStudentLookupMap() {},
    onlineExamGradingResultMatchesFilters: () => true, compareOnlineExamResultsByMemberId: () => 0,
    buildOnlineExamGroupedRows: results => results, renderAdminScoreStatsChartCard() {},
    getAdminScoreStatsRecordsForScope() {}, getAdminScoreVisibleFilterScope() {},
    renderOnlineExamGradingPage() { report.innerHTML = c.onlineExamGradeMissingHtml; }, console: { error() {} }
  });
  load(c, ['renderOnlineExamGradingReport']);
  return { c, report, filters };
}

function mockRosterDatabase(c, getRows) {
  const reads = [];
  c.db = { collection(name) {
    assert.equal(name, 'students');
    let grades = null;
    const query = {
      where(field, op, values) {
        assert.equal(field, 'grade'); assert.equal(op, 'in');
        grades = Array.from(values);
        return query;
      },
      async get() {
        reads.push(grades);
        const rows = getRows();
        return { docs: rows.filter(s => !grades || grades.includes(s.grade)).map(s => ({ id: s.id, data: () => s })) };
      }
    };
    return query;
  } };
  c.firebaseSnapshotItems = snap => snap.docs.map(d => ({ firebaseDocId: d.id, ...d.data() })).filter(s => s.deleted !== true);
  c.markFirestoreQuotaExceeded = () => {};
  load(c, ['loadOnlineExamGradingStudents']);
  return reads;
}

test('students added after the exam opens appear even when absent from the startup cache', async () => {
  const { c, report } = setupReport();
  c.students = [student('old', { grade: 'ป.5' })];
  const addedStudent = student('new-student', { memberId: '0070027' });
  const reads = mockRosterDatabase(c, () => [addedStudent]);
  c.loadCourseEnrollmentsForStudentPage = async () => [enrollment('new-student')];
  await c.renderOnlineExamGradingReport(true);
  assert.deepEqual(Array.from(c.onlineExamGradeMissingItems, row => row.student.memberId), ['0070027']);
  assert.match(report.innerHTML, /นักเรียนเป้าหมาย 1 คน/);
  assert.deepEqual(reads, [['ป.6']]);
});

test('exam roster reads all matching students beyond the first 50 and refreshes after enrollment changes', async () => {
  const c = setup();
  const serverStudents = Array.from({ length: 65 }, (_, i) => student('s' + i));
  serverStudents.push(student('other-grade', { grade: 'ป.5' }), student('deleted', { deleted: true }));
  const reads = mockRosterDatabase(c, () => serverStudents);
  const first = await c.loadOnlineExamGradingStudents('ป.6', [exam]);
  assert.equal(first.length, 65);
  serverStudents.push(student('added-later', { memberId: '0070027' }));
  const refreshed = await c.loadOnlineExamGradingStudents('ป.6', [exam]);
  assert.equal(refreshed.length, 66);
  assert.ok(refreshed.some(s => s.memberId === '0070027'));
  assert.deepEqual(reads, [['ป.6'], ['ป.6']]);
});

test('all-grade report loads target grades and only falls back to all students for ungraded exams', async () => {
  const c = setup();
  const reads = mockRosterDatabase(c, () => []);
  await c.loadOnlineExamGradingStudents('', [exam, { ...exam, grade: 'ป.5' }, exam]);
  await c.loadOnlineExamGradingStudents('', [{ ...exam, grade: '' }]);
  await c.loadOnlineExamGradingStudents('', []);
  assert.deepEqual(reads, [['ป.6', 'ป.5'], null]);
});

test('roster loading failure shows an error rather than using the stale cached roster', async () => {
  const { c, report } = setupReport();
  c.students = [student('cached')];
  mockRosterDatabase(c, () => { throw new Error('roster offline'); });
  await c.renderOnlineExamGradingReport(true);
  assert.match(report.innerHTML, /roster offline/);
  assert.doesNotMatch(report.innerHTML, /นักเรียนเป้าหมาย/);
});

test('fresh server roster excludes cached students no longer returned by the query', async () => {
  const { c, report } = setupReport();
  c.students = [student('stale')];
  c.courseEnrollments = [enrollment('stale')];
  mockRosterDatabase(c, () => []);
  await c.renderOnlineExamGradingReport(true);
  assert.equal(c.onlineExamGradeMissingItems.length, 0);
  assert.match(report.innerHTML, /นักเรียนเป้าหมาย 0 คน/);
});

test('a session change during roster loading cannot merge or render the old report', async () => {
  const { c, report } = setupReport();
  let merged = false;
  c.mergeStudentEntityRecords = () => { merged = true; };
  c.loadOnlineExamGradingStudents = async () => {
    c.studentDataSessionVersion++;
    return [student('old-session')];
  };
  await c.renderOnlineExamGradingReport();
  assert.equal(merged, false);
  assert.doesNotMatch(report.innerHTML, /นักเรียนเป้าหมาย/);
});

test('report loads enrollments before filtering and preserves historical results', async () => {
  const { c, report } = setupReport();
  c.students = [student('none'), student('approved')];
  c.loadCourseEnrollmentsForStudentPage = async list => {
    assert.equal(list.length, 2);
    return [enrollment('approved')];
  };
  const history = { studentId: 'none', courseId: 'exam-1' };
  c.loadOnlineExamResultsForGradeScope = async () => [history];
  await c.renderOnlineExamGradingReport();
  assert.match(report.innerHTML, /นักเรียนเป้าหมาย 1 คน/);
  assert.deepEqual(Array.from(c.onlineExamGradeMissingItems, row => row.student.id), ['approved']);
  assert.equal(c.onlineExamGradeAllResults[0], history);
});

test('enrollment load failure shows an error without rendering counts', async () => {
  const { c, report } = setupReport();
  c.students = [student('approved')];
  c.loadCourseEnrollmentsForStudentPage = async () => { throw new Error('offline'); };
  await c.renderOnlineExamGradingReport();
  assert.match(report.innerHTML, /offline/);
  assert.doesNotMatch(report.innerHTML, /นักเรียนเป้าหมาย/);
});

test('an outdated report cannot replace the latest report after enrollment loading', async () => {
  const { c, report } = setupReport();
  c.students = [student('approved')];
  let resolve;
  c.loadCourseEnrollmentsForStudentPage = () => new Promise(done => { resolve = done; });
  const task = c.renderOnlineExamGradingReport();
  await new Promise(done => setImmediate(done));
  c.onlineExamGradeRefreshSeq++;
  report.innerHTML = 'new report';
  resolve([enrollment('approved')]);
  await task;
  assert.equal(report.innerHTML, 'new report');
});

test('session changes do not merge enrollments into another session', async () => {
  const c = setup();
  c.loadCourseEnrollmentsForStudentPage = async () => {
    c.studentDataSessionVersion++;
    return [enrollment('approved')];
  };
  await assert.rejects(c.refreshOnlineExamStudentEnrollments([student('approved')]), /เซสชันเปลี่ยน/);
  assert.equal(c.courseEnrollments.length, 0);
});

function setupAbsent() {
  const c = setup();
  const alerts = [], writes = [];
  let confirms = 0, refreshes = 0;
  c.students = [student('approved')];
  c.courseEnrollments = [enrollment('approved')];
  Object.assign(c, {
    onlineExamGradeMissingItems: [{ student: c.students[0], missingCourses: [exam] }],
    onlineExamGradeAllResults: [], onlineExamGradeGroupedRows: [],
    hasPermission: () => true, alert: text => alerts.push(text), confirm: () => { confirms++; return true; },
    getStudentDisplayName: s => s.name, createFirebaseDocId: () => 'absence',
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 123 } } }, firebaseUserProfile: {},
    db: { collection: () => ({ doc: () => ({ set: async data => writes.push(data) }) }) },
    addActivityLog() {}, buildOnlineExamGroupedRows: rows => rows, resetOnlineExamGradeResultCache() {},
    renderOnlineExamGradingReport: async force => { assert.equal(force, true); refreshes++; },
    showOnlineExamMissingStudentList() {}
  });
  load(c, ['markStudentExamAbsent']);
  return { c, alerts, writes, confirms: () => confirms, refreshes: () => refreshes };
}

test('an open missing list cannot record absence after enrollment cancellation', async () => {
  const h = setupAbsent();
  h.c.loadCourseEnrollmentsForStudentPage = async () => [enrollment('approved', 'ยกเลิก')];
  await h.c.markStudentExamAbsent(0, 'exam-1');
  assert.equal(h.writes.length, 0);
  assert.equal(h.confirms(), 0);
  assert.match(h.alerts[0], /คอร์สปัจจุบันที่อนุมัติแล้ว/);
});

test('absence is blocked if enrollment verification fails', async () => {
  const h = setupAbsent();
  h.c.loadCourseEnrollmentsForStudentPage = async () => { throw new Error('offline'); };
  await h.c.markStudentExamAbsent(0, 'exam-1');
  assert.equal(h.writes.length, 0);
  assert.match(h.alerts[0], /offline/);
});

test('approved absence is saved and refreshes counts from the full report', async () => {
  const h = setupAbsent();
  h.c.loadCourseEnrollmentsForStudentPage = async () => [enrollment('approved')];
  await h.c.markStudentExamAbsent(0, 'exam-1');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].resultStatus, 'absent');
  assert.equal(h.refreshes(), 1);
  assert.equal(h.alerts.length, 0);
});
