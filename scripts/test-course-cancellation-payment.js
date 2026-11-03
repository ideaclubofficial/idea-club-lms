const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function functionSource(name) {
  const match = new RegExp('^    (?:async )?function ' + name + '\\(', 'm').exec(html);
  assert.ok(match, 'missing function ' + name);
  return html.slice(match.index, html.indexOf('\n    }', match.index) + 6);
}

function createContext() {
  const context = {
    payments: [],
    normalizeTextValue(value) { return String(value || '').trim().replace(/\s+/g, ' '); },
    parseRecordDate() { return null; },
    getThaiMonthFromDate() { return ''; },
    getPaymentBundleForPayment(payment) { return payment && payment.bundle || null; },
    getPaymentBundleDisplayStatus(bundle) { return bundle && bundle.status || ''; },
    findReceiptLinkedToPayment(payment) { return payment && payment.receipt || null; }
  };
  vm.createContext(context);
  [
    'getCourseCancellationPaymentMonth',
    'isCoursePaymentCancelled',
    'courseCancellationPaymentMatchesStudent',
    'courseCancellationPaymentMatchesCourse',
    'getCourseCancellationRegisteredMonth',
    'resolveCourseCancellationFinancials'
  ].forEach(name => vm.runInContext(functionSource(name), context));
  return context;
}

test('cancellation resolves only the registration-month payment for the same student and course', () => {
  const context = createContext();
  const student = { id: 'student-1', memberId: 'IC001', name: 'Student' };
  const enrollment = { courseId: 'course-a', courseName: 'Course A', registeredCourseMonth: 'ตุลาคม 2569' };
  const target = { id: 'pay-target', studentId: 'student-1', courseId: 'course-a', month: 'ตุลาคม 2569' };
  context.payments.push(
    target,
    { id: 'other-month', studentId: 'student-1', courseId: 'course-a', month: 'พฤศจิกายน 2569' },
    { id: 'other-course', studentId: 'student-1', courseId: 'course-b', month: 'ตุลาคม 2569' },
    { id: 'other-student', studentId: 'student-2', courseId: 'course-a', month: 'ตุลาคม 2569' }
  );
  const result = context.resolveCourseCancellationFinancials(student, enrollment, { id: 'course-a', name: 'Course A' });
  assert.equal(result.error, '');
  assert.equal(result.payment.id, 'pay-target');
  assert.equal(result.month, 'ตุลาคม 2569');
});

test('legacy payment without courseId matches only an exact normalized course name', () => {
  const context = createContext();
  const student = { memberId: 'IC001', name: 'Student' };
  const enrollment = { courseId: 'course-a', courseName: 'Course A', registeredCourseMonth: 'ตุลาคม 2569' };
  context.payments.push(
    { id: 'legacy-match', memberId: 'IC001', course: ' Course   A ', month: 'ตุลาคม 2569' },
    { id: 'legacy-wrong', memberId: 'IC001', course: 'Course AB', month: 'ตุลาคม 2569' }
  );
  const result = context.resolveCourseCancellationFinancials(student, enrollment, { id: 'course-a', name: 'Course A' });
  assert.equal(result.payment.id, 'legacy-match');
});

test('missing registration month blocks when more than one course payment exists', () => {
  const context = createContext();
  const student = { id: 'student-1', name: 'Student' };
  const enrollment = { courseId: 'course-a', courseName: 'Course A' };
  context.payments.push(
    { id: 'one', studentId: 'student-1', courseId: 'course-a', month: 'ตุลาคม 2569' },
    { id: 'two', studentId: 'student-1', courseId: 'course-a', month: 'พฤศจิกายน 2569' }
  );
  const result = context.resolveCourseCancellationFinancials(student, enrollment, { id: 'course-a', name: 'Course A' });
  assert.equal(result.error, 'ambiguous-month');
  assert.equal(result.payment, undefined);
});

test('modern enrollment does not borrow a legacy month from the current student projection', () => {
  const context = createContext();
  const student = { id: 'student-1', name: 'Student', registeredCourseMonth: 'กันยายน 2569' };
  const enrollment = { courseId: 'course-a', courseName: 'Course A' };
  context.payments.push({ id: 'only', studentId: 'student-1', courseId: 'course-a', month: 'ตุลาคม 2569' });
  const result = context.resolveCourseCancellationFinancials(student, enrollment, { id: 'course-a', name: 'Course A' });
  assert.equal(result.error, '');
  assert.equal(result.month, 'ตุลาคม 2569');
  assert.equal(result.payment.id, 'only');
});

