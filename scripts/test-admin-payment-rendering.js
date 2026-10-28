const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const match = new RegExp('^    (?:async )?function ' + name + '\\(', 'm').exec(html);
  if (!match) return '';
  return html.slice(match.index, html.indexOf('\n    }', match.index) + 6);
}
const names = ['renderPaymentTable','updatePaymentSummary','renderPaymentBundlePanel','renderAdminDashboard','renderDashboardPaymentSummary','renderPaymentRecordPreview'];
function setup() {
  const elements = {}, counts = {}, timers = new Map(); let nextTimer = 0;
  function element(id, parent) {
    return elements[id] = { parentElement: parent || null, hidden: false, style: {}, innerHTML: '', textContent: '', value: '',
      classList: { hidden: false, contains(name) { return name === 'hidden' && this.hidden; } } };
  }
  const root = element('adminInterface');
  const payment = element('admin-payment', root), dashboard = element('admin-dashboard', root), round = element('admin-payment-round', root);
  for (const id of ['paymentTableBody','paymentBundlePanel','pendingSlipCount','pendingBundleSlipCount','overdueCount','paidThisMonthCount','paidAmountThisMonth','expectedAmountThisMonth']) element(id, payment);
  for (const id of ['dashTotalStudents','dashboardPaymentSummary']) element(id, dashboard);
  for (const id of ['paymentRecordPreviewSummary','paymentRecordPreviewTableBody','paymentRecordPreviewResult']) element(id, round);
  const c = { console: { log() {} }, getElement: id => elements[id] || null, payments: [], students: [], courses: [],
    paymentCurrentPage: 1, LIST_PAGE_SIZE: 20, adminPaymentDataRefreshTimer: null,
    window: { setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; } }, clearTimeout: id => timers.delete(id),
    safeRun: fn => fn(), getFilteredPaymentsForTable: () => [], getScopedPaymentBundles: () => [],
    getDashboardScopedPayments: () => c.payments, getDashboardScopedPaymentBundles: () => [],
    getPaymentDisplayStatus: p => p.status, getPaymentBundleDisplayStatus: p => p.status,
    getPaymentDashboardAmountTotals: () => ({ scope: {}, paidAmount: c.payments.filter(p => p.status === 'ชำระแล้ว').reduce((n,p) => n+p.amount,0), expectedAmount: c.payments.reduce((n,p) => n+p.amount,0) }),
    formatPrice: n => String(n), getSelectedPaymentRecordMonth: () => '', getLocalDateString: () => '2026-09-27',
    isActiveStudentForDashboard: () => true, getPendingPaymentRecords: () => [], getPendingPaymentBundles: () => [],
    getOverduePaymentRecords: () => [], getPendingCourseStudents: () => [] };
  for (const name of ['applyPaymentRepairsSync','renderTablePagination','updatePaymentBundleSelectionHint','updatePaymentPreviewSelectionSummary','renderAdminTodoList','renderNewMemberNotificationBox','renderAdminDataQualityBox']) c[name] = () => {};
  vm.createContext(c);
  const queueStart = html.indexOf('    const adminPaymentRenderDirty = ');
  if (queueStart !== -1) vm.runInContext(html.slice(queueStart, html.indexOf('    function scheduleAdminPaymentDataRefresh(', queueStart)), c);
  for (const name of [...names,'updatePaymentAmountSummary','scheduleAdminPaymentDataRefresh']) {
    vm.runInContext(source(name), c);
    if (source(name + 'Now')) vm.runInContext(source(name + 'Now'), c);
  }
  for (const name of names) {
    const target = c[name + 'Now'] ? name + 'Now' : name, original = c[target];
    counts[name] = 0;
    c[target] = (...args) => { counts[name]++; return original(...args); };
  }
  const flush = async () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } await Promise.resolve(); };
  return { c, elements, counts, flush, payment, dashboard, round, root };
}

test('one realtime refresh renders each requested surface once', async () => {
  const h = setup(); h.c.scheduleAdminPaymentDataRefresh('payments'); await h.flush();
  for (const name of names) assert.equal(h.counts[name], 1, name);
});

test('repeated realtime events and legacy save calls share the render queue', async () => {
  const h = setup();
  h.c.scheduleAdminPaymentDataRefresh('payments'); h.c.scheduleAdminPaymentDataRefresh('receipts');
  h.c.renderPaymentTable(); h.c.updatePaymentSummary(); h.c.renderAdminDashboard(); h.c.renderPaymentBundlePanel();
  await h.flush();
  for (const name of names) assert.equal(h.counts[name], 1, name);
});

test('hidden surfaces wait until opened and use the newest payment totals', async () => {
  const h = setup(); h.payment.classList.hidden = true; h.dashboard.classList.hidden = true; h.round.classList.hidden = true;
  h.c.scheduleAdminPaymentDataRefresh(); await h.flush();
  assert.ok(Object.values(h.counts).every(n => n === 0));
  h.c.payments = [{ amount: 1200, status: 'ชำระแล้ว' }];
  h.payment.classList.hidden = false; h.c.renderPaymentTable(); await h.flush();
  assert.equal(h.elements.paidAmountThisMonth.textContent, '1200');
  assert.equal(h.elements.paidThisMonthCount.textContent, '1 รายการ');
  assert.equal(h.counts.renderAdminDashboard, 0);
});

