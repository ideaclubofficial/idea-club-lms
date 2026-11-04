const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error('Student Online source block not found');
  return html.slice(start, end);
}

function setupOnlineCourseFilter() {
  const context = {
    courseFeatureEnabled: (course, feature) => course.features && course.features[feature] !== false,
    console
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(
    '    function getUniqueStudentOnlineCourses(',
    '    function refreshStudentOnDemandFilter('
  ), context);
  return context;
}

function setupDocumentRenderer(options = {}) {
  const context = {
    courseFeatureEnabled: () => options.docsEnabled !== false,
    getCourseOnlineDocs: () => options.docs || [],
    jsArg: value => String(value).replace(/'/g, "\\'"),
    escapeHtml: value => String(value),
    onlineDocDateText: value => `DATE:${value}`,
    console
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(
    '    function getOnlineDocFileButtonTitle(',
    '    async function saveOnDemandSettings('
  ), context);
  return context;
}

function setupDocumentMatching(courseList) {
  const context = { courses: courseList, console };
  vm.createContext(context);
  vm.runInContext(sourceBetween(
    '    function getOnlineDocLocation(',
    '    function getOnlineDocFileButtonTitle('
  ), context);
  return context;
}

test('student Online courses show once per enabled course id', () => {
  const context = setupOnlineCourseFilter();
  const courses = [
    { id: 'online-1', access: 'Online', features: { online: true } },
    { id: 'online-1', access: 'Online', features: { online: true }, _historicalMedia: true },
    { id: 'online-2', access: 'Online + On-demand', features: { online: true } },
    { id: 'disabled', access: 'Online', features: { online: false } },
    { id: 'ondemand', access: 'On-demand', features: { online: true } }
  ];

  assert.deepEqual(
    Array.from(context.getUniqueStudentOnlineCourses(courses), course => course.id),
    ['online-1', 'online-2']
  );
});

test('document rail renders every set and one download button per linked file', () => {
  const context = setupDocumentRenderer({
    docs: [
      {
        topic: 'ชุดระบบย่อยอาหาร',
        classDate: '2026-11-04',
        files: [
          { title: 'ใบงาน', url: 'https://example.com/workbook.pdf' },
          { title: 'เฉลย', url: 'https://example.com/answer.pdf' }
        ]
      },
      { topic: 'ชุดเซลล์', classDate: '2026-10-28', files: [] }
    ]
  });

  const output = context.renderStudentOnlineDocumentCards({ id: 'course-1' });
  assert.equal((output.match(/student-online-doc-card"/g) || []).length, 2);
  assert.equal((output.match(/ดาวน์โหลดเอกสาร:/g) || []).length, 2);
  assert.match(output, /ชุดระบบย่อยอาหาร/);
  assert.match(output, /วันที่เรียน DATE:2026-11-04/);
  assert.match(output, /ยังไม่มีลิงก์ไฟล์เอกสาร/);
});

test('document rail keeps explicit disabled and empty states', () => {
  const disabled = setupDocumentRenderer({ docsEnabled: false });
  assert.match(disabled.renderStudentOnlineDocumentCards({ id: 'course-1' }), /ปิดการแสดงเอกสาร Online/);

  const empty = setupDocumentRenderer({ docs: [] });
  const output = empty.renderStudentOnlineDocumentCards({ id: 'course-1' });
  assert.match(output, /0 ชุด/);
  assert.match(output, /ยังไม่มีเอกสารรายครั้งสำหรับคอร์สนี้/);
});

test('document cards preserve all-centers and legacy center matching', () => {
  const nongchang = { id: 'nc-p4', location: 'หนองฉาง', grade: 'ป.4', onlineDocs: [] };
  const nongkayang = { id: 'nky-p4', location: 'หนองขาหย่าง', grade: 'ป.4', onlineDocs: [] };
  nongchang.onlineDocs = [
    { id: 'all', location: '', grade: 'ป.4', classDate: '2026-11-04', status: 'active' },
    { id: 'legacy', center: 'หนองฉาง', grade: 'ป.4', classDate: '2026-11-03', status: 'active' }
  ];
  const context = setupDocumentMatching([nongchang, nongkayang]);

  assert.deepEqual(
    Array.from(context.getCourseOnlineDocs(nongchang, false), doc => doc.id),
    ['all', 'legacy']
  );
  assert.deepEqual(
    Array.from(context.getCourseOnlineDocs(nongkayang, false), doc => doc.id),
    ['all']
  );
});

test('desktop and mobile Online rooms use the shared document-card renderer', () => {
  const desktopCalls = html.match(/renderStudentOnlineDocumentCards\(c\)/g) || [];
  assert.equal(desktopCalls.length, 2);
  assert.doesNotMatch(html, /studentMobileOpenLatestOnlineDoc/);
});
