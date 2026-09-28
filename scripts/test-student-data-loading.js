const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function section(start, end) { return html.slice(html.indexOf(start), html.indexOf(end)); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const loads = [], listeners = [];
  const query = { where() { return this; }, orderBy() { return this; }, limit() { return this; }, get: async () => ({ docs: [] }),
    onSnapshot(options, next) { Promise.resolve().then(() => next({ docs: [], docChanges: () => [] })); return () => {}; } };
  const c = {
    STUDENT_HOME_REALTIME_COLLECTIONS: ['payments','receipts','paymentBundles','studentGamificationProfiles','studentGamificationEvents','studentPersonalQuests'],
    resetStaffDataSession() {}, getElement: () => null, onlineExamCoursesLoadSeq: 0, safeRun: fn => fn(), triggerDailyLoginQuestIfNeeded() {},
    firebaseReady: true, firebaseUser: { uid: 'A' }, db: { collection: () => query },
    console: { log() {}, warn() {} }, currentStudent: null,
    studentDataLoadedForUid: '', studentDataLoadingPromise: null,
    studentDataLoadingForUid: '', studentDataSessionUid: '', studentDataSessionVersion: 0,
    studentRealtimeSession: null, studentRealtimeRefreshTimer: null,
    window: { setTimeout: () => 1 }, clearTimeout() {},
    buildStudentOwnedQuerySpecs: name => [{ key: name, query: c.db.collection(name) }],
    prizeWheelSettings: {}, onlineExamCourseCache: [], onlineExamCoursesLoaded: false,
    getOwnedStudentRecords: () => { const task = deferred(); loads.push(task); return task.promise; },
    normalizeStudentRecordForSession: x => x, getStudentRecordDocId: x => x.id,
    getStudentIdentityKeys: x => [x.id], replaceArray: (a, b) => a.splice(0, a.length, ...b),
    getFirebaseCollectionQuiet: async () => [],
    startStudentPaymentListeners: (ids, uid) => listeners.push(uid), stopStudentPaymentListeners() {},
    findStudentForUserProfile: (profile, uid) => c.students.find(x => x.authUid === uid) || null
  };
  for (const name of ['students','courses','onDemandClips','announcements','scoreReports','adminScoreRecords','paymentMonths','lineGroups','payments','receipts','paymentBundles','monthlyExamLinks','monthlyPlanSessions','studentGamificationProfiles','studentGamificationEvents','studentPersonalQuests','leaderboardProfiles','gamificationRewards','gamificationRedemptions','specialVoucherActivities','prizeWheelItems','prizeWheelSpins','avatarBattleQuestions']) c[name] = [];
  vm.createContext(c);
  for (const [start, end] of [
    ['    function createRealtimeCollectionGroup(', '    function stopAdminPaymentDataListeners('],
    ['    function scheduleStudentRealtimeRefresh(', '    function resetStudentDataSession(']
  ]) vm.runInContext(section(start, end), c);
  const resetStart = html.indexOf('    function resetStudentDataSession(');
  if (resetStart !== -1) vm.runInContext(html.slice(resetStart, html.indexOf('    async function loadStudentDataOnly(', resetStart)), c);
  vm.runInContext(section('    async function loadStudentDataOnly(', '    function refreshStudentPanelAfterDataLoad('), c);
  return { c, loads, get listeners() { return c.studentRealtimeSession && c.studentRealtimeSession.active && c.studentRealtimeSession.uiReady ? [c.studentRealtimeSession.uid] : []; }, load: force => c.ensureStudentDataLoaded({}, { force }), finish: (i, uid = 'A') => loads[i].resolve([{ id: uid, authUid: uid }]) };
}

test('concurrent loads including force share one request; completed data is reused', async () => {
  const h = setup();
  const tasks = [h.load(), h.load(), h.load(true)];
  assert.equal(h.loads.length, 1);
  h.finish(0);
  const results = await Promise.all(tasks);
  assert.ok(results.every(x => x.id === 'A'));
  assert.equal((await h.load()).id, 'A');
  assert.equal(h.loads.length, 1);
  assert.deepEqual(h.listeners, ['A']);
  const refresh = h.load(true);
  assert.equal(h.loads.length, 2);
  h.finish(1); await refresh;
});

test('failed load can retry', async () => {
  const h = setup(), first = h.load();
  h.loads[0].reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  const retry = h.load(); h.finish(1); await retry;
  assert.equal(h.c.studentDataLoadedForUid, 'A');
});

test('old account finishing late cannot replace new account or its pending request', async () => {
  const h = setup(), old = h.load();
  h.c.firebaseUser = { uid: 'B' };
  const fresh = h.load();
  h.finish(0); assert.equal(await old, null);
  const joined = h.load(); assert.equal(h.loads.length, 2);
  h.finish(1, 'B'); await Promise.all([fresh, joined]);
  assert.equal(h.c.currentStudent.id, 'B');
  assert.deepEqual(h.listeners, ['B']);
});

