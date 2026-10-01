const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const match = new RegExp('^    (?:async )?function ' + name + '\\(', 'm').exec(html);
  assert.ok(match, name);
  return html.slice(match.index, html.indexOf('\n    }', match.index) + 6);
}
function setup() {
  const subscriptions = [], reads = [], timers = new Map(), renders = [];
  let timerId = 0;
  function query(collection, filters = []) {
    return {
      where: (...args) => query(collection, filters.concat([args])),
      orderBy: (...args) => query(collection, filters.concat([['orderBy', ...args]])),
      limit: n => query(collection, filters.concat([['limit', n]])),
      get: async () => { reads.push(collection); return { docs: [] }; },
      onSnapshot(options, next, error) {
        const sub = { collection, filters, options, next, error, stopped: false };
        subscriptions.push(sub); return () => { sub.stopped = true; };
      }
    };
  }
  const c = { firebaseReady: true, firebaseUser: { uid: 'A' }, db: { collection: query },
    studentDataSessionVersion: 0, studentRealtimeSession: null, studentRealtimeRefreshTimer: null,
    adminRealtimeSession: null, adminPaymentDataRefreshTimer: null, prizeWheelSpinning: false,
    courseEndScheduleTimer: null, courseEndScheduleProcessing: false,
    COLLECTION_FETCH_LIMITS: { payments: { limit: 600 }, receipts: { limit: 600 }, paymentBundles: { limit: 300 } },
    console: { warn() {}, log() {} }, hasPermission: () => true,
    replaceArray: (a, b) => a.splice(0, a.length, ...b), safeRun: fn => fn(),
    window: { setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; } },
    clearTimeout: id => timers.delete(id), scheduleAdminPaymentDataRefresh() {},
    isAuthUidLikeStudentQueryKey: (id, uid) => id === uid
  };
  for (const name of ['courses','courseEnrollments','payments','receipts','paymentBundles','studentGamificationProfiles','studentGamificationEvents','studentPersonalQuests','gamificationRedemptions','prizeWheelSpins']) c[name] = [];
  for (const name of ['refreshStudentPaymentMonthSelect','updateStudentSelectedPaymentMonth','renderStudentReceipts','renderStudentMobilePayment','renderStudentGamificationPanel','updateStudentCourseDisplay']) c[name] = () => renders.push(name);
  vm.createContext(c);
  for (const name of ['createRealtimeCollectionGroup','stopStudentPaymentListeners','stopAdminPaymentDataListeners','startAdminPaymentDataListeners','startStudentPaymentListeners','scheduleStudentRealtimeRefresh','waitForRealtimeCollection','studentCollectionUsesAuthUidOnly','buildStudentOwnedQuerySpecs']) vm.runInContext(source(name), c);
  function emit(sub, data, changes, metadata = {}) {
    const docs = data.map(row => ({ id: row.id, data: () => ({ ...row }) }));
    sub.next({ docs, metadata, docChanges: () => changes || docs.map(doc => ({ type: 'added', doc })) });
  }
  return { c, subscriptions, reads, renders, emit, flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } } };
}

test('overlapping queries retain a document until it leaves every query', async () => {
  const h = setup(), target = [];
  const group = h.c.createRealtimeCollectionGroup([{ query: h.c.db.collection('payments') }, { query: h.c.db.collection('pending') }], target, () => true, () => {});
  h.emit(h.subscriptions[0], [{ id: 'p1', status: 'waiting' }]);
  h.emit(h.subscriptions[1], [{ id: 'p1', status: 'waiting' }]);
  assert.equal(await group.ready, true); assert.equal(target.length, 1);
  h.emit(h.subscriptions[0], [{ id: 'p1', status: 'paid' }]);
  h.emit(h.subscriptions[1], [], [{ type: 'removed', doc: { id: 'p1', data: () => ({ status: 'waiting' }) } }]);
  assert.equal(target.length, 1); assert.equal(target[0].status, 'paid');
  h.emit(h.subscriptions[0], []); assert.equal(target.length, 0);
});

test('soft delete stays excluded while another query still contains it', async () => {
  const h = setup(), target = [];
  const group = h.c.createRealtimeCollectionGroup([{query:h.c.db.collection('a')},{query:h.c.db.collection('b')}], target, () => true, () => {});
  h.emit(h.subscriptions[0], [{id:'p1'}]); h.emit(h.subscriptions[1], [{id:'p1'}]); await group.ready;
  h.emit(h.subscriptions[0], [{id:'p1',deleted:true}]); assert.equal(target.length,0);
  h.emit(h.subscriptions[1], [{id:'p1'}], []); assert.equal(target.length,0);
});

test('pending-write metadata transition initializes and stop settles pending readiness', async () => {
  const h = setup(), target = [];
  const group = h.c.createRealtimeCollectionGroup([{query:h.c.db.collection('a')}], target, () => true, () => {});
  assert.equal(h.subscriptions[0].options.includeMetadataChanges, true);
  h.emit(h.subscriptions[0], [{id:'p1'}], undefined, {hasPendingWrites:true}); assert.equal(group.initialized,false);
  h.emit(h.subscriptions[0], [{id:'p1'}], [], {hasPendingWrites:false}); assert.equal(await group.ready,true);
  group.stop(); h.emit(h.subscriptions[0], [{id:'late'}]); assert.equal(target[0].id,'p1');
  const pending = h.c.createRealtimeCollectionGroup([{query:h.c.db.collection('b')}], target, () => true, () => {});
  pending.stop(); assert.equal(await pending.ready,false);
});