test('hidden parent blocks rendering; moving payment tools into visible teacher panel works', async () => {
  const h = setup(); h.root.classList.hidden = true;
  h.c.renderPaymentTable(); await h.flush(); assert.equal(h.counts.renderPaymentTable, 0);
  h.payment.parentElement = { style: {}, classList: { contains: () => false }, parentElement: null };
  h.c.renderPaymentTable(); await h.flush(); assert.equal(h.counts.renderPaymentTable, 1);
});

test('preview success message survives a generic refresh in the same batch', async () => {
  const h = setup(); h.c.renderPaymentRecordPreview('บันทึกแล้ว', false); h.c.renderPaymentRecordPreview();
  await h.flush(); assert.equal(h.counts.renderPaymentRecordPreview, 1);
  assert.equal(h.elements.paymentRecordPreviewResult.textContent, 'บันทึกแล้ว');
});

test('approval and receipt issuance update totals once and preserve receipt writes', async () => {
  const h = setup(), writes = [];
  const payment = { id: 'p1', amount: 1200, status: 'รอตรวจสลิป' };
  h.c.payments = [payment];
  h.c.findPaymentByAnyId = () => payment;
  h.c.setFirebaseDocument = async (collection, data) => writes.push({ collection, data: { ...data } });
  h.c.issueReceiptFromPayment = async () => ({ id: 'r1', receiptNo: 'R001' });
  for (const name of ['syncStudentPaymentStatusFromPayment','renderAdminReceipts','renderStudentReceipts','renderStudentMobilePayment','addActivityLog']) h.c[name] = () => {};
  vm.runInContext(source('approvePaymentAndIssueReceipt'), h.c);
  await h.c.approvePaymentAndIssueReceipt('p1'); await h.flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].data.receiptId, 'r1');
  assert.equal(payment.receiptStatus, 'published');
  assert.equal(h.elements.paidAmountThisMonth.textContent, '1200');
  for (const name of ['renderPaymentTable','renderPaymentBundlePanel','updatePaymentSummary','renderDashboardPaymentSummary']) assert.equal(h.counts[name], 1, name);
});

test('custom amount save persists 1200 and updates visible totals once', async () => {
  const h = setup(), payment = { id: 'p1', originalAmount: 1500, amount: 1500, status: 'ค้างชำระ' }, writes = [];
  h.c.payments = [payment];
  h.elements.bubblePaymentOriginalAmount = { value: '1500' };
  h.c.findPaymentByAnyId = () => payment; h.c.canEditPaymentAmount = () => true;
  h.c.isPaymentInActiveBundle = () => false; h.c.getPaymentDisplayStatus = p => p.status;
  h.c.getPaymentFinalAmount = p => p.amount; h.c.escapeHtml = s => s;
  h.c.currentAdmin = { name: 'Admin' }; h.c.firebaseUser = { email: 'admin@example.com' };
  h.c.bubbleValue = id => ({ bubbleDiscountType: 'manualCustom', bubblePaymentFinalAmount: '1200' }[id] || '');
  let save;
  h.c.openEditBubble = (title, body, handler) => { save = handler; };
  h.c.commitPaymentAmountAdjustment = async (data, monthPriceAmount) => writes.push({ data: { ...data }, monthPriceAmount });
  for (const name of ['updateStudentSelectedPaymentMonth','updateStudentCourseDisplay','renderStudentMobilePayment','renderAdminReceipts','renderStudentReceipts','closeEditBubble']) h.c[name] = () => {};
  vm.runInContext(source('editPaymentAmountDiscount'), h.c);
  h.c.editPaymentAmountDiscount({ closest: () => ({ getAttribute: () => 'p1' }) });
  await save(); await h.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.finalAmount, 1200);
  assert.equal(writes[0].data.discount, 300);
  assert.equal(writes[0].monthPriceAmount, 1200);
  assert.equal(h.elements.expectedAmountThisMonth.textContent, '1200');
  assert.equal(h.counts.updatePaymentSummary, 1);
});

test('failed custom amount write keeps the bubble open and restores the prior amount', async () => {
  const h = setup(), payment = { id: 'p1', originalAmount: 1500, amount: 1500, status: 'ค้างชำระ' };
  h.c.payments = [payment];
  h.elements.bubblePaymentOriginalAmount = { value: '1500' };
  h.c.findPaymentByAnyId = () => payment;
  h.c.canEditPaymentAmount = () => true;
  h.c.isPaymentInActiveBundle = () => false;
  h.c.getPaymentDisplayStatus = p => p.status;
  h.c.getPaymentFinalAmount = p => p.amount;
  h.c.escapeHtml = s => s;
  h.c.currentAdmin = { name: 'Admin' };
  h.c.firebaseUser = { email: 'admin@example.com' };
  h.c.bubbleValue = id => ({ bubbleDiscountType: 'manualCustom', bubblePaymentFinalAmount: '1200' }[id] || '');
  let save;
  let closeCalls = 0;
  h.c.openEditBubble = (title, body, handler) => { save = handler; };
  h.c.commitPaymentAmountAdjustment = async () => { throw new Error('network unavailable'); };
  for (const name of ['updateStudentSelectedPaymentMonth','updateStudentCourseDisplay','renderStudentMobilePayment','renderAdminReceipts','renderStudentReceipts']) h.c[name] = () => {};
  h.c.closeEditBubble = () => { closeCalls++; };
  vm.runInContext(source('editPaymentAmountDiscount'), h.c);
  h.c.editPaymentAmountDiscount({ closest: () => ({ getAttribute: () => 'p1' }) });

  await assert.rejects(save(), /network unavailable/);
  assert.equal(payment.amount, 1500);
  assert.equal(payment.originalAmount, 1500);
  assert.equal(closeCalls, 0);
});