test('logout during collection loading prevents all data and listener writes', async () => {
  const h = setup(), gate = deferred();
  let reached;
  const started = new Promise(r => { reached = r; });
  h.c.getFirebaseCollectionQuiet = () => { reached(); return gate.promise; };
  const old = h.load(); h.finish(0); await started;
  h.c.resetStudentDataSession(''); h.c.firebaseUser = null;
  h.c.currentStudent = null; h.c.students.length = 0;
  gate.resolve([{ id: 'stale' }]);
  assert.equal(await old, null);
  assert.equal(h.c.courses.length, 0);
  assert.equal(h.c.students.length, 0);
  assert.equal(h.c.currentStudent, null);
  assert.deepEqual(h.listeners, []);
});

test('logout and login to the same UID does not revive a previous load', async () => {
  const h = setup(), old = h.load();
  h.c.resetStudentDataSession(''); h.c.firebaseUser = { uid: 'A' };
  const fresh = h.load();
  h.finish(1); await fresh;
  h.finish(0); assert.equal(await old, null);
  assert.deepEqual(h.listeners, ['A']);
});

test('missing student and Firebase not ready do not become cached successes', async () => {
  const h = setup(), first = h.load(); h.loads[0].resolve([]); await first;
  assert.equal(h.c.studentDataLoadedForUid, '');
  h.c.firebaseReady = false; await h.load();
  assert.equal(h.c.studentDataLoadedForUid, '');
  h.c.firebaseReady = true;
  const retry = h.load(); h.finish(1); await retry;
  assert.equal(h.c.studentDataLoadedForUid, 'A');
});

for (const failingCollection of ['courses', 'payments', 'adminScoreRecords']) {
  test(`partial ${failingCollection} failure is not cached and can retry`, async () => {
    const h = setup();
    let fail = true;
    h.c.COLLECTION_FETCH_LIMITS = {};
    h.c.db.collection = name => {
      const query = { where() { return this; }, orderBy() { return this; }, limit() { return this; },
        get: async () => {
          if (fail && name === failingCollection) throw new Error('offline');
          return { docs: [] };
        }, onSnapshot(options, next, error) {
          Promise.resolve().then(() => {
            if (fail && name === failingCollection) error(new Error('offline'));
            else next({ docs: [], docChanges: () => [] });
          });
          return () => {};
        } };
      return query;
    };
    h.c.buildStudentOwnedQuerySpecs = name => [{ label: name, query: h.c.db.collection(name) }];
    vm.runInContext(section('    async function getFirebaseCollection(', '    async function getFirebasePaymentCollection('), h.c);
    vm.runInContext(section('    async function getFirebaseCollectionQuiet(', '    function getStudentRecordDocId('), h.c);
    vm.runInContext(section('    function createRealtimeCollectionGroup(', '    function stopStudentPaymentListeners('), h.c);
    const first = h.load(); h.finish(0); await first;
    assert.equal(h.c.studentDataLoadedForUid, '');
    fail = false;
    const retry = h.load(); assert.equal(h.loads.length, 2);
    h.finish(1); await retry;
    assert.equal(h.c.studentDataLoadedForUid, 'A');
  });
}

test('student initial load uses listeners instead of one-off owned collection reads', async () => {
  const h = setup();
  h.c.loadStudentOwnCollection = () => { throw new Error('Duplicate owned collection read'); };
  const first = h.load(); h.finish(0); await first;
  assert.equal(Object.keys(h.c.studentRealtimeSession.groups).length, 6);
  assert.equal(h.c.studentDataLoadedForUid, 'A');
});

test('listener failure after initial success invalidates cached load on next request', async () => {
  const h = setup(), first = h.load(); h.finish(0); await first;
  const previous = h.c.studentRealtimeSession;
  const oldGroup = previous.groups.payments;
  oldGroup.failed = true;
  const retry = h.load(); assert.equal(h.loads.length, 2); h.finish(1); await retry;
  assert.notEqual(h.c.studentRealtimeSession.groups.payments, oldGroup);
  assert.equal(oldGroup.active, false);
  assert.equal(h.c.studentDataLoadedForUid, 'A');
});

test('home load never requests deferred clips, exam bank, reward shop or wheel data', async () => {
  const h=setup(),reads=[];
  h.c.getFirebaseCollectionQuiet=async name=>{reads.push(name);return [];};
  const first=h.load();h.finish(0);await first;
  for(const name of ['onDemandClips','monthlyExamLinks','gamificationRewards','prizeWheelItems','prizeWheelSettings'])assert.ok(!reads.includes(name),name);
  for(const name of ['courses','announcements','scoreReports','paymentMonths','lineGroups','monthlyPlanSessions'])assert.ok(reads.includes(name),name);
  assert.equal(Object.keys(h.c.studentRealtimeSession.groups).length,6);
});
