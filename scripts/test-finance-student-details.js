const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('    const paymentStudentLoads = new Map();'), html.indexOf('    function paymentScopeLocationMatches('));

function fixture() {
  const students = [];
  const queries = [];
  const context = vm.createContext({
    firebaseUser: { uid: 'admin' }, studentDataSessionVersion: 1,
    firestoreQuotaBlocked: false, isCurrentStudentSession: () => false,
    payments: [{ memberId: '0090001', student: 'Student' }],
    getPaymentStudentRecord: p => students.find(s => s.memberId === p.memberId),
    mergeStudentEntityRecords: rows => students.push(...rows),
    rebuildStudentLookupMap() {}, markFirestoreQuotaExceeded() {}, console,
    db: { collection: name => ({ where: (field, op, values) => ({ get: async () => {
      queries.push({ name, field, op, values: Array.from(values) });
      return { docs: [{ id: 'student-doc', data: () => ({ memberId: '0090001', nickname: 'ต้น' }) }] };
    } }) }) }
  });
  vm.runInContext(source, context);
  return { context, students, queries };
}

test('finance opened with an empty student cache loads nickname by payment member ID', async () => {
  const { context, students, queries } = fixture();
  assert.equal(students.length, 0);
  assert.equal(await context.loadPaymentStudentRecords(), true);
  assert.equal(students[0].nickname, 'ต้น');
  assert.deepEqual(queries[0], { name: 'students', field: 'memberId', op: 'in', values: ['0090001'] });
  assert.equal(await context.loadPaymentStudentRecords(), false);
  assert.equal(queries.length, 1, 'rerender must not repeat reads');
});

test('late profile results are ignored after account/session changes', async () => {
  const { context, students } = fixture();
  const pending = context.loadPaymentStudentRecords();
  context.studentDataSessionVersion++;
  assert.equal(await pending, false);
  assert.equal(students.length, 0);
});

test('student sessions cannot start staff profile lookups', async () => {
  const { context, queries } = fixture();
  context.isCurrentStudentSession = () => true;
  assert.equal(await context.loadPaymentStudentRecords(), false);
  assert.equal(queries.length, 0);
});