test('approved payment requires a reason and a positive amount before saving', async () => {
  const h = setup();
  const payment = { id: 'p1', originalAmount: 2700, amount: 2700, finalAmount: 2700, status: 'ชำระแล้ว', slipStatus: 'approved', receiptId: 'r1' };
  h.c.payments = [payment];
  h.elements.bubblePaymentOriginalAmount = { value: '2700' };
  h.elements.editBubbleResult = { textContent: '', style: {} };
  h.c.findPaymentByAnyId = () => payment;
  h.c.canEditPaymentAmount = () => true;
  h.c.isPaymentInActiveBundle = () => false;
  h.c.getPaymentDisplayStatus = () => 'ชำระแล้ว';
  h.c.getPaymentFinalAmount = p => p.finalAmount;
  h.c.escapeHtml = s => s;
  h.c.currentAdmin = { name: 'Admin' };
  h.c.firebaseUser = { email: 'admin@example.com' };
  let values = { bubbleDiscountType: 'manualCustom', bubblePaymentFinalAmount: '1000', bubbleDiscountReason: '' };
  h.c.bubbleValue = id => values[id] || '';
  let save;
  let commits = 0;
  h.c.openEditBubble = (title, body, handler) => { save = handler; };
  h.c.commitPaymentAmountAdjustment = async () => { commits++; };
  for (const name of ['updateStudentSelectedPaymentMonth','updateStudentCourseDisplay','renderStudentMobilePayment','renderAdminReceipts','renderStudentReceipts','closeEditBubble']) h.c[name] = () => {};
  vm.runInContext(source('editPaymentAmountDiscount'), h.c);
  h.c.editPaymentAmountDiscount({ closest: () => ({ getAttribute: () => 'p1' }) });

  assert.equal(await save(), false);
  assert.equal(commits, 0);
  assert.match(h.elements.editBubbleResult.textContent, /เหตุผล/);
  values = { bubbleDiscountType: 'manualCustom', bubblePaymentFinalAmount: '0', bubbleDiscountReason: 'แก้ไขยอด' };
  assert.equal(await save(), false);
  assert.equal(commits, 0);
  assert.match(h.elements.editBubbleResult.textContent, /มากกว่า 0/);
});

test('approved payment adjustment preserves approval, slip, and receipt identifiers', async () => {
  const h = setup();
  const payment = { id: 'p1', originalAmount: 2700, amount: 2700, finalAmount: 2700, status: 'ชำระแล้ว', paymentStatus: 'ชำระแล้ว', slipStatus: 'approved', slipUrl: 'https://example.com/slip.jpg', receiptId: 'r1', receiptNo: 'R001', receiptStatus: 'published' };
  h.c.payments = [payment];
  h.elements.bubblePaymentOriginalAmount = { value: '2700' };
  h.c.findPaymentByAnyId = () => payment;
  h.c.canEditPaymentAmount = () => true;
  h.c.isPaymentInActiveBundle = () => false;
  h.c.getPaymentDisplayStatus = () => 'ชำระแล้ว';
  h.c.getPaymentFinalAmount = p => p.finalAmount;
  h.c.escapeHtml = s => s;
  h.c.currentAdmin = { name: 'Admin' };
  h.c.firebaseUser = { email: 'admin@example.com' };
  h.c.bubbleValue = id => ({ bubbleDiscountType: 'manualCustom', bubblePaymentFinalAmount: '1000', bubbleDiscountReason: 'แก้ไขตามข้อตกลง' }[id] || '');
  let save;
  let committedAudit;
  h.c.openEditBubble = (title, body, handler) => { save = handler; };
  h.c.commitPaymentAmountAdjustment = async (data, amount, audit) => { committedAudit = audit; };
  for (const name of ['updateStudentSelectedPaymentMonth','updateStudentCourseDisplay','renderStudentMobilePayment','renderAdminReceipts','renderStudentReceipts','closeEditBubble']) h.c[name] = () => {};
  vm.runInContext(source('editPaymentAmountDiscount'), h.c);
  h.c.editPaymentAmountDiscount({ closest: () => ({ getAttribute: () => 'p1' }) });
  await save();
  assert.equal(payment.finalAmount, 1000);
  assert.equal(payment.status, 'ชำระแล้ว');
  assert.equal(payment.paymentStatus, 'ชำระแล้ว');
  assert.equal(payment.slipStatus, 'approved');
  assert.equal(payment.slipUrl, 'https://example.com/slip.jpg');
  assert.equal(payment.receiptId, 'r1');
  assert.equal(payment.receiptNo, 'R001');
  assert.equal(committedAudit.oldAmount, 2700);
  assert.equal(committedAudit.isHistorical, true);
});

