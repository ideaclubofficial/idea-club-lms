const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('    async function uploadStudentSlipToDrive()'), html.indexOf('    async function uploadStudentSlipWithOcr()'));

async function upload({ denied = false, missing = false } = {}) {
  const payment = { id: 'bill', firebaseDocId: 'bill', month: 'September', amount: 750, discount: 250, createdAt: { seconds: 123 }, status: 'รอชำระเงิน' };
  const student = { id: 'student', authUid: 'stale-uid', memberId: '001', name: 'Student', paymentStatus: 'รอชำระเงิน' };
  const calls = [];
  const result = { classList: { remove() {} }, style: {} };
  const elements = { studentSlipResult: result, studentPaymentMonth: { value: 'September' }, studentSlipFile: { files: [{ name: 'slip.jpg', type: 'image/jpeg', size: 1 }] } };
  const context = {
    console: { error() {}, warn() {} },
    currentStudent: student, payments: missing ? [] : [payment], firebaseUser: { uid: 'session-uid' },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'timestamp' } } },
    slipUploadInProgress: false, ENABLE_PAYMENT_SLIP_WEB_UPLOAD: true, USE_APPS_SCRIPT_DRIVE_UPLOAD: true,
    getElement: id => elements[id], isStudentLimitedAccess: () => false,
    canStudentUploadSlipForMonth: () => true, isPaymentMonthVisibleByName: () => true,
    getCurrentStudentPaymentForSelectedMonth: () => missing ? null : payment,
    getCourseByStudentOrName: () => ({}), getCourseByPaymentStudentOrName: () => ({}),
    buildStudentMonthlyPaymentRecord: () => ({ id: 'new-bill', firebaseDocId: 'new-bill', month: 'September', amount: 750 }),
    createFirebaseDocId: () => 'fallback-bill',
    document: { querySelectorAll: () => [] }, fileToBase64: async () => 'image',
    uploadFileToDriveViaAppsScript: async () => ({ fileId: 'drive-original', fileUrl: 'https://example.com/slip' }),
    getPaymentUploadCenterText: () => 'Center', getPaymentSlipUploadStudentName: () => 'Student',
    getStudentRecordDocId: () => 'student', getActiveProfileDisplayInfo: () => ({ displayName: 'Student' }),
    buildFirebasePayload: (data, id) => ({ ...data, firebaseDocId: id, deleted: false, updatedAt: 'timestamp' }),
    setStudentSlipResultMessage: message => { result.textContent = message; },
    db: { collection: collection => ({ doc: id => {
      const save = async (method, data) => {
        calls.push({ collection, id, method, data });
        if (denied && collection === 'payments' && id === 'bill') throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      };
      return { set: data => save('set', data), update: data => save('update', data) };
    } }) }
  };
  for (const name of ['syncStudentSlipDropzoneLabel', 'updateStudentSlipUploadControls', 'updateStudentCourseDisplay', 'renderPaymentTable', 'updatePaymentSummary', 'renderAdminDashboard', 'scheduleAdminPaymentDataRefresh']) context[name] = () => {};
  vm.createContext(context);
  await vm.runInContext(source + '\nuploadStudentSlipToDrive()', context);
  return { calls, payment, student, context, result };
}

test('existing bill receives only slip fields; original amount and timestamps stay intact', async () => {
  const { calls, payment } = await upload();
  const writes = calls.filter(call => call.collection === 'payments');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 'bill');
  assert.equal(writes[0].method, 'update');
  for (const key of ['amount', 'discount', 'createdAt', 'month']) assert.equal(key in writes[0].data, false, key);
  assert.equal(writes[0].data.slipUploadedByUid, 'session-uid');
  assert.equal(writes[0].data.authUid, 'session-uid');
  assert.equal(payment.status, 'รอตรวจสลิป');
  assert.equal(payment.amount, 750);
});

test('permission denied never creates another bill or marks local upload successful', async () => {
  const { calls, payment, student, context, result } = await upload({ denied: true });
  assert.equal(calls.filter(call => call.collection === 'payments').length, 1);
  assert.equal(payment.status, 'รอชำระเงิน');
  assert.equal(payment.driveFileId, undefined);
  assert.equal(student.paymentStatus, 'รอชำระเงิน');
  assert.equal(context.payments.length, 1);
  assert.match(result.textContent, /บันทึกสถานะในระบบไม่สำเร็จ/);
});

test('visible month with no bill retains lazy creation and the same Drive file', async () => {
  const { calls, context } = await upload({ missing: true });
  const writes = calls.filter(call => call.collection === 'payments');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 'new-bill');
  assert.equal(writes[0].data.driveFileId, 'drive-original');
  assert.equal(context.payments.length, 1);
});
