const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error(`Source block not found: ${startMarker}`);
  return html.slice(start, end);
}

function setupRooms({ courses = [], rooms = [] } = {}) {
  const context = {
    courses,
    onlineRooms: rooms,
    getCourseLocations: course => Array.isArray(course.locations) ? course.locations : [course.location].filter(Boolean),
    getElement: () => null,
    console,
    Set
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('    function normalizeOnlineLocation(', '    function renderOnlineClassCourseSelect('), context);
  return context;
}

function setupDocuments({ courses = [], documents = [] } = {}) {
  const context = {
    courses,
    onlineDocuments: documents,
    normalizeOnlineLocation: value => String(value || '').trim().replace(/\s+/g, ' '),
    getCourseLocations: course => Array.isArray(course.locations) ? course.locations : [course.location].filter(Boolean),
    console,
    Set
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('    function getOnlineDocLocation(', '    function onlineDocDateText('), context);
  return context;
}

test('shared room is resolved for every center in the grade', () => {
  const shared = { id: 'shared-p4', grade: 'ป.4', location: '', status: 'active', onlineLink: 'https://shared.example' };
  const context = setupRooms({ rooms: [shared] });
  assert.equal(context.resolveOnlineRoom('ป.4', 'ศูนย์ A').id, 'shared-p4');
  assert.equal(context.resolveOnlineRoom('ป.4', 'ศูนย์ B').id, 'shared-p4');
});

test('active center room overrides shared; inactive center room falls back to shared', () => {
  const shared = { id: 'shared', grade: 'ป.5', location: '', status: 'active', onlineLink: 'https://shared.example' };
  const center = { id: 'center', grade: 'ป.5', location: 'ศูนย์ A', status: 'active', onlineLink: 'https://center.example' };
  const context = setupRooms({ rooms: [shared, center] });
  assert.equal(context.resolveOnlineRoom('ป.5', 'ศูนย์ A').id, 'center');
  center.status = 'inactive';
  assert.equal(context.resolveOnlineRoom('ป.5', 'ศูนย์ A').id, 'shared');
});

test('inactive stored room suppresses the matching legacy room', () => {
  const course = { id: 'legacy', grade: 'ป.6', location: 'ศูนย์ A', onlineLink: 'https://legacy.example' };
  const suppressor = { id: 'off', grade: 'ป.6', location: 'ศูนย์ A', status: 'inactive' };
  const context = setupRooms({ courses: [course], rooms: [suppressor] });
  assert.equal(context.resolveOnlineRoom('ป.6', 'ศูนย์ A'), null);
});

test('identical legacy rooms across centers become one shared fallback', () => {
  const courses = [
    { id: 'a', grade: 'ม.1', location: 'ศูนย์ A', onlineLink: 'https://same.example', roomId: 'ROOM' },
    { id: 'b', grade: 'ม.1', location: 'ศูนย์ B', onlineLink: 'https://same.example', roomId: 'ROOM' }
  ];
  const context = setupRooms({ courses });
  const legacy = context.getLegacyOnlineRooms();
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].location, '');
  assert.equal(context.resolveOnlineRoom('ม.1', 'ศูนย์ B').onlineLink, 'https://same.example');
});

test('documents include shared plus matching center and exclude another center', () => {
  const documents = [
    { id: 'all', grade: 'ม.2', location: '', status: 'active', classDate: '2026-11-04' },
    { id: 'a', grade: 'ม.2', location: 'ศูนย์ A', status: 'active', classDate: '2026-11-03' },
    { id: 'b', grade: 'ม.2', location: 'ศูนย์ B', status: 'active', classDate: '2026-11-02' }
  ];
  const context = setupDocuments({ documents });
  assert.deepEqual(Array.from(context.getOnlineDocumentsForTarget('ม.2', 'ศูนย์ A', false), doc => doc.id), ['all', 'a']);
});

test('stored migration shadows legacy document and tombstone suppresses it', () => {
  const course = { id: 'course-a', grade: 'ม.3', location: 'ศูนย์ A', onlineDocs: [{ id: 'old', topic: 'เดิม', classDate: '2026-11-01' }] };
  const migrated = { id: 'new', grade: 'ม.3', location: 'ศูนย์ A', status: 'active', topic: 'ใหม่', classDate: '2026-11-02', legacySourceKey: 'course-a:old' };
  const context = setupDocuments({ courses: [course], documents: [migrated] });
  assert.deepEqual(Array.from(context.getUnifiedOnlineDocuments(false), doc => doc.topic), ['ใหม่']);
  migrated.status = 'deleted';
  migrated.suppressLegacy = true;
  assert.equal(context.getUnifiedOnlineDocuments(false).length, 0);
});

test('student access is grade and center based and blocks paused or withdrawn profiles', () => {
  const context = {
    currentStudent: { grade: 'ม.4', preferredLocation: 'ศูนย์ A', status: 'ปกติ' },
    isStudentLimitedAccess: student => ['พักเรียน', 'ลาออก'].includes(student.status),
    getProfileGrade: () => '',
    normalizeOnlineLocation: value => String(value || '').trim().replace(/\s+/g, ' ')
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('    function studentCanAccessOnlineTarget(', '    function openStudentOnlineDocFile('), context);
  assert.equal(context.studentCanAccessOnlineTarget('ม.4', ''), true);
  assert.equal(context.studentCanAccessOnlineTarget('ม.4', 'ศูนย์ A'), true);
  assert.equal(context.studentCanAccessOnlineTarget('ม.4', 'ศูนย์ B'), false);
  assert.equal(context.studentCanAccessOnlineTarget('ม.5', 'ศูนย์ A'), false);
  context.currentStudent.status = 'พักเรียน';
  assert.equal(context.studentCanAccessOnlineTarget('ม.4', 'ศูนย์ A'), false);
});

test('teacher sees one shared room for duplicate courses in the same grade', () => {
  const sharedRoom = { id: 'shared-m5', grade: 'ม.5', location: '', onlineLink: 'https://shared.example' };
  const context = {
    getElement: () => null,
    getTeacherVisibleCourses: () => [
      { id: 'course-a', grade: 'ม.5', location: 'ศูนย์ A' },
      { id: 'course-b', grade: 'ม.5', location: 'ศูนย์ B' }
    ],
    getCourseLocations: course => [course.location],
    resolveOnlineRoom: () => sharedRoom,
    onlineRoomSignature: room => room.onlineLink
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('    function getTeacherVisibleOnlineCourses(', '    function syncTeacherMobileOnlineFilter('), context);
  const targets = context.getTeacherVisibleOnlineCourses();
  assert.equal(targets.length, 1);
  assert.deepEqual(Array.from(targets[0].locations), ['ศูนย์ A', 'ศูนย์ B']);
});

test('student desktop and mobile render one grade-based room and shared document cards', () => {
  assert.ok((html.match(/renderStudentOnlineDocumentCards\(grade, location\)/g) || []).length >= 2);
  assert.match(html, /function openOnlineRoomForTarget\(grade, location\)/);
  assert.doesNotMatch(html, /getUniqueStudentOnlineCourses/);
  assert.doesNotMatch(html, /adminOnlineClassShared/);
});