test('payment adjustment commits payment, month override, and audit log in one atomic batch', async () => {
  const writes = [];
  let commits = 0;
  let reads = 0;
  const monthItem = { id: 'm1', month: 'กันยายน 2569', studentPrices: {} };
  const payment = { id: 'p1', studentId: 's1', month: 'กันยายน 2569', amount: 1200 };
  const c = {
    firebaseReady: true,
    PRODUCTION_MODE: true,
    firebaseUser: { uid: 'admin' },
    db: {
      collection(name) {
        return { doc(id) { return { name, id, get() { reads++; } }; } };
      },
      batch() {
        return {
          set(ref, data, options) { writes.push({ ref, data, options }); },
          async commit() { commits++; }
        };
      }
    },
    receipts: [], activityLogs: [],
    buildFirebasePayload(item, id) { return Object.assign({}, item, { firebaseDocId: id, deleted: false }); },
    createFirebaseDocId: () => 'log1',
    findReceiptLinkedToPayment: () => null,
    getPaymentFinalAmount: item => item.finalAmount || item.amount,
    formatPrice: amount => amount + ' บาท',
    getElement: () => null,
    getPaymentMonthItem: () => monthItem,
    findStudentByIdentityKey: () => ({ id: 's1', memberId: 'S001' }),
    getPrimaryStudentIdentityKey: student => student.memberId,
    getStudentIdentityKeys: () => ['s1', 'S001']
  };
  vm.createContext(c);
  vm.runInContext(source('commitPaymentAmountAdjustment'), c);
  await c.commitPaymentAmountAdjustment(payment, 1200, { oldAmount: 1500, reason: 'แก้ยอด', user: 'Admin', adjustedAtText: '28/9/2569', isHistorical: true });
  assert.equal(reads, 0);
  assert.equal(commits, 1);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map(write => write.ref.name), ['payments', 'paymentMonths', 'activityLogs']);
  assert.equal(writes[1].data.studentPrices.S001, 1200);
  assert.equal(monthItem.studentPrices.S001, 1200);
  assert.match(writes[2].data.detail, /1500 บาท → 1200 บาท/);
  assert.match(writes[2].data.detail, /เหตุผล: แก้ยอด/);
  assert.equal(c.activityLogs.length, 1);
});

test('approved payment batch updates a linked receipt without changing its status or number', async () => {
  const writes = [];
  const receipt = { id: 'r1', paymentId: 'p1', receiptNo: 'R001', status: 'published', amount: '2700' };
  const payment = { id: 'p1', status: 'ชำระแล้ว', finalAmount: 1000, receiptId: 'r1', receiptNo: 'R001' };
  const c = {
    firebaseReady: true, PRODUCTION_MODE: true, firebaseUser: { uid: 'admin' }, receipts: [receipt], activityLogs: [],
    db: {
      collection(name) { return { doc(id) { return { name, id }; } }; },
      batch() { return { set(ref, data, options) { writes.push({ ref, data, options }); }, async commit() {} }; }
    },
    buildFirebasePayload(item, id) { return Object.assign({}, item, { firebaseDocId: id, deleted: false }); },
    createFirebaseDocId: () => 'log1',
    getPaymentMonthItem: () => null,
    findReceiptLinkedToPayment: () => receipt,
    getPaymentFinalAmount: item => item.finalAmount,
    formatPrice: amount => amount + ' บาท',
    getElement: () => null
  };
  vm.createContext(c);
  vm.runInContext(source('commitPaymentAmountAdjustment'), c);
  await c.commitPaymentAmountAdjustment(payment, 1000, { oldAmount: 2700, reason: 'แก้ไขตามข้อตกลง', user: 'Admin', adjustedAtText: '28/9/2569', isHistorical: true });
  assert.deepEqual(writes.map(write => write.ref.name), ['payments', 'receipts', 'activityLogs']);
  assert.equal(writes[1].data.amount, '1000');
  assert.equal(writes[1].data.status, 'published');
  assert.equal(writes[1].data.receiptNo, 'R001');
  assert.equal(receipt.amount, '1000');
  assert.equal(receipt.status, 'published');
});

test('failed atomic adjustment leaves month, receipt, and audit collections unchanged', async () => {
  const receipt = { id: 'r1', paymentId: 'p1', amount: '2700', status: 'published' };
  const monthItem = { id: 'm1', studentPrices: { S001: 2700 } };
  const c = {
    firebaseReady: true, PRODUCTION_MODE: true, firebaseUser: { uid: 'admin' }, receipts: [receipt], activityLogs: [],
    db: {
      collection(name) { return { doc(id) { return { name, id }; } }; },
      batch() { return { set() {}, async commit() { throw new Error('batch failed'); } }; }
    },
    buildFirebasePayload(item, id) { return Object.assign({}, item, { firebaseDocId: id, deleted: false }); },
    createFirebaseDocId: () => 'log1',
    getPaymentMonthItem: () => monthItem,
    findStudentByIdentityKey: () => ({ id: 's1', memberId: 'S001' }),
    getPrimaryStudentIdentityKey: student => student.memberId,
    getStudentIdentityKeys: () => ['s1', 'S001'],
    findReceiptLinkedToPayment: () => receipt,
    getPaymentFinalAmount: item => item.finalAmount,
    formatPrice: String,
    getElement: () => null
  };
  vm.createContext(c);
  vm.runInContext(source('commitPaymentAmountAdjustment'), c);
  await assert.rejects(c.commitPaymentAmountAdjustment({ id: 'p1', studentId: 's1', month: 'กันยายน 2569', finalAmount: 1000 }, 1000, { oldAmount: 2700, reason: 'แก้ไข' }), /batch failed/);
  assert.equal(monthItem.studentPrices.S001, 2700);
  assert.equal(receipt.amount, '2700');
  assert.equal(c.activityLogs.length, 0);
});

