const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/drive-upload-webapp.gs'), 'utf8'), context);

function folder(name) {
  const children = new Map();
  return {
    name, children,
    getFoldersByName(key) {
      return { hasNext: () => children.has(key), next: () => children.get(key) };
    },
    createFolder(key) {
      assert.equal(children.has(key), false, 'must reuse existing folders');
      const child = folder(key);
      children.set(key, child);
      return child;
    }
  };
}

test('same course and month separate slips by grade and reuse each grade folder', () => {
  const root = folder('payment-slips');
  const data = { folderType: 'payment-slips', month: 'พฤศจิกายน 2569', courseName: 'คอร์สเปิดเทอม' };
  const first = context.getTargetFolder(root, { ...data, grade: 'ป.4' });
  const second = context.getTargetFolder(root, { ...data, grade: 'ป.5' });
  assert.notEqual(first, second);
  assert.equal(first.name, 'ป.4');
  assert.equal(second.name, 'ป.5');
  assert.equal(context.getTargetFolder(root, { ...data, grade: ' ป.4 ' }), first);
  assert.equal(root.children.get(data.month).children.get(data.courseName).children.size, 2);
});

test('missing or blank grade has an explicit folder', () => {
  const root = folder('payment-slips');
  for (const grade of [undefined, '', '   ']) {
    assert.equal(context.getTargetFolder(root, { folderType: 'payment-slips', grade }).name, 'ไม่ระบุระดับชั้น');
  }
});

test('other upload types keep their original destination', () => {
  const root = folder('site-assets');
  assert.equal(context.getTargetFolder(root, { folderType: 'site-assets', grade: 'ป.4' }), root);
  assert.equal(root.children.size, 0);
});
