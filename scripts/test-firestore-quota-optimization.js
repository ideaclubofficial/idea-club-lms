const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  buildStudentSearchIndex,
  getEnrollmentSearchText,
  getSearchToken,
  normalizeSearchText,
} = require('../functions/student-search-index');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('Thai and numeric substring search tokens are deterministic', () => {
  const enrollmentTexts = { e1: getEnrollmentSearchText({ courseName: 'คณิตศาสตร์ ม.2', courseStatus: 'อนุมัติแล้ว' }) };
  const index = buildStudentSearchIndex('s1', {
    name: 'เด็กชาย สมชาย ใจดี', nickname: 'ชาย', phone: '081-234-5678', memberId: 'IC-001', grade: 'ม.2',
  }, enrollmentTexts);
  assert.ok(index.normalizedText.includes(normalizeSearchText('สมชาย')));
  assert.ok(index.searchTokens.includes(getSearchToken('มชาย')));
  assert.ok(index.searchTokens.includes(getSearchToken('1234')));
  assert.ok(index.normalizedText.includes('คณิตศาสตร์'));
});

test('online exam remote autosave is capped to a 120-second changed-only cadence', () => {
  assert.match(html, /onlineExamSaveDraft\(\{ remote: false \}\)/);
  assert.match(html, /draftHash === onlineExamLastRemoteDraftHash/);
  assert.match(html, /\}, 120000\);/);
  const intervalWrites = Math.floor((15 * 60) / 120);
  const maximumWrites = 1 + intervalWrites + 1 + 1; // initial + interval + hidden + pre-submit
  assert.ok(maximumWrites <= 10, String(maximumWrites));
});

test('quota optimized Dashboard never opens finance listeners and finance subscribes only to requested collections', () => {
  assert.match(html, /STUDENT_HOME_REALTIME_COLLECTIONS = \['courseEnrollments', 'payments', 'receipts', 'paymentBundles'\]/);
  assert.match(html, /quotaOptimizedLoadingDisabled/);
  const finance = html.slice(html.indexOf('    function startAdminPaymentDataListeners('), html.indexOf('    function scheduleStudentRealtimeRefresh('));
  assert.match(finance, /\(options\.collections \|\| \[\]\)\.forEach/);
  assert.match(finance, /query: db.collection\(name\)/);
  assert.doesNotMatch(finance, /\.limit\(|\.orderBy\(|\.where\(/);
  assert.match(html, /function renderAdminTabContent\(tabId\) \{\s*retainAdminPaymentDataListeners\(getStaffTabCollections\(tabId\)\)/);
  assert.match(html, /const QUOTA_OPTIMIZED_STAFF_TAB_DATA = \{\s*'admin-dashboard': \[\]/);
  assert.match(html, /const financeSnapshot = name === 'receipts' \|\| name === 'paymentMonths'/);
  for (const collection of ['students', 'teachers', 'courses', 'courseEnrollments', 'payments', 'receipts', 'paymentBundles']) {
    assert.match(html, new RegExp(collection + ":[\\s\\S]{0,120}limit:"), collection);
  }
});

test('Dashboard aggregates use authenticated Firestore REST and distinguish quota errors from zero', async () => {
  const start = html.indexOf('    async function getFirestoreCount(');
  const end = html.indexOf('    async function loadAdminDashboardQuotaSummary(', start);
  let request;
  const context = {
    firebase: { app: () => ({ options: { projectId: 'demo-project' } }) },
    fetch: async (url, options) => {
      request = { url, ...options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => [{ readTime: 'now' }, { result: { aggregateFields: { total: { integerValue: '0' } } } }] };
    }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.equal(await context.getFirestoreCount('students', 'deleted', false, 'test-token'), 0);
  assert.match(request.url, /demo-project.*runAggregationQuery$/);
  assert.equal(request.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(request.body.structuredAggregationQuery.structuredQuery.where.fieldFilter.value, { booleanValue: false });
  context.fetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(context.getFirestoreCount('students', 'deleted', false, 'test-token'), { code: 'resource-exhausted' });
});

test('Spark plan defaults to bounded loading while search index remains separately gated', () => {
  const start = html.indexOf('    function isQuotaOptimizedLoadingEnabled(');
  const end = html.indexOf('    function firebaseSnapshotItems(', start);
  const context = { systemSettings: {} };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.equal(context.isQuotaOptimizedLoadingEnabled(), true);
  assert.equal(context.isStudentSearchIndexEnabled(), false);
  context.systemSettings.quotaOptimizedLoadingDisabled = true;
  assert.equal(context.isQuotaOptimizedLoadingEnabled(), false);
  context.systemSettings.quotaOptimizedLoadingDisabled = false;
  context.systemSettings.studentSearchIndexVersion = 1;
  assert.equal(context.isQuotaOptimizedLoadingEnabled(), true);
  assert.equal(context.isStudentSearchIndexEnabled(), true);
  assert.match(html, /Free-plan fallback:[\s\S]*orderBy\(firebase\.firestore\.FieldPath\.documentId\(\)\)\.limit\(adminStudentPerPage\)/);
  for (const field of ['studentId', 'authUid', 'memberId', 'studentName']) {
    assert.match(html, new RegExp(field + ': \\[\\]'), field);
  }
  assert.match(html, /function loadAdminCourseEnrollmentStudents\(\)[\s\S]*FieldPath\.documentId\(\)\)\.limit\(50\)/);
  assert.match(html, /function renderAdminCourseEnrollmentSection\(\)[\s\S]*adminCourseEnrollmentServerState\.ready/);
  assert.match(html, /const studentEntityCache = new Map\(\)/);
  assert.match(html, /state\.pageCache\.set\(pageCacheKey/);
  const studentLoader = html.slice(html.indexOf('    async function loadAdminStudentServerPage('), html.indexOf('    function scheduleAdminStudentServerLoad('));
  assert.doesNotMatch(studentLoader, /replaceArray\(students|replaceArray\(courseEnrollments/);
  assert.match(studentLoader, /mergeStudentEntityRecords\(loadedStudents\)/);
});

test('new activity logs explicitly skip the existence read', () => {
  assert.match(html, /setFirebaseDocument\('activityLogs', item, \{ assumeNew: true \}\)/);
});

test('attendance loads the complete day roster without replacing the shared student cache', () => {
  const start = html.indexOf('    async function loadAttendanceRosterForDate(');
  const end = html.indexOf('    function getAttendanceRosterStudents(', start);
  const loader = html.slice(start, end);
  assert.match(loader, /getAttendanceCoursesForDate\(targetDate\)/);
  assert.match(loader, /where\('grade', 'in', gradeChunk\)\.get\(\)/);
  assert.match(loader, /mergeStudentEntityRecords\(loadedStudents\)/);
  assert.doesNotMatch(loader, /replaceArray\(students/);
  assert.match(html, /function syncPickupListFromStudents\(\)[\s\S]*getAttendanceRosterStudents\(\)\.forEach/);
  assert.match(html, /'teacher-attendance': \['attendanceHistory'\]/);
});
