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
  h.c.findPaymentByAnyId = () => payment; h.c.canAdjustPaymentAmount = () => true;
  h.c.getPaymentFinalAmount = p => p.amount; h.c.escapeHtml = s => s;
  h.c.currentAdmin = { name: 'Admin' }; h.c.firebaseUser = { email: 'admin@example.com' };
  h.c.bubbleValue = id => ({ bubbleDiscountType: 'manualCustom', bubblePaymentFinalAmount: '1200' }[id] || '');
  let save;
  h.c.openEditBubble = (title, body, handler) => { save = handler; };
  h.c.setFirebaseDocument = async (collection, data) => writes.push({ collection, data: { ...data } });
  for (const name of ['syncPaymentAmountToStudentMonthPrice','addActivityLog','updateStudentSelectedPaymentMonth','updateStudentCourseDisplay','renderStudentMobilePayment','closeEditBubble']) h.c[name] = () => {};
  vm.runInContext(source('editPaymentAmountDiscount'), h.c);
  h.c.editPaymentAmountDiscount({ closest: () => ({ getAttribute: () => 'p1' }) });
  await save(); await h.flush();
  assert.equal(writes[0].data.finalAmount, 1200);
  assert.equal(writes[0].data.discount, 300);
  assert.equal(h.elements.expectedAmountThisMonth.textContent, '1200');
  assert.equal(h.counts.updatePaymentSummary, 1);
});

test('failed custom amount write keeps the bubble open and restores the prior amount', async () => {
  const h = setup(), payment = { id: 'p1', originalAmount: 1500, amount: 1500, status: 'ค้างชำระ' };
  h.c.payments = [payment];
  h.elements.bubblePaymentOriginalAmount = { value: '1500' };
  h.c.findPaymentByAnyId = () => payment;
  h.c.canAdjustPaymentAmount = () => true;
  h.c.getPaymentFinalAmount = p => p.amount;
  h.c.escapeHtml = s => s;
  h.c.currentAdmin = { name: 'Admin' };
  h.c.firebaseUser = { email: 'admin@example.com' };
  h.c.bubbleValue = id => ({ bubbleDiscountType: 'manualCustom', bubblePaymentFinalAmount: '1200' }[id] || '');
  let save;
  let closeCalls = 0;
  h.c.openEditBubble = (title, body, handler) => { save = handler; };
  h.c.setFirebaseDocument = async () => { throw new Error('network unavailable'); };
  h.c.syncPaymentAmountToStudentMonthPrice = () => { throw new Error('must not sync after failed payment write'); };
  for (const name of ['addActivityLog','updateStudentSelectedPaymentMonth','updateStudentCourseDisplay','renderStudentMobilePayment']) h.c[name] = () => {};
  h.c.closeEditBubble = () => { closeCalls++; };
  vm.runInContext(source('editPaymentAmountDiscount'), h.c);
  h.c.editPaymentAmountDiscount({ closest: () => ({ getAttribute: () => 'p1' }) });

  await assert.rejects(save(), /network unavailable/);
  assert.equal(payment.amount, 1500);
  assert.equal(payment.originalAmount, 1500);
  assert.equal(closeCalls, 0);
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