test('linked receipt lookup supports receipt number and legacy identity matching', () => {
  const payment = { id: 'p1', receiptNo: 'R001' };
  const byNumber = { id: 'r1', receiptNo: 'R001' };
  const legacy = { id: 'r2' };
  const c = { receipts: [byNumber], findPaymentForReceipt: () => null };
  vm.createContext(c);
  vm.runInContext(source('findReceiptLinkedToPayment'), c);
  assert.equal(c.findReceiptLinkedToPayment(payment), byNumber);
  c.receipts = [legacy];
  c.findPaymentForReceipt = receipt => receipt === legacy ? payment : null;
  assert.equal(c.findReceiptLinkedToPayment(payment), legacy);
});

test('paid standalone rows show edit amount while active bundle rows stay locked', () => {
  const paid = { id: 'p1', status: 'ชำระแล้ว' };
  const c = {
    payments: [paid],
    getPaymentDisplayStatus: () => 'ชำระแล้ว',
    getPaymentBundleForPayment: () => null,
    paymentHasOcrData: () => false,
    canMovePaymentSlipToAnotherMonth: () => false,
    canDeletePaymentSlip: () => false,
    canEditPaymentAmount: () => true,
    actionCall: () => 'noop()',
    formatPrice: String
  };
  vm.createContext(c);
  vm.runInContext(source('paymentActionButtons'), c);
  assert.match(c.paymentActionButtons('ชำระแล้ว', 'p1'), /editPaymentAmountDiscount/);
  c.getPaymentBundleForPayment = () => ({ id: 'b1', status: 'ชำระแล้ว' });
  assert.doesNotMatch(c.paymentActionButtons('ชำระแล้ว', 'p1'), /editPaymentAmountDiscount/);
});

test('retroactive amount edit requires finance permission and rejects active bundles', () => {
  const payment = { id: 'p1', status: 'ชำระแล้ว', slipStatus: 'approved' };
  const c = {
    allowed: true,
    bundled: false,
    canAdjustPaymentAmount: () => false,
    getPaymentDisplayStatus: () => 'ชำระแล้ว'
  };
  c.hasPermission = key => c.allowed && key === 'admin.finance';
  c.isPaymentInActiveBundle = () => c.bundled;
  vm.createContext(c);
  vm.runInContext(source('canEditPaymentAmount'), c);
  assert.equal(c.canEditPaymentAmount(payment), true);
  c.allowed = false;
  assert.equal(c.canEditPaymentAmount(payment), false);
  c.allowed = true;
  c.bundled = true;
  assert.equal(c.canEditPaymentAmount(payment), false);
});

test('edit bubble accepts only one save while an async write is pending', async () => {
  let resolveSave;
  let saveCalls = 0;
  const saveButton = { disabled: false, textContent: 'บันทึกการแก้ไข' };
  const result = { textContent: '', style: {} };
  const c = {
    console: { error() {} },
    clearTimeout() {},
    getElement(id) {
      if (id === 'editBubbleSaveButton') return saveButton;
      if (id === 'editBubbleResult') return result;
      return null;
    },
    window: { setTimeout() {} }
  };
  vm.createContext(c);
  const start = html.indexOf('    let editBubbleSaveHandler = null;');
  const end = html.indexOf('    function getMonthlySessionStatusLabel(', start);
  vm.runInContext(html.slice(start, end), c);
  c.pendingSave = new Promise(resolve => { resolveSave = resolve; });
  vm.runInContext("editBubbleSaveHandler = function() { saveCalls(); return pendingSave; }", Object.assign(c, {
    saveCalls() { saveCalls++; }
  }));

  const first = c.saveEditBubble();
  const second = c.saveEditBubble();
  assert.equal(saveCalls, 1);
  assert.equal(first, second);
  assert.equal(saveButton.disabled, true);
  resolveSave();
  await first;
  assert.equal(saveButton.disabled, false);
});

test('overdue filter runs against status before table pagination', () => {
  const h = setup();
  h.elements.paymentOverdueDayFilter = { value: '15' };
  h.c.payments = [
    { id: 'old-unpaid', memberId: '1', status: 'ค้างชำระ', days: 20 },
    { id: 'old-paid', memberId: '2', status: 'ชำระแล้ว', days: 20 },
    { id: 'new-unpaid', memberId: '3', status: 'ค้างชำระ', days: 5 }
  ];
  h.c.getPaymentStudentRecord = () => null; h.c.gradeOrder = () => 0; h.c.getOverdueDays = p => p.days;
  vm.runInContext(source('getFilteredPaymentsForTable'), h.c);
  assert.deepEqual(Array.from(h.c.getFilteredPaymentsForTable(), p => p.id), ['old-unpaid']);
  h.elements.paymentOverdueDayFilter.value = 'ทั้งหมด';
  assert.equal(h.c.getFilteredPaymentsForTable().length, 3);
});