test('admin re-entry reuses six listeners; errors can restart and old callbacks are ignored', async () => {
  const h = setup(), first = h.c.startAdminPaymentDataListeners();
  assert.equal(h.c.startAdminPaymentDataListeners(), first); assert.equal(h.subscriptions.length,6);
  h.subscriptions[0].error(new Error('permission-denied'));
  for (const sub of h.subscriptions.slice(1)) h.emit(sub,[]);
  assert.equal(await first.groups.payments.ready,false);
  const second = h.c.startAdminPaymentDataListeners(); assert.notEqual(first,second);
  assert.ok(h.subscriptions.slice(0,6).every(s=>s.stopped));
  h.emit(h.subscriptions[0],[{id:'late'}]); assert.equal(h.c.payments.length,0);
  h.c.stopAdminPaymentDataListeners(); assert.ok(h.subscriptions.every(s=>s.stopped));
});

test('student modern and legacy identities stay covered; repeated starts reuse listeners and UI updates coalesce', async () => {
  const h = setup(), first = h.c.startStudentPaymentListeners(['doc-A'], 'A', ['doc-A','001']);
  const count = h.subscriptions.length;
  assert.equal(h.c.startStudentPaymentListeners(['doc-A'], 'A', ['001','doc-A']),first);
  assert.equal(h.subscriptions.length,count); assert.equal(h.reads.length,0);
  const fields = h.subscriptions.filter(s=>s.collection==='payments').map(s=>s.filters[0][0]);
  for (const field of ['authUid','studentAuthUid','studentId','memberId']) assert.ok(fields.includes(field));
  for (const sub of h.subscriptions) h.emit(sub,[]);
  await Promise.all(Object.values(first.groups).map(g=>g.ready));
  first.uiReady = true;
  h.emit(h.subscriptions[0],[{id:'p1'}]); h.emit(h.subscriptions[1],[{id:'p1'}]);
  h.flush(); assert.equal(h.renders.length,6);
  h.c.stopStudentPaymentListeners(); assert.ok(h.subscriptions.every(s=>s.stopped));
  h.emit(h.subscriptions[0],[{id:'late'}]); h.flush(); assert.equal(h.renders.length,6);
});

test('admin finance tab loads from listeners without duplicate financial get calls', async () => {
  const h = setup();
  const staffSource = html.slice(html.indexOf('    const STAFF_DATA_GROUPS ='), html.indexOf('    async function ensureCoreDataLoaded('));
  for (const name of source('getStaffCollectionTargets').match(/return \{([\s\S]*?)\};/)[1].match(/\b\w+\b/g)) if (!h.c[name]) h.c[name]=[];
  h.c.PRODUCTION_MODE=true; h.c.isCurrentStudentSession=()=>false;
  h.c.systemSettings={}; h.c.safeRun=()=>{}; h.c.applySystemSettingsToPage=()=>{};
  h.c.clearInterval=()=>{}; h.c.startCourseEndScheduleChecks=()=>{};
  h.c.getFirebaseCollection=async name=>{h.reads.push(name);return [];};
  h.c.getFirebasePaymentCollection=async()=>{throw new Error('Duplicate payment get');};
  h.c.rebuildStudentLookupMap=()=>{};
  vm.runInContext(staffSource,h.c);
  const loading=h.c.ensureStaffCollections(h.c.getStaffTabCollections('admin-payment'));
  for(const sub of h.subscriptions) h.emit(sub,sub.collection==='payments'?[{id:'p1',amount:1200}]:[]);
  await loading;
  for(const name of ['payments','receipts','paymentBundles'])assert.ok(!h.reads.includes(name),name);
  assert.equal(h.c.payments[0].amount,1200);
});

test('confirmed metadata-only snapshot applies a previously skipped write and preserves record references', async () => {
  const h=setup(), original={id:'p1',amount:1500}, target=[original];
  const group=h.c.createRealtimeCollectionGroup([{query:h.c.db.collection('payments')}],target,()=>true,()=>{});
  h.emit(h.subscriptions[0],[{id:'p1',amount:1500}]); await group.ready;
  h.emit(h.subscriptions[0],[{id:'p1',amount:1200}],undefined,{hasPendingWrites:true});
  h.emit(h.subscriptions[0],[{id:'p1',amount:1200}],[],{hasPendingWrites:false});
  assert.equal(target[0],original); assert.equal(original.amount,1200);
});

test('manual admin refresh restarts listeners without adding a get() path', async () => {
  const h=setup(), button={}; h.c.startAdminPaymentDataListeners();
  h.c.document={getElement:()=>button,getElementById:()=>button};
  for(const name of ['applyPaymentRepairsSync','renderPaymentTable','updatePaymentSummary','renderPaymentBundlePanel','renderAdminDashboard'])h.c[name]=()=>{};
  h.c.alert=message=>{throw new Error(message);};
  vm.runInContext(source('refreshAdminPaymentData'),h.c);
  const task=h.c.refreshAdminPaymentData();
  assert.ok(h.subscriptions.slice(0,6).every(s=>s.stopped));
  for(const sub of h.subscriptions.slice(6))h.emit(sub,[]);
  await task; assert.equal(h.reads.length,0); assert.equal(button.disabled,false);
});
