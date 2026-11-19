const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { source, installStudentDisplayHelpers } = require('./student-display-test-helpers');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function fixture(students = []) {
  const c = vm.createContext({ students });
  installStudentDisplayHelpers(c);
  vm.runInContext(source('escapeHtml'), c);
  return c;
}
const child = { id: 's1', firebaseDocId: 'doc1', memberId: '001', authUid: 'auth1', name: 'สมชาย ใจดี', nickname: 'ต้น' };

test('formats names, whitespace, missing nicknames and special characters without mutating records', () => {
  const c = fixture();
  for (const [input, expected] of [
    [child, 'สมชาย ใจดี (ต้น)'],
    [{ name: '  สมชาย  ', nickname: '  ต้น  ' }, 'สมชาย (ต้น)'],
    [{ name: 'สมชาย', nickname: '-' }, 'สมชาย'],
    [{ nickname: 'ต้น' }, 'ต้น'], [{ name: 'ต้น', nickname: 'ต้น' }, 'ต้น'],
    [{ studentName: 'สมชาย (ต้น)', nickname: 'ต้น' }, 'สมชาย (ต้น)'],
    [{ studentId: 'legacy-id' }, 'legacy-id'], [{}, '-'],
    [{ name: '<เด็ก & "เพื่อน">', nickname: "น้อง'ดี" }, '<เด็ก & "เพื่อน"> (น้อง\'ดี)']
  ]) {
    const before = JSON.stringify(input);
    assert.equal(c.getStudentDisplayName(input), expected);
    assert.equal(JSON.stringify(input), before);
  }
  assert.match(c.escapeHtml(c.getStudentDisplayName({ name: '<เด็ก>', nickname: '<script>' })), /&lt;เด็ก&gt; \(&lt;script&gt;\)/);
});

test('stable IDs select the correct child even when names match; duplicate names never guess', () => {
  const other = { id: 's2', memberId: '002', authUid: 'auth2', name: child.name, nickname: 'ใบ' };
  const c = fixture([child, other]);
  for (const ref of [{ studentId: 's1' }, { studentDocId: 'doc1' }, { memberId: '001' }, { studentUid: 'auth1' }]) {
    assert.equal(c.getStudentDisplayName({ ...ref, studentName: child.name, nickname: 'เก่า' }), 'สมชาย ใจดี (ต้น)');
  }
  assert.equal(c.getStudentDisplayName({ studentId: 's2', studentName: child.name }), 'สมชาย ใจดี (ใบ)');
  assert.equal(c.getStudentDisplayName({ studentName: child.name }), child.name);
  assert.equal(c.getStudentDisplayName({ studentId: 'missing', studentName: child.name }), child.name);
  const shared = fixture([{ ...child, authUid: 'parent' }, { ...other, authUid: 'parent' }]);
  assert.equal(shared.findStudentForDisplay({ authUid: 'parent' }), null);
});

test('current profile wins over snapshots; unique legacy names and record nickname fallbacks work', () => {
  const c = fixture([child]);
  assert.equal(c.getStudentDisplayName({ studentName: child.name, nickname: 'ชื่อเก่า' }), 'สมชาย ใจดี (ต้น)');
  assert.equal(c.getStudentDisplayNickname({ studentId: 's1', nickname: 'ชื่อเก่า' }), 'ต้น');
  assert.equal(c.getStudentDisplayName({ studentName: 'เด็กเก่า', studentNickname: 'เอ' }), 'เด็กเก่า (เอ)');
  assert.equal(c.getStudentDisplayName({ studentName: child.name }, {}), 'สมชาย ใจดี (ต้น)');
});

test('bundle names resolve children individually and never zip unrelated name/ID arrays', () => {
  const c = fixture([child, { id: 's2', name: 'สมหญิง', nickname: 'ใบ' }]);
  const bundle = { items: [{ studentId: 's1', student: child.name }, { studentId: 's2', student: 'สมหญิง' }, { studentId: 's1', student: child.name }] };
  assert.equal(c.getStudentBundleDisplayNames(bundle), 'สมชาย ใจดี (ต้น), สมหญิง (ใบ)');
  assert.equal(c.getStudentBundleDisplayNames({ studentNames: ['สมหญิง', child.name], studentIds: ['s1', 's2'] }), 'สมหญิง (ใบ), สมชาย ใจดี (ต้น)');
});

