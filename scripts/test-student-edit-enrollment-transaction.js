const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const helperStart = html.indexOf('    function getEditedStudentUserProfilePatch(');
const helperEnd = html.indexOf('    function canManageAdminCourseEnrollments(', helperStart);
const transactionSource = html.slice(helperStart, helperEnd);

function createHarness(options = {}) {
  const reads = [];
  const writes = [];
  const enrollmentData = options.enrollment || null;
  const paymentData = options.payment || null;
  const refs = {};
  const context = {
    firebaseReady: true,
    firestoreQuotaBlocked: false,
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'server-time' } } },
    canManageAdminCourseEnrollments: () => true,
    hasPermission: permission => permission === 'admin.finance',
    createAdminEnrollmentError(code, message) { const error = new Error(message); error.code = code; return error; },
    getEnrollmentStudentId: student => student.id,
    getCourseEnrollmentDocId: (studentId, courseId) => studentId + '__' + courseId,
    getFirebaseAuditUser: () => ({ uid: 'admin-1', displayName: 'Admin' }),
    isCourseOpenForEnrollment: course => course.status === 'open' && !course.courseEndedAtMs,
    courseMatchesLocation: (course, location) => (course.locations || [course.location]).includes(location),
    isCourseStatusApproved: status => status === 'อนุมัติแล้ว',
    isCourseEnrollmentReenrollable: enrollment => enrollment && (enrollment.courseStatus === 'ยกเลิก' || enrollment.enrollmentStatus === 'cancelled'),
    buildAdminCourseEnrollment(student, course, status, extra) {
      return {
        id: student.id + '__' + course.id, firebaseDocId: student.id + '__' + course.id,
        studentId: student.id, courseId: course.id, courseName: course.name, courseAccess: course.access,
        courseStatus: status, enrollmentStatus: 'active', paymentStatus: 'รอชำระเงิน',
        registeredCourseMonth: extra.registeredCourseMonth || 'พฤศจิกายน 2569', enrollmentSource: extra.enrollmentSource
      };
    },
    buildReactivatedCourseEnrollment(previous, next) {
      return { ...previous, ...next, reactivationCount: Number(previous.reactivationCount || 0) + 1, cancellationHistory: [{ cancelledAtMs: previous.cancelledAtMs || 0 }] };
    },
    applyAdminCourseEnrollmentStatus(enrollment, status) {
      enrollment.courseStatus = status;
      enrollment.enrollmentStatus = 'active';
      if (status === 'อนุมัติแล้ว') enrollment.everApproved = true;
      return enrollment;
    },
    prepareCourseEnrollmentPayment(student, enrollment) {
      if (options.noPayment) return { payment: null, created: false, month: enrollment.registeredCourseMonth };
      return {
        payment: { id: 'random-id', firebaseDocId: 'random-id', studentId: student.id, courseId: enrollment.courseId, status: 'รอชำระเงิน' },
        created: true,
        month: enrollment.registeredCourseMonth
      };
    },
    isCoursePaymentCancelled: payment => payment && (payment.status === 'ยกเลิก' || payment.paymentStatus === 'ยกเลิก'),
    buildStudentMainCourseFields(enrollment) {
      return { courseId: enrollment.courseId, course: enrollment.courseName, courseStatus: enrollment.courseStatus, paymentStatus: enrollment.paymentStatus };
    },
    buildFirebasePayload: (value, id, isNew) => ({ ...value, firebaseDocId: id, _isNew: isNew }),
    getFirestoreQuotaExceededMessage: () => 'quota',
    db: {
      collection(collection) {
        return { doc(id) { const ref = { collection, id }; refs[collection + '/' + id] = ref; return ref; } };
      },
      async runTransaction(worker) {
        const pendingWrites = [];
        const transaction = {
          async get(ref) {
            reads.push(ref.collection);
            if (ref.collection === 'students') return { exists: true, data: () => ({ name: 'Old', grade: 'ม.1', preferredLocation: 'Center A', authUid: 'auth-1' }) };
            if (ref.collection === 'courses') return { exists: true, data: () => ({ name: 'Course A', access: 'Online', status: 'open', grade: 'ม.1', location: 'Center A' }) };
            if (ref.collection === 'courseEnrollments') return { exists: !!enrollmentData, data: () => ({ ...enrollmentData }) };
            if (ref.collection === 'payments') return { exists: !!paymentData, data: () => ({ ...paymentData }) };
            return { exists: false, data: () => ({}) };
          },
          set(ref, data) { pendingWrites.push({ collection: ref.collection, id: ref.id, data }); }
        };
        await worker(transaction);
        if (options.failCommit) throw new Error('commit-failed');
        writes.push(...pendingWrites);
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(transactionSource, context);
  return { context, reads, writes };
}

test('student edit writes profile, enrollment, deterministic payment, and user mirror atomically', async () => {
  const { context, reads, writes } = createHarness();
  const original = { id: 'student-1', name: 'Old', grade: 'ม.1', preferredLocation: 'Center A', authUid: 'auth-1' };
  const draft = { ...original, name: 'New' };
  const result = await context.saveEditedStudentWithCourseTransaction(
    original,
    draft,
    { id: 'course-1', name: 'Course A', access: 'Online' },
    'อนุมัติแล้ว'
  );
  assert.deepEqual(reads, ['students', 'courses', 'courseEnrollments', 'payments']);
  assert.deepEqual(writes.map(write => write.collection), ['students', 'courseEnrollments', 'payments', 'users']);
  assert.match(writes.find(write => write.collection === 'payments').id, /^student-1__course-1__initial-payment-0__/);
  assert.equal(result.student.name, 'New');
  assert.equal(result.student.courseId, 'course-1');
  assert.equal(original.name, 'Old');
});

test('approved enrollment cannot be downgraded and completed enrollment cannot be overwritten', async () => {
  const approved = createHarness({ enrollment: { courseId: 'course-1', courseName: 'Course A', courseStatus: 'อนุมัติแล้ว', enrollmentStatus: 'active' } });
  await assert.rejects(
    approved.context.saveEditedStudentWithCourseTransaction(
      { id: 'student-1' }, { id: 'student-1', grade: 'ม.1', preferredLocation: 'Center A' }, { id: 'course-1' }, 'รออนุมัติคอร์ส'
    ),
    error => error.code === 'approved-enrollment-cannot-downgrade'
  );
  assert.equal(approved.writes.length, 0);

  const completed = createHarness({ enrollment: { courseId: 'course-1', courseStatus: 'จบคอร์ส', enrollmentStatus: 'completed' } });
  await assert.rejects(
    completed.context.saveEditedStudentWithCourseTransaction(
      { id: 'student-1' }, { id: 'student-1', grade: 'ม.1', preferredLocation: 'Center A' }, { id: 'course-1' }, 'อนุมัติแล้ว'
    ),
    error => error.code === 'course-enrollment-completed'
  );
  assert.equal(completed.writes.length, 0);
});

test('transaction failure leaves the caller-owned student unchanged', async () => {
  const { context, writes } = createHarness({ failCommit: true });
  const original = { id: 'student-1', name: 'Old', grade: 'ม.1', preferredLocation: 'Center A', authUid: 'auth-1' };
  await assert.rejects(context.saveEditedStudentWithCourseTransaction(
    original,
    { ...original, name: 'New' },
    { id: 'course-1', name: 'Course A' },
    'อนุมัติแล้ว'
  ), /commit-failed/);
  assert.equal(original.name, 'Old');
  assert.equal(writes.length, 0);
});

test('student edit bubble defaults to no course and mutates local state only after transaction success', () => {
  assert.match(html, /studentCourseOptionsHtml\('', s\.preferredLocation \|\| '', s\.grade \|\| '', 'ไม่เพิ่มคอร์ส'\)/);
  assert.match(html, /const draftStudent = Object\.assign\(\{\}, s,/);
  assert.match(html, /const saveResult = await saveEditedStudentWithCourseTransaction[\s\S]*Object\.assign\(s, saveResult\.student \|\| draftStudent\)/);
  assert.doesNotMatch(html.slice(html.indexOf('    function editStudent('), html.indexOf('    function clearBillingStartMonthPicker(')), /await setFirebaseDocument\('students', s\)/);
});