test('active payment bundle blocks cancellation without selecting a payment for mutation', () => {
  const context = createContext();
  const student = { id: 'student-1', name: 'Student' };
  const enrollment = { courseId: 'course-a', courseName: 'Course A', registeredCourseMonth: 'ตุลาคม 2569' };
  context.payments.push({
    id: 'bundled', studentId: 'student-1', courseId: 'course-a', month: 'ตุลาคม 2569',
    bundle: { id: 'bundle-1', status: 'รอตรวจสลิป' }
  });
  const result = context.resolveCourseCancellationFinancials(student, enrollment, { id: 'course-a', name: 'Course A' });
  assert.equal(result.error, 'active-bundle');
  assert.equal(result.bundle.id, 'bundle-1');
});

test('a second cancellation ignores the preserved payment from the previous cancelled attempt', () => {
  const context = createContext();
  const student = { id: 'student-1', name: 'Student' };
  const enrollment = { courseId: 'course-a', courseName: 'Course A', registeredCourseMonth: 'ตุลาคม 2569' };
  context.payments.push(
    { id: 'old-cancelled', studentId: 'student-1', courseId: 'course-a', month: 'ตุลาคม 2569', status: 'ยกเลิก', slipStatus: 'cancelled' },
    { id: 'new-active', studentId: 'student-1', courseId: 'course-a', month: 'ตุลาคม 2569', status: 'รอชำระเงิน' }
  );
  const result = context.resolveCourseCancellationFinancials(student, enrollment, { id: 'course-a', name: 'Course A' });
  assert.equal(result.error, '');
  assert.equal(result.payment.id, 'new-active');
});

test('cancellation implementation is atomic, permission guarded, and preserves cancelled audit records', () => {
  const cancelSource = functionSource('cancelStudentCourse');
  assert.match(cancelSource, /hasPermission\('admin\.finance'\)/);
  assert.match(cancelSource, /db\.runTransaction/);
  assert.match(cancelSource, /status: 'ยกเลิก'/);
  assert.match(cancelSource, /slipStatus: 'cancelled'/);
  assert.match(cancelSource, /status: 'cancelled'/);
  assert.match(cancelSource, /cancellationReason: 'wrong_course_enrollment'/);
  assert.match(cancelSource, /course-enrollment-already-cancelled/);
  assert.match(cancelSource, /const enrollmentSnap = await transaction\.get\(enrollmentRef\)[\s\S]*const studentSnap = await transaction\.get\(studentRef\)[\s\S]*const paymentSnap = paymentRef \? await transaction\.get\(paymentRef\)/);
  assert.doesNotMatch(cancelSource, /Promise\.all\([\s\S]*transaction\.get/);
  assert.doesNotMatch(cancelSource, /deleteFirebaseDocument\('payments'/);
  assert.doesNotMatch(cancelSource, /deleteFirebaseDocument\('receipts'/);
});

test('cancelled receipts remain distinct from manually hidden receipts', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('normalizeReceiptStatus'), context);
  assert.equal(context.normalizeReceiptStatus('cancelled'), 'cancelled');
  assert.equal(context.normalizeReceiptStatus('hidden'), 'hidden');
});

test('single-student enrollment screen moves current-course cancellation into the detail bubble', () => {
  const renderSource = functionSource('renderAdminCourseEnrollmentSection');
  const bubbleSource = functionSource('openAdminStudentCoursesBubble');
  const cancelFromBubbleSource = functionSource('cancelStudentCourseFromBubble');
  assert.match(renderSource, /actionCall\('openAdminStudentCoursesBubble', studentId\)/);
  assert.doesNotMatch(renderSource, /actionCall\('cancelStudentCourse'/);
  assert.match(bubbleSource, /isCourseEnrollmentCurrent\(enrollment\)/);
  assert.match(bubbleSource, /actionCall\('cancelStudentCourseFromBubble', id, courseId\)/);
  assert.match(bubbleSource, />ยกเลิกคอร์ส<\/button>/);
  assert.match(cancelFromBubbleSource, /closeEditBubble\(\);[\s\S]*cancelStudentCourse\(id, courseId\)/);
  assert.match(html, /ลงคอร์สผิด:[\s\S]*ยกเลิกยอดเดือนที่สมัครพร้อมกัน/);
});
