const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('    async function loadCourseEnrollmentsForStudentPage(');
const end = html.indexOf('    async function loadGradePromotionPreview(', start);

function setup(failField) {
  const requests = [], pending = [];
  const student = { id: 's1', authUid: 'u1', memberId: 'm1', name: 'นักเรียน' };
  const context = {
    db: { collection: () => ({ where(field, op, values) {
      return { get() { requests.push({ field, values }); return new Promise((resolve, reject) => pending.push({ field, resolve, reject })); } };
    } }) },
    getStudentIdentityKeys: s => [s.id, s.memberId],
    enrollmentBelongsToStudent: (enrollment, s) => enrollment.studentId === s.id,
    firebaseSnapshotItems: snapshot => snapshot.items,
    markFirestoreQuotaExceeded() {}, console: { warn() {} }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return { context, student, requests, pending, failField };
}

test('legacy enrollment identity queries overlap and deduplicate results', async () => {
  const h = setup();
  const task = h.context.loadCourseEnrollmentsForStudentPage([h.student]);
  assert.equal(h.requests.length, 5, 'independent identity queries start together');
  for (const request of h.pending) request.resolve({ items: [{ id: 'e1', studentId: 's1' }] });
  const result = await task;
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'e1');
});

test('a failed identity query does not silently present a partial enrollment list', async () => {
  const h = setup();
  const task = h.context.loadCourseEnrollmentsForStudentPage([h.student]);
  for (const request of h.pending) {
    if (request.field === 'memberId') request.reject(new Error('offline'));
    else request.resolve({ items: [] });
  }
  await assert.rejects(task, /offline/);
});

test('default student pagination advances by the same 20 records that are displayed', async () => {
  const sourceStart = html.indexOf('    async function loadAdminStudentServerPage(');
  const sourceEnd = html.indexOf('    function scheduleAdminStudentServerLoad(', sourceStart);
  const docs = Array.from({ length: 45 }, (_, i) => ({ id: String(i).padStart(2, '0'), data: () => ({ name: 'student' }) }));
  const filter = { keyword: '', grade: 'ทั้งหมด' };
  const c = {
    isQuotaOptimizedLoadingEnabled: () => true, isStudentSearchIndexEnabled: () => false,
    firebaseReady: true, firebase: { firestore: { FieldPath: { documentId: () => '__name__' } } },
    db: { collection: () => { let limit = 0, after = null; const query = {
      orderBy: () => query, limit: n => { limit = n; return query; }, startAfter: d => { after = d; return query; },
      get: async () => { const begin = after ? docs.indexOf(after) + 1 : 0; const page = docs.slice(begin, begin + limit); return { docs: page, size: page.length }; }
    }; return query; } },
    getAdminStudentServerFilterState: () => filter, getElement: () => null,
    firebaseSnapshotItems: snapshot => snapshot.docs.map(d => ({ firebaseDocId: d.id })),
    loadCourseEnrollmentsForStudentPage: async () => [], mergeStudentEntityRecords() {}, mergeCourseEnrollmentEntityRecords() {},
    getStudentEntityKey: s => s.firebaseDocId, getCourseEnrollmentEntityKey: e => e.id,
    rebuildStudentLookupMap() {}, renderAdminStudents() {}, markFirestoreQuotaExceeded() {}, console,
    adminStudentPerPage: 20, adminStudentCurrentPage: 1,
    adminStudentServerState: { key: '', loading: false, ready: false, page: 1, cursors: [], pageCache: new Map() }
  };
  vm.createContext(c); vm.runInContext(html.slice(sourceStart, sourceEnd), c);
  const seen = [];
  for (let page = 0; page < 3; page++) {
    assert.equal(await c.loadAdminStudentServerPage(page ? 1 : 0), true);
    seen.push(...c.adminStudentServerState.studentIds);
  }
  assert.deepEqual(seen, docs.map(d => d.id));
  assert.equal(c.adminStudentServerState.hasMore, false);
});