test('cancelled payments are removed from active finance lists and expected totals', () => {
  const c = {
    payments: [
      { id: 'active', month: 'ตุลาคม 2569', amount: 3000, status: 'รอชำระเงิน' },
      { id: 'cancelled', month: 'ตุลาคม 2569', amount: 3000, status: 'ยกเลิก', paymentStatus: 'ยกเลิก', slipStatus: 'cancelled' }
    ],
    getPaymentDashboardFilterScope: () => ({ month: 'ทั้งหมด', location: 'ทั้งหมด', grade: 'ทั้งหมด', status: 'ทั้งหมด', keyword: '' }),
    paymentMatchesDashboardScope: () => true,
    getPaymentFinalAmount: payment => payment.amount
  };
  vm.createContext(c);
  vm.runInContext(source('isCoursePaymentCancelled'), c);
  vm.runInContext(source('getDashboardScopedPayments'), c);
  vm.runInContext(source('getExpectedMonthlyIncome'), c);
  assert.deepEqual(Array.from(c.getDashboardScopedPayments(true), payment => payment.id), ['active']);
  assert.equal(c.getExpectedMonthlyIncome('ตุลาคม 2569'), 3000);
});

test('payment export includes nickname and only the currently filtered rows', () => {
  let exported;
  const c = {
    payments: [
      { id: 'p1', student: 'สมชาย', nickname: 'ชาย', course: 'Math', month: 'กันยายน 2569', amount: 1200 },
      { id: 'p2', student: 'สมหญิง', studentId: 's2', course: 'Science', month: 'กันยายน 2569', amount: 1500 },
      { id: 'hidden', student: 'ไม่ควรถูกส่งออก', course: 'English', month: 'สิงหาคม 2569', amount: 900 }
    ],
    getFilteredPaymentsForTable: () => c.payments.filter(payment => payment.id !== 'hidden'),
    getPaymentStudentRecord: payment => payment.id === 'p2' ? { id: 's2', name: 'สมหญิง', nickname: 'หญิง' } : null,
    downloadCsv: (filename, rows) => { exported = { filename, rows }; },
    addActivityLog() {}
  };
  vm.createContext(c);
  vm.runInContext(source('exportPaymentsCsv'), c);
  c.exportPaymentsCsv();
  assert.equal(exported.filename, 'idea-club-payments.csv');
  assert.equal(exported.rows[0][1], 'ชื่อเล่น');
  assert.equal(exported.rows[1][1], 'ชาย');
  assert.equal(exported.rows[2][1], 'หญิง');
  assert.equal(exported.rows.length, 3);
});

function setupTuitionNotices() {
  const students = [
    { id: 's1', authUid: 'u1', memberId: '001', name: 'สมชาย', grade: 'ป.4' },
    { id: 's2', authUid: 'u2', memberId: '002', name: 'สมหญิง', grade: 'ป.5' }
  ];
  const c = {
    students,
    systemSettings: { instituteName: 'IDEA CLUB', phone: '0812345678' },
    getFilteredPaymentsForTable: () => c.payments,
    getPaymentDisplayStatus: payment => payment.status || 'รอชำระเงิน',
    isCoursePaymentCancelled: payment => payment.status === 'ยกเลิก',
    getPaymentStudentRecord: payment => students.find(student => student.id === payment.studentId) || null,
    getUniqueStudentRecordByPaymentName: payment => {
      const matches = students.filter(student => student.name === payment.student);
      return matches.length === 1 ? matches[0] : null;
    },
    getCourseByPaymentStudentOrName: payment => ({ location: payment.center || '' }),
    getPaymentCenterTextForQr: payment => payment.center || '',
    getPaymentCenterKey: value => String(value || '').includes('หนองฉาง') ? 'nongchang' : String(value || '').includes('นครสวรรค์') ? 'nakhonsawan' : '',
    getPaymentQrImageSrcForContext: payment => payment.qr || '',
    getPaymentFinalAmount: payment => payment.finalAmount ?? payment.amount ?? 0,
    normalizeText: value => String(value || '').trim().replace(/\s+/g, ' '),
    gradeOrder: grade => ['ป.4', 'ป.5'].indexOf(grade),
    escapeHtml: value => String(value ?? ''),
    formatPrice: value => Number(value).toLocaleString('th-TH') + ' บาท',
    getPrintableLogoHtml: () => '<div>LOGO</div>',
    Set,
    Date
  };
  vm.createContext(c);
  for (const name of ['getTuitionNoticeIdentityKeys','isTuitionNoticePrintablePayment','buildTuitionNoticeGroups','getTuitionNoticePreviewSummary','tuitionNoticeHtml']) {
    vm.runInContext(source(name), c);
  }
  return c;
}

