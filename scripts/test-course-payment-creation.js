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

test('shared enrollment payment path prefers registered month and normal payment builder', () => {
  const student = { id: 'student-1', name: 'Student', preferredLocation: 'Center A' };
  const course = { id: 'course-1', name: 'Course A', location: 'Center A' };
  const enrollment = { courseId: 'course-1', courseName: 'Course A', location: 'Center A', registeredCourseMonth: 'ตุลาคม 2569' };
  const calls = [];
  const context = {
    payments: [],
    getThaiMonthFromDate: () => 'พฤศจิกายน 2569',
    isStudentPaymentRecord: (target, payment) => payment.studentId === target.id,
    getCourseForEnrollment: () => course,
    buildStudentMonthlyPaymentRecord(target, selectedCourse, month) {
      calls.push({ target, selectedCourse, month });
      return { id: 'payment-1', firebaseDocId: 'payment-1', studentId: target.id, courseId: selectedCourse.id, month };
    }
  };
  vm.createContext(context);
  for (const name of ['getCourseEnrollmentPaymentMonth', 'findCourseEnrollmentPayment', 'prepareCourseEnrollmentPayment']) {
    vm.runInContext(source(name), context);
  }
  const prepared = context.prepareCourseEnrollmentPayment(student, enrollment, course, 'พฤศจิกายน 2569');
  assert.equal(prepared.created, true);
  assert.equal(prepared.month, 'ตุลาคม 2569');
  assert.equal(calls[0].month, 'ตุลาคม 2569');
  assert.equal(prepared.payment.courseId, 'course-1');
  assert.equal(prepared.payment.paymentCenter, 'Center A');
});

test('shared enrollment payment path reuses the existing student course month record', () => {
  const existing = { id: 'existing', studentId: 'student-1', courseId: 'course-1', month: 'ตุลาคม 2569' };
  const context = {
    payments: [existing],
    getThaiMonthFromDate: () => 'ตุลาคม 2569',
    isStudentPaymentRecord: (student, payment) => payment.studentId === student.id,
    getCourseForEnrollment: () => ({}),
    buildStudentMonthlyPaymentRecord: () => { throw new Error('must not build a duplicate'); }
  };
  vm.createContext(context);
  for (const name of ['getCourseEnrollmentPaymentMonth', 'findCourseEnrollmentPayment', 'prepareCourseEnrollmentPayment']) {
    vm.runInContext(source(name), context);
  }
  const prepared = context.prepareCourseEnrollmentPayment(
    { id: 'student-1' },
    { courseId: 'course-1', registeredCourseMonth: 'ตุลาคม 2569' },
    {},
    ''
  );
  assert.equal(prepared.created, false);
  assert.equal(prepared.payment, existing);
});

function createAdminTransactionContext(status) {
  const writes = [];
  const refs = {};
  const context = {
    courseEnrollments: [],
    payments: [],
    firebaseReady: true,
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'timestamp' } } },
    canManageAdminCourseEnrollments: () => true,
    hasPermission: permission => permission === 'admin.finance',
    getEnrollmentStudentId: student => student.id,
    getCourseEnrollmentDocId: (studentId, courseId) => studentId + '__' + courseId,
    getFirebaseAuditUser: () => ({ uid: 'admin-1', email: 'admin@example.com', displayName: 'Admin' }),
    buildAdminCourseEnrollment(student, course, enrollmentStatus) {
      return {
        id: student.id + '__' + course.id,
        firebaseDocId: student.id + '__' + course.id,
        studentId: student.id,
        courseId: course.id,
        courseName: course.name,
        courseStatus: enrollmentStatus,
        registeredCourseMonth: 'ตุลาคม 2569'
      };
    },
    buildStudentMainCourseFields(enrollment) {
      return {
        courseId: enrollment.courseId,
        course: enrollment.courseName,
        courseAccess: enrollment.courseAccess || '-',
        courseStatus: enrollment.courseStatus,
        paymentStatus: enrollment.paymentStatus || 'รอชำระเงิน',
        registeredCourseMonth: enrollment.registeredCourseMonth || ''
      };
    },
    prepareCourseEnrollmentPayment(student, enrollment) {
      return {
        created: true,
        month: enrollment.registeredCourseMonth,
        payment: { id: 'payment-1', firebaseDocId: 'payment-1', studentId: student.id, courseId: enrollment.courseId, month: enrollment.registeredCourseMonth }
      };
    },
    buildFirebasePayload: value => ({ ...value }),
    db: {
      collection(collection) {
        return { doc(id) { const ref = { collection, id }; refs[collection + '/' + id] = ref; return ref; } };
      },
      async runTransaction(worker) {
        const transaction = {
          async get(ref) {
            if (ref.collection === 'students') return { exists: true, data: () => ({ grade: 'ม.1', preferredLocation: 'Center A' }) };
            if (ref.collection === 'courses') return { exists: true, data: () => ({ status: 'open', grade: 'ม.1', location: 'Center A' }) };
            return { exists: false, data: () => ({}) };
          },
          set(ref, data) { writes.push({ ref, data }); }
        };
        await worker(transaction);
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source('createAdminEnrollmentError'), context);
  const start = html.indexOf('    async function createAdminCourseEnrollmentTransaction(');
  const end = html.indexOf('    function getAdminEnrollmentErrorMessage(', start);
  vm.runInContext(html.slice(start, end), context);
  return { context, writes, status };
}