function loaderFixture() {
  const c = fixture(), reads = [];
  Object.assign(c, {
    firebaseReady: true, firebaseUser: { uid: 'staff' }, studentDataSessionVersion: 1,
    firestoreQuotaBlocked: false, isCurrentStudentSession: () => false,
    firebase: { firestore: { FieldPath: { documentId: () => '__name__' } } },
    mergeStudentEntityRecords(records) {
      for (const record of records) {
        const found = c.students.find(s => s.firebaseDocId === record.firebaseDocId);
        if (found) Object.assign(found, record); else c.students.push(record);
      }
    }, rebuildStudentLookupMap() {}, markFirestoreQuotaExceeded() {}, console: { warn() {} },
    db: { collection: () => ({ where: (field, op, values) => ({ get: async () => {
      reads.push({ field, values: Array.from(values) });
      return { docs: [{ id: child.firebaseDocId, data: () => ({ ...child }) }] };
    } }) }) }
  });
  vm.runInContext('const studentDisplayLoads = new Map();\n' + source('loadStudentDisplayRecords'), c);
  return { c, reads };
}

test('loads missing legacy profiles in batches, merges existing cache, shares pending reads and caches misses', async () => {
  const { c, reads } = loaderFixture();
  c.students.push({ id: 'unrelated', nickname: 'คงอยู่' });
  const records = Array.from({ length: 12 }, (_, i) => ({ studentName: 'เด็ก ' + i }));
  await Promise.all([c.loadStudentDisplayRecords(records), c.loadStudentDisplayRecords(records)]);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(r => r.values.length <= 10));
  assert.equal(c.students[0].id, 'unrelated');
  assert.equal(c.getStudentDisplayName({ studentId: 's1' }), 'สมชาย ใจดี (ต้น)');
  await c.loadStudentDisplayRecords(records);
  assert.equal(reads.length, 2);
});

test('partial cached profiles are refreshed and each supported historical identity can be loaded', async () => {
  const { c, reads } = loaderFixture();
  c.students.push({ ...child, nickname: undefined }); delete c.students[0].nickname;
  await c.loadStudentDisplayRecords([{ studentId: 's1', studentName: child.name }, { studentUid: 'auth2', studentName: 'เด็กสอง' }]);
  assert.equal(c.students[0].nickname, 'ต้น');
  assert.ok(reads.some(r => r.field === '__name__'));
  assert.ok(reads.some(r => r.field === 'authUid'));
  assert.ok(reads.some(r => r.field === 'memberId'));
});

test('failed lookups retry, while student sessions and quota blocks trigger no staff reads', async () => {
  const { c, reads } = loaderFixture();
  const db = c.db;
  c.db = { collection() { throw new Error('offline'); } };
  assert.equal(await c.loadStudentDisplayRecords([{ studentName: 'เด็กเก่า' }]), false);
  c.db = db;
  assert.equal(await c.loadStudentDisplayRecords([{ studentName: 'เด็กเก่า' }]), true);
  const count = reads.length;
  c.isCurrentStudentSession = () => true;
  await c.loadStudentDisplayRecords([{ studentName: 'อื่น' }]);
  c.isCurrentStudentSession = () => false; c.firestoreQuotaBlocked = true;
  await c.loadStudentDisplayRecords([{ studentName: 'อื่น' }]);
  assert.equal(reads.length, count);
});

test('late lookups cannot merge profiles after a logout or account switch', async () => {
  const { c } = loaderFixture();
  let release;
  c.db = { collection: () => ({ where: () => ({ get: () => new Promise(resolve => { release = resolve; }) }) }) };
  const pending = c.loadStudentDisplayRecords([{ studentName: 'เด็กเก่า' }]);
  await Promise.resolve();
  c.firebaseUser = { uid: 'new-staff' }; c.studentDataSessionVersion++;
  release({ docs: [{ id: 'old', data: () => child }] });
  assert.equal(await pending, false);
  assert.equal(c.students.length, 0);
});

test('receipt and mobile approval render nickname with escaped HTML while retaining raw action IDs', () => {
  const c = fixture([child]);
  Object.assign(c, { payments: [], systemSettings: {}, getReceiptDisplayTotal: () => 500, formatPrice: n => String(n), getReceiptMonth: () => 'พฤศจิกายน', receiptLineItemsHtml: () => '' });
  for (const name of ['jsArg', 'actionCall', 'receiptHtml', 'renderTeacherMobileApprovalCard']) vm.runInContext(source(name), c);
  const receipt = { studentId: 's1', student: child.name, receiptNo: 'R1', approvedDate: '19/11/69', course: 'Math' };
  assert.match(c.receiptHtml(receipt), /สมชาย ใจดี \(ต้น\)/);
  assert.equal(receipt.student, child.name);
  const card = c.renderTeacherMobileApprovalCard(child);
  assert.match(card, /สมชาย ใจดี \(ต้น\)/);
  assert.match(card, /approveStudentCourse\('s1'\)/);
});