test('tuition notices include only unpaid states and group one student per center', () => {
  const c = setupTuitionNotices();
  c.payments = [
    { id: 'p1', studentId: 's1', student: 'สมชาย', center: 'IDEA CLUB ศูนย์ นครสวรรค์', course: 'Math', month: 'ตุลาคม 2569', amount: 1200, status: 'รอชำระเงิน', qr: 'qr-a' },
    { id: 'p2', studentId: 's1', student: 'สมชาย', center: 'IDEA CLUB ศูนย์ นครสวรรค์', course: 'Science', month: 'ตุลาคม 2569', finalAmount: 900, amount: 1500, status: 'สลิปไม่ผ่าน', qr: 'qr-a' },
    { id: 'p3', studentId: 's1', student: 'สมชาย', center: 'IDEA CLUB ศูนย์ หนองฉาง', course: 'English', month: 'ตุลาคม 2569', amount: 800, status: 'ค้างชำระ', qr: 'qr-b' },
    { id: 'paid', studentId: 's1', center: 'IDEA CLUB ศูนย์ นครสวรรค์', amount: 500, status: 'ชำระแล้ว' },
    { id: 'review', studentId: 's1', center: 'IDEA CLUB ศูนย์ นครสวรรค์', amount: 500, status: 'รอตรวจสลิป' },
    { id: 'deleted', studentId: 's1', center: 'IDEA CLUB ศูนย์ นครสวรรค์', amount: 500, status: 'รอชำระเงิน', deleted: true }
  ];
  const groups = c.buildTuitionNoticeGroups();
  assert.equal(groups.length, 2);
  assert.deepEqual(Array.from(groups, group => group.payments.length), [2, 1]);
  assert.deepEqual(Array.from(groups, group => group.totalAmount), [2100, 800]);
  assert.deepEqual(Array.from(groups, group => group.qrSrc), ['qr-a', 'qr-b']);
});

test('tuition notices use unique legacy names but never merge ambiguous nameless identities', () => {
  const c = setupTuitionNotices();
  c.students.push({ id: 's3', name: 'ชื่อซ้ำ', grade: 'ป.4' }, { id: 's4', name: 'ชื่อซ้ำ', grade: 'ป.4' });
  c.payments = [
    { id: 'legacy-1', student: 'สมหญิง', center: 'IDEA CLUB ศูนย์ นครสวรรค์', amount: 1000, status: 'รอชำระเงิน' },
    { id: 'legacy-2', student: 'สมหญิง', center: 'IDEA CLUB ศูนย์ นครสวรรค์', amount: 900, status: 'ค้างชำระ' },
    { id: 'duplicate-1', student: 'ชื่อซ้ำ', center: 'IDEA CLUB ศูนย์ นครสวรรค์', amount: 800, status: 'รอชำระเงิน' },
    { id: 'duplicate-2', student: 'ชื่อซ้ำ', center: 'IDEA CLUB ศูนย์ นครสวรรค์', amount: 700, status: 'รอชำระเงิน' }
  ];
  const groups = c.buildTuitionNoticeGroups();
  assert.equal(groups.length, 3);
  assert.equal(groups.find(group => group.studentName === 'สมหญิง').payments.length, 2);
  assert.equal(groups.filter(group => group.studentName === 'ชื่อซ้ำ').length, 2);
});

test('tuition notice summary counts students once across centers and marks missing QR', () => {
  const c = setupTuitionNotices();
  c.payments = [
    { id: 'a', studentId: 's1', student: 'สมชาย', center: 'IDEA CLUB ศูนย์ นครสวรรค์', course: 'Math', amount: 1000, status: 'รอชำระเงิน', qr: 'qr-a' },
    { id: 'b', studentId: 's1', student: 'สมชาย', center: 'IDEA CLUB ศูนย์ หนองฉาง', course: 'Science', amount: 500, status: 'ค้างชำระ' }
  ];
  const groups = c.buildTuitionNoticeGroups();
  const summary = c.getTuitionNoticePreviewSummary(groups);
  assert.deepEqual({ ...summary }, { noticeCount: 2, studentCount: 1, totalAmount: 1500, missingQr: 1 });
  assert.match(c.tuitionNoticeHtml(groups[1]), /ยังไม่ได้ตั้งค่า QR Code/);
});

test('payment toolbar exposes the bulk tuition notice action', () => {
  assert.match(html, /onclick="downloadFilteredTuitionNoticesPdf\(\)"[^>]*>ดาวน์โหลด PDF ใบแจ้งยอดค่าเรียน</);
});

test('bulk tuition PDF renders exactly one A4 page per notice group', async () => {
  const calls = { addPage: 0, addImage: 0, saved: '' };
  class FakePdf {
    addPage() { calls.addPage++; }
    addImage() { calls.addImage++; }
    save(name) { calls.saved = name; }
  }
  const target = { offsetWidth: 794, offsetHeight: 1123, scrollHeight: 1123 };
  const element = { querySelectorAll: () => [], querySelector: () => target };
  const c = {
    ensureExportLibraries: async () => true,
    window: {
      html2canvas: async () => ({ width: 1588, height: 2246, toDataURL: () => 'data:image/jpeg;base64,test' }),
      jspdf: { jsPDF: FakePdf }
    },
    document: { body: { appendChild() {}, removeChild() {} } },
    buildPdfDocumentElement: () => element,
    tuitionNoticeHtml: group => group.html,
    waitForTuitionNoticeImages: async () => [],
    pdfFileName: name => name,
    alert() {},
    console
  };
  vm.createContext(c);
  vm.runInContext(source('downloadTuitionNoticesPdf'), c);
  await c.downloadTuitionNoticesPdf([{ html: 'first' }, { html: 'second' }], 'notices.pdf');
  assert.equal(calls.addImage, 2);
  assert.equal(calls.addPage, 1);
  assert.equal(calls.saved, 'notices.pdf');
});

