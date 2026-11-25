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
    adminPendingPaymentRecords: [], adminDashboardQuotaSummary: null,
    courseEndScheduleTimer: null, courseEndScheduleProcessing: false,
    COLLECTION_FETCH_LIMITS: { payments: { limit: 600 }, receipts: { limit: 600 }, paymentBundles: { limit: 300 } },
    console: { warn() {}, log() {} }, hasPermission: () => true,
    rememberFirebaseDocumentSnapshot() {}, markFirestoreQuotaExceeded() {}, isFirestoreQuotaExceededError: () => false,
    isQuotaOptimizedLoadingEnabled: () => false, firestoreQuotaBlocked: false,
    replaceArray: (a, b) => a.splice(0, a.length, ...b), safeRun: fn => fn(),
    window: { setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; } },
    clearTimeout: id => timers.delete(id), scheduleAdminPaymentDataRefresh() {},
    isAuthUidLikeStudentQueryKey: (id, uid) => id === uid
  };
  for (const name of ['courses','courseEnrollments','payments','receipts','paymentBundles','paymentMonths','studentGamificationProfiles','studentGamificationEvents','studentPersonalQuests','gamificationRedemptions','prizeWheelSpins']) c[name] = [];
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

test('admin re-entry reuses finance listeners; errors can restart them', async () => {
  const h = setup(), first = h.c.startAdminPaymentDataListeners();
  assert.equal(h.c.startAdminPaymentDataListeners(), first); assert.equal(h.subscriptions.length,4);
  h.subscriptions[0].error(new Error('permission-denied'));
  assert.equal(await first.groups.payments.ready,false);
  const second = h.c.startAdminPaymentDataListeners(); assert.notEqual(first,second);
  assert.ok(h.subscriptions[0].stopped);
  h.emit(h.subscriptions[0],[{id:'late'}]); assert.equal(h.c.payments.length,0);
  h.emit(h.subscriptions[4],[{id:'p1',slipStatus:'waiting_admin_review'}]);
  assert.equal(await second.groups.payments.ready,true); assert.equal(h.c.payments.length,1);
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

test('admin finance tab loads complete live datasets without duplicate one-off financial reads', async () => {
  const h = setup(); h.c.isQuotaOptimizedLoadingEnabled=()=>true;
  const staffSource = html.slice(html.indexOf('    const STAFF_DATA_GROUPS ='), html.indexOf('    async function ensureCoreDataLoaded('));
  for (const name of source('getStaffCollectionTargets').match(/return \{([\s\S]*?)\};/)[1].match(/\b\w+\b/g)) if (!h.c[name]) h.c[name]=[];
  h.c.PRODUCTION_MODE=true; h.c.isCurrentStudentSession=()=>false;
  h.c.systemSettings={}; h.c.safeRun=()=>{}; h.c.applySystemSettingsToPage=()=>{};
  h.c.clearInterval=()=>{}; h.c.startCourseEndScheduleChecks=()=>{};
  h.c.getFirebaseCollection=async name=>{h.reads.push(name);return [];};
  h.c.getFirebasePaymentCollection=async()=>{h.reads.push('payments');return [{id:'base',amount:900}];};
  h.c.rebuildStudentLookupMap=()=>{};
  vm.runInContext(staffSource,h.c);
  const loading=h.c.ensureStaffCollections(h.c.getStaffTabCollections('admin-payment'));
  await new Promise(resolve=>setImmediate(resolve));
  for(const sub of h.subscriptions) h.emit(sub,[{id:'p1',amount:1200,slipStatus:'waiting_admin_review'}]);
  await loading;
  for(const name of ['payments','receipts','paymentBundles'])assert.ok(!h.reads.includes(name),name);
  assert.deepEqual(h.subscriptions.map(s=>s.collection).sort(), ['paymentBundles','payments','receipts']);
  assert.equal(h.reads.includes('paymentMonths'), false);
  assert.equal(h.c.payments.some(p=>p.amount===1200),true);
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
  assert.ok(h.subscriptions[0].stopped);
  for(const sub of h.subscriptions.filter(s=>!s.stopped))h.emit(sub,[]);
  await task; assert.equal(h.reads.length,0); assert.equal(button.disabled,false);
});

// Replay the same server data in independent browser sessions. Respect the actual
// listener filters, so an emitted unpaid record cannot bypass a pending-only query.
function publishServer(h, collection, rows) {
  for (const sub of h.subscriptions.filter(s => !s.stopped && s.collection === collection)) {
    let visible = rows.slice();
    for (const [field, op, value] of sub.filters) {
      if (op === '==') visible = visible.filter(row => row[field] === value);
      if (field === 'orderBy') visible = visible.filter(row => row[op] !== undefined);
      if (field === 'limit') visible = visible.slice(0, op);
    }
    h.emit(sub, visible);
  }
}

test('two admin devices converge on new unpaid bills, approvals, edits and deletions', async () => {
  const a = setup(), b = setup();
  for (const h of [a,b]) h.c.startAdminPaymentDataListeners();
  const rows = [{id:'old', amount:100}, {id:'new', amount:900, slipStatus:'not_uploaded'}];
  // The writer already has the new row locally after a successful save.
  a.c.payments.push({...rows[1]});
  for (const h of [a,b]) publishServer(h, 'payments', rows);
  assert.equal(b.c.payments.length, 2, 'the second device must see unpaid bills too');
  rows[1] = {...rows[1], amount:1200, slipStatus:'approved', status:'ชำระแล้ว'};
  for (const h of [a,b]) publishServer(h, 'payments', rows);
  assert.equal(b.c.payments.find(p=>p.id==='new').amount, 1200);
  rows[0].deleted = true;
  for (const h of [a,b]) publishServer(h, 'payments', rows);
  assert.deepEqual(JSON.parse(JSON.stringify(a.c.payments)), JSON.parse(JSON.stringify(b.c.payments)));
  assert.equal(b.c.payments.length, 1);
  for (const h of [a,b]) publishServer(h, 'payments', []);
  assert.equal(b.c.payments.length, 0);
});

test('finance snapshots include records beyond old caps and legacy records without updatedAt', async () => {
  const h = setup(); h.c.startAdminPaymentDataListeners();
  const rows = Array.from({length:701}, (_,i)=>({id:'p'+i, amount:i, slipStatus:'not_uploaded'}));
  publishServer(h, 'payments', rows);
  assert.equal(h.c.payments.length, 701);
  for (const collection of ['receipts','paymentBundles','paymentMonths']) {
    publishServer(h, collection, [{id:'remote', amount:800}]);
    assert.equal(h.c[collection].length, 1, collection);
  }
});

test('opening receipts starts only receipts and adding payments reuses the same session', async () => {
  const h = setup();
  const session = h.c.startAdminPaymentDataListeners({collections:['receipts']});
  publishServer(h, 'receipts', [{id:'r1',amount:900}]);
  assert.equal(await session.groups.receipts.ready, true);
  assert.deepEqual(h.subscriptions.map(s=>s.collection), ['receipts']);
  assert.equal(h.c.startAdminPaymentDataListeners({collections:['payments']}), session);
  publishServer(h, 'payments', [{id:'p1',amount:900,slipStatus:'not_uploaded'}]);
  assert.equal(await session.groups.payments.ready, true);
  assert.deepEqual(h.subscriptions.map(s=>s.collection), ['receipts','payments']);
  assert.equal(h.c.receipts[0].id, 'r1');
});

test('receipt permission alone receives live receipts; unauthorized users start no listeners', async () => {
  const h = setup(); h.c.hasPermission = p => p === 'admin.receipts';
  const session = h.c.startAdminPaymentDataListeners({collections:['receipts']});
  publishServer(h, 'receipts', [{id:'r1'}]);
  assert.equal(await session.groups.receipts.ready, true);
  h.c.hasPermission = () => false;
  assert.equal(h.c.startAdminPaymentDataListeners(), null);
  assert.ok(h.subscriptions.every(s=>s.stopped));
  publishServer(h, 'receipts', [{id:'late'}]);
  assert.equal(h.c.receipts[0].id, 'r1');
});

test('refresh replaces stale bills and includes remotely created nonpending records in all finance datasets', async () => {
  const h = setup(), button = {};
  h.c.startAdminPaymentDataListeners();
  publishServer(h, 'payments', [{id:'stale',amount:100}]);
  h.c.document = {getElementById:()=>button};
  for (const name of ['applyPaymentRepairsSync','renderPaymentTable','updatePaymentSummary','renderPaymentBundlePanel','renderAdminDashboard']) h.c[name]=()=>{};
  h.c.alert=message=>{throw new Error(message);};
  vm.runInContext(source('refreshAdminPaymentData'), h.c);
  const task = h.c.refreshAdminPaymentData();
  for (const collection of ['payments','receipts','paymentBundles','paymentMonths']) publishServer(h, collection, [{id:'remote',amount:1200}]);
  await task;
  for (const collection of ['payments','receipts','paymentBundles','paymentMonths']) {
    assert.deepEqual(Array.from(h.c[collection], r=>r.id), ['remote']);
  }
  assert.equal(h.reads.length, 0);
  assert.equal(button.disabled, false);
});