test('payment row actions use stored IDs rather than formatted cell text', () => {
  const c = fixture([child]);
  c.findPaymentByAnyId = id => id === 'p1' ? { studentId: 's1' } : null;
  vm.runInContext(source('getStudentByPaymentRow'), c);
  assert.equal(c.getStudentByPaymentRow({ getAttribute: key => key === 'data-payment-id' ? 'p1' : '', children: [{}, { innerText: 'ชื่ออื่น (ชื่อเล่นอื่น)' }] }), child);
  assert.equal(c.getStudentByPaymentRow({ getAttribute: () => '', children: [{}, { innerText: child.name }] }), null);
});

test('existing nickname columns stay distinct and public ranking keeps its masked name policy', () => {
  const c = fixture([child]);
  vm.runInContext(source('getGamificationLeaderboardDisplayName'), c);
  assert.equal(c.getGamificationLeaderboardDisplayName({ studentName: child.name, nickname: child.nickname }), 'ต้น');
  assert.equal(c.getGamificationLeaderboardDisplayName({ studentName: child.name }), 'สมชาย ใ.');
  for (const name of ['renderTeacherStudents', 'renderAdminStudents', 'buildIdCardCellHtml', 'applicationFormHtml']) {
    assert.match(source(name), /nickname/);
  }
});

test('teacher table and CSV retain separate nickname fields without duplication', () => {
  const c = fixture([child]);
  const tbody = { innerHTML: '' }; let csv;
  Object.assign(c, {
    getElement: id => id === 'teacherStudentTableBody' ? tbody : null,
    getTeacherVisibleCourses: () => [], renderTeacherCourseOptions() {},
    getSortedTeacherStudentListForExport: () => [child], LIST_PAGE_SIZE: 20, teacherStudentsCurrentPage: 1,
    getPickupStatusClass: () => '', getStudentGamificationSummaryText: () => '',
    getStampCardRedemptionsForStudent: () => [], getSpecialVoucherSummaryForStudent: () => ({ totalCount: 0 }),
    renderTablePagination() {}, safeRun() {}, renderTeacherMobileStudents() {}, renderTeacherDashboardSummary() {}, getTeacherStudentCenterValue: () => 'ศูนย์หนึ่ง',
    getLocalDateString: () => '2026-11-19', downloadCsv: (name, rows) => { csv = rows; }
  });
  for (const name of ['jsArg', 'renderTeacherStudents', 'downloadTeacherStudentListCsv']) vm.runInContext(source(name), c);
  c.renderTeacherStudents();
  assert.equal((tbody.innerHTML.match(/ต้น/g) || []).length, 1);
  assert.ok(tbody.innerHTML.indexOf('previewSingleStudentIdCard') < tbody.innerHTML.indexOf(child.name));
  c.downloadTeacherStudentListCsv();
  assert.equal(csv[0][3], 'ชื่อเล่น');
  assert.equal(csv[1][2], child.name); assert.equal(csv[1][3], child.nickname);
});

test('score cells use the latest profile nickname and escape both name fields', () => {
  const c = fixture([{ ...child, nickname: '<ต้น>' }]);
  for (const name of ['findStudentForScoreRecord', 'getScoreRecordMemberId', 'renderScoreRecordStudentCell']) vm.runInContext(source(name), c);
  const cell = c.renderScoreRecordStudentCell({ studentId: 's1', student: child.name, nickname: 'ชื่อเก่า' });
  assert.match(cell, /ชื่อเล่น: &lt;ต้น&gt;/);
  assert.doesNotMatch(cell, /ชื่อเก่า/);
});

test('aggregate receipts retain every child instead of resolving only the first student ID', () => {
  const c = fixture([child, { id: 's2', name: 'สมหญิง', nickname: 'ใบ' }]);
  const receipt = { studentId: 's1', student: 'ยอดรวม: สมชาย ใจดี, สมหญิง' };
  assert.equal(c.getStudentDisplayName(receipt), 'ยอดรวม: สมชาย ใจดี (ต้น), สมหญิง (ใบ)');
  assert.equal(c.getStudentDisplayName({ ...receipt, studentNames: [child.name, 'สมหญิง'] }), 'ยอดรวม: สมชาย ใจดี (ต้น), สมหญิง (ใบ)');
  assert.equal(c.getStudentBundleDisplayNames({ paymentItems: [{ studentId: 's1', student: child.name }, { studentId: 's2', student: 'สมหญิง' }] }), 'สมชาย ใจดี (ต้น), สมหญิง (ใบ)');
});