test('admin approved enrollment creates its first payment in the same transaction', async () => {
  const { context, writes } = createAdminTransactionContext('อนุมัติแล้ว');
  const result = await context.createAdminCourseEnrollmentTransaction(
    { id: 'student-1', grade: 'ม.1', preferredLocation: 'Center A' },
    { id: 'course-1', name: 'Course A', grade: 'ม.1', location: 'Center A', status: 'open' },
    'อนุมัติแล้ว',
    'admin_single_enrollment'
  );
  assert.deepEqual(writes.map(write => write.ref.collection), ['courseEnrollments', 'payments', 'students']);
  assert.equal(writes[2].data.courseId, 'course-1');
  assert.equal(result.paymentResult.created, true);
  assert.equal(context.payments.length, 1);
});

test('admin pending enrollment does not create a payment before approval', async () => {
  const { context, writes } = createAdminTransactionContext('รออนุมัติคอร์ส');
  const result = await context.createAdminCourseEnrollmentTransaction(
    { id: 'student-1', grade: 'ม.1', preferredLocation: 'Center A' },
    { id: 'course-1', name: 'Course A', grade: 'ม.1', location: 'Center A', status: 'open' },
    'รออนุมัติคอร์ส',
    'admin_single_enrollment'
  );
  assert.deepEqual(writes.map(write => write.ref.collection), ['courseEnrollments', 'students']);
  assert.equal(writes[1].data.courseStatus, 'รออนุมัติคอร์ส');
  assert.equal(result.paymentResult.skipped, 'pending-approval');
  assert.equal(context.payments.length, 0);
});

test('approving a pending enrollment reuses a payment already created by slip upload', async () => {
  const student = { id: 'student-1', name: 'Student' };
  const enrollment = {
    id: 'student-1__course-1', firebaseDocId: 'student-1__course-1', studentId: student.id,
    courseId: 'course-1', courseName: 'Course A', courseStatus: 'รออนุมัติคอร์ส',
    registeredCourseMonth: 'ตุลาคม 2569', enrollmentStatus: 'active'
  };
  const existingPayment = { id: 'payment-1', studentId: student.id, courseId: enrollment.courseId, month: enrollment.registeredCourseMonth, status: 'รอตรวจสลิป' };
  const writes = [];
  const context = {
    payments: [existingPayment],
    currentStudent: null,
    canManageAdminCourseEnrollments: () => true,
    findStudentById: () => student,
    getStudentCourseEnrollment: () => enrollment,
    getCourseForEnrollment: () => ({ id: 'course-1', name: 'Course A' }),
    confirm: () => true,
    hasPermission: permission => permission === 'admin.finance',
    prepareCourseEnrollmentPayment: () => ({ payment: existingPayment, created: false, month: enrollment.registeredCourseMonth }),
    setFirebaseDocument: async (collection, value) => writes.push({ collection, value }),
    addActivityLog: (action, detail) => writes.push({ collection: 'activityLogs', action, detail }),
    renderAdminStudents() {},
    renderAdminDashboard() {},
    updateStudentCourseDisplay() {},
    alert() {},
    firebaseReady: true,
    db: {},
    console: { error() {} }
  };
  vm.createContext(context);
  vm.runInContext(source('approveStudentCourse'), context);
  await context.approveStudentCourse(student.id, enrollment.courseId);
  assert.equal(enrollment.courseStatus, 'อนุมัติแล้ว');
  assert.equal(writes.filter(write => write.collection === 'courseEnrollments').length, 1);
  assert.equal(context.payments.length, 1);
  assert.match(writes.find(write => write.collection === 'activityLogs').detail, /ใช้ยอดเดิม/);
});