test('tuition notice image wait decodes an already loaded first-page QR before capture', async () => {
  let decoded = false;
  const image = {
    complete: true,
    naturalWidth: 900,
    decode: async () => { decoded = true; }
  };
  const c = { Array, Promise };
  vm.createContext(c);
  vm.runInContext(source('waitForTuitionNoticeImages'), c);
  await c.waitForTuitionNoticeImages({ querySelectorAll: () => [image] });
  assert.equal(decoded, true);
});

test('tuition notice download requires finance permission and a selected month', () => {
  const alerts = [];
  let allowed = false;
  let month = 'ตุลาคม 2569';
  let builds = 0;
  const c = {
    hasPermission: () => allowed,
    alert: message => alerts.push(message),
    getElement: () => ({ value: month }),
    buildTuitionNoticeGroups: () => { builds++; return []; }
  };
  vm.createContext(c);
  vm.runInContext(source('downloadFilteredTuitionNoticesPdf'), c);
  c.downloadFilteredTuitionNoticesPdf();
  assert.equal(builds, 0);
  assert.equal(alerts.pop(), 'ไม่มีสิทธิ์');
  allowed = true;
  month = 'ทั้งหมด';
  c.downloadFilteredTuitionNoticesPdf();
  assert.equal(builds, 0);
  assert.equal(alerts.pop(), 'กรุณาเลือกเดือนที่ต้องการดาวน์โหลดใบแจ้งยอดก่อน');
});

test('tuition notice toolbar downloads the filtered groups without opening a preview', async () => {
  const groups = [{ key: 's1|center-a' }];
  let downloaded;
  const c = {
    hasPermission: () => true,
    alert() {},
    getElement: () => ({ value: 'ตุลาคม 2569' }),
    buildTuitionNoticeGroups: () => groups,
    getTuitionNoticePreviewSummary: () => ({ missingQr: 0 }),
    getSafeFileName: value => value,
    downloadTuitionNoticesPdf: async (items, filename) => { downloaded = { items, filename }; }
  };
  vm.createContext(c);
  vm.runInContext(source('downloadFilteredTuitionNoticesPdf'), c);
  await c.downloadFilteredTuitionNoticesPdf();
  assert.equal(downloaded.items, groups);
  assert.equal(downloaded.filename, 'tuition-notices-ตุลาคม 2569.pdf');
});

test('monthly payment targets exclude enrollments whose course has completed', () => {
  const completedCourse = { id: 'course-ended', courseEndStatus: 'completed_manually', status: 'closed' };
  const activeCourse = { id: 'course-active', courseEndStatus: 'scheduled', status: 'open' };
  const student = { id: 'student-1', name: 'นักเรียนทดสอบ', status: 'เรียนอยู่' };
  const enrollments = [
    { courseId: completedCourse.id, courseStatus: 'อนุมัติแล้ว', enrollmentStatus: 'active' },
    { courseId: activeCourse.id, courseStatus: 'อนุมัติแล้ว', enrollmentStatus: 'active' }
  ];
  const c = {
    students: [student],
    getStudentCourseEnrollments: () => enrollments,
    getCourseForEnrollment: enrollment => enrollment.courseId === completedCourse.id ? completedCourse : activeCourse
  };
  vm.createContext(c);
  vm.runInContext(source('isCourseCompletedForBilling'), c);
  vm.runInContext(source('isCourseEnrollmentBillable'), c);
  vm.runInContext(source('getMonthlyPaymentTargetStudents'), c);
  const targets = c.getMonthlyPaymentTargetStudents();
  assert.deepEqual(Array.from(targets, target => target.courseId), ['course-active']);
});

test('preview deletion removes only an unlocked payment record', async () => {
  const payment = { id: 'payment-1', student: 'นักเรียนทดสอบ', month: 'ตุลาคม 2569', status: 'รอชำระเงิน' };
  const student = { id: 'student-1', name: 'นักเรียนทดสอบ' };
  const calls = [];
  const result = { textContent: '', style: {} };
  const c = {
    payments: [payment],
    findStudentByIdentityKey: () => student,
    findPaymentForStudentMonth: () => payment,
    isPaymentRecordUpdatable: () => true,
    confirm: () => true,
    deleteFirebaseDocument: async (collection, record) => calls.push(['delete', collection, record.id]),
    addActivityLog: (action, detail) => calls.push(['log', action, detail]),
    getElement: id => id === 'paymentRecordPreviewResult' ? result : null,
    renderPaymentRecordPreview: message => calls.push(['preview', message]),
    renderPaymentTable: () => calls.push(['table']),
    renderAdminDashboard: () => calls.push(['dashboard']),
    updateStudentSelectedPaymentMonth: () => {},
    updateStudentCourseDisplay: () => {},
    renderDashboardPaymentSummary: () => {},
    console: { error() {} }
  };
  vm.createContext(c);
  vm.runInContext(source('deleteStudentMonthPayment'), c);
  await c.deleteStudentMonthPayment('ตุลาคม 2569', 'student-1');
  assert.deepEqual(Array.from(c.payments), []);
  assert.deepEqual(calls[0], ['delete', 'payments', 'payment-1']);
  assert.ok(calls.some(call => call[0] === 'preview'));
});
