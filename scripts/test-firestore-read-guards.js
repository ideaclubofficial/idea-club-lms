const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function functionSource(name, nextName) {
  const start = html.indexOf('    function ' + name + '(');
  const end = html.indexOf('    function ' + nextName + '(', start);
  assert.ok(start >= 0 && end > start, name);
  return html.slice(start, end);
}

function asyncFunctionSource(name, nextName) {
  const start = html.indexOf('    async function ' + name + '(');
  const end = html.indexOf('    async function ' + nextName + '(', start);
  assert.ok(start >= 0 && end > start, name);
  return html.slice(start, end);
}

test('known Firestore documents skip the pre-write existence read', async () => {
  let getCount = 0;
  let setCount = 0;
  const context = {
    firebaseKnownDocumentKeys: new Set(),
    firebaseReady: true,
    PRODUCTION_MODE: false,
    firebaseUser: { uid: 'admin-1' },
    db: {
      collection() {
        return { doc() { return {
          async get() { getCount++; return { exists: true }; },
          async set() { setCount++; }
        }; } };
      }
    },
    createFirebaseDocId: () => 'generated',
    sanitizeStudentProfile: value => value,
    buildFirebasePayload: (value, id, isNew) => ({ ...value, firebaseDocId: id, isNew }),
    markFirestoreQuotaExceeded() {},
    isCurrentStudentSession: () => true,
    syncStudentUserProfile() {},
    syncTeacherUserProfile() {}
  };
  vm.createContext(context);
  vm.runInContext(functionSource('getFirebaseKnownDocumentKey', 'rememberFirebaseDocumentSnapshot'), context);
  vm.runInContext(asyncFunctionSource('setFirebaseDocument', 'deleteFirebaseDocument'), context);

  context.rememberFirebaseDocument('courses', 'course-1');
  const existing = { id: 'course-1', firebaseDocId: 'course-1' };
  await context.setFirebaseDocument('courses', existing);
  assert.equal(getCount, 0);
  assert.equal(setCount, 1);

  await context.setFirebaseDocument('courses', { id: 'course-2', firebaseDocId: 'course-2' });
  assert.equal(getCount, 1);
  assert.equal(setCount, 2);
  assert.equal(context.firebaseKnownDocumentKeys.has('courses/course-2'), true);
});

test('quota circuit breaker covers collection loads, listeners, and staff tab retries', () => {
  assert.match(html, /skip firebase collection:[\s\S]*markFirestoreQuotaExceeded|markFirestoreQuotaExceeded\(error\);[\s\S]*skip firebase collection:/);
  assert.match(html, /realtime collection query failed:[\s\S]*isFirestoreQuotaExceededError|markFirestoreQuotaExceeded\(error\);[\s\S]*realtime collection query failed/);
  assert.match(html, /function requestStaffTabData\(tabId\)[\s\S]*if \(firestoreQuotaBlocked\)/);
  assert.match(html, /id = 'firestoreQuotaGlobalNotice'/);
});
