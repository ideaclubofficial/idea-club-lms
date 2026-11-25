const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const match = new RegExp('^    (?:async )?function ' + name + '\\(', 'm').exec(html);
  assert.ok(match, name);
  return html.slice(match.index, html.indexOf('\n    }', match.index) + 6);
}
function setup(share = false, mobile = false) {
  const attached = new Set(), downloads = [], shared = [], revoked = [], alerts = [], captures = [], events = [];
  const c = {
    File, console: {error() {}}, alert: text => alerts.push(text),
    ensureExportLibraries: async pdf => { assert.equal(pdf, false); return true; },
    tuitionNoticeHtml: group => group.memberId,
    buildPdfDocumentElement: (title, body) => ({body, querySelector: () => ({offsetWidth:794, scrollHeight:1123})}),
    waitForTuitionNoticeImages: async element => events.push('ready:' + element.body),
    getSafeFileName: value => value.replace(/[^a-zA-Z0-9-]/g, '_'),
    getLocalDateString: () => '2026-11-25',
    document: {body: {appendChild: e => attached.add(e), removeChild: e => attached.delete(e)},
      createElement: () => ({click() { downloads.push(this.download); }})},
    URL: {createObjectURL: file => 'blob:' + file.name, revokeObjectURL: url => revoked.push(url)},
    setTimeout: fn => fn(),
    navigator: {userAgent: mobile ? 'iPhone' : 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0, canShare: () => share, share: async data => shared.push(data)},
    window: {html2canvas: async (target, options) => {
      assert.ok(events.length, 'images must be ready before capture');
      captures.push(options);
      return {toBlob: cb => cb(new Blob(['png'], {type:'image/png'}))};
    }}
  };
  vm.createContext(c); vm.runInContext(source('downloadTuitionNoticesImages'), c);
  return {c,attached,downloads,shared,revoked,alerts,captures};
}
const groups = [{memberId:'001',centerText:'A'}, {memberId:'001',centerText:'B'}];
test('tuition PNG uses the attendance share flow with one file per student-center notice', async () => {
  const h = setup(true, true); await h.c.downloadTuitionNoticesImages(groups);
  assert.equal(h.shared.length,1); assert.equal(h.shared[0].files.length,2);
  assert.equal(h.shared[0].files[0].type,'image/png');
  assert.notEqual(h.shared[0].files[0].name,h.shared[0].files[1].name);
  assert.equal(h.downloads.length,0); assert.equal(h.attached.size,0);
  assert.equal(h.captures[0].scale,2); assert.equal(h.captures[0].useCORS,true);
  assert.equal(h.captures[0].height,1123);
});
test('desktop downloads every generated PNG and releases object URLs', async () => {
  const h = setup(true); await h.c.downloadTuitionNoticesImages(groups);
  assert.equal(h.shared.length,0); assert.equal(h.downloads.length,2); assert.ok(h.downloads.every(n=>n.endsWith('.png')));
  assert.equal(h.revoked.length,2); assert.equal(h.attached.size,0); assert.equal(h.alerts.length,0);
});
test('failed PNG conversion cleans up and allows retry without downloading a partial batch', async () => {
  const h = setup(); const canvas = h.c.window.html2canvas;
  h.c.window.html2canvas=async()=>({toBlob: cb=>cb(null)});
  await h.c.downloadTuitionNoticesImages(groups);
  assert.equal(h.alerts.length,1); assert.equal(h.downloads.length,0); assert.equal(h.attached.size,0);
  assert.equal(h.c.downloadTuitionNoticesImages.running,false);
  h.c.window.html2canvas=canvas; await h.c.downloadTuitionNoticesImages(groups);
  assert.equal(h.downloads.length,2);
});
test('dismissing the share sheet cleans up without an error alert', async () => {
  const h = setup(true, true); h.c.navigator.share=async()=>{throw Object.assign(new Error('cancelled'),{name:'AbortError'});};
  await h.c.downloadTuitionNoticesImages(groups);
  assert.equal(h.alerts.length,0); assert.equal(h.attached.size,0);
  assert.equal(h.c.downloadTuitionNoticesImages.running,false);
});
test('individual and selected exports respect finance permission and current filters', async () => {
  const calls = [], alerts = [];
  const c = {hasPermission:()=>false,alert:text=>alerts.push(text),
    getFilteredTuitionNoticeStudentRow:key=>key==='visible'?{payments:['visible']}:null,
    buildTuitionNoticeStudentRows:()=>[{key:'visible',payments:['visible']},{key:'hidden',payments:['hidden']}],
    tuitionNoticeSelectedStudentKeys:new Set(['visible','stale']),
    buildTuitionNoticeGroups:payments=>payments, warnMissingTuitionNoticeQr() {},
    downloadTuitionNoticesImages:groups=>calls.push(Array.from(groups))};
  vm.createContext(c);
  for (const name of ['downloadTuitionNoticeStudentImage','downloadSelectedTuitionNoticesImages'])vm.runInContext(source(name),c);
  c.downloadTuitionNoticeStudentImage('visible'); c.downloadSelectedTuitionNoticesImages();
  assert.equal(calls.length,0); assert.equal(alerts.length,2);
  c.hasPermission=()=>true;
  c.downloadTuitionNoticeStudentImage('missing'); assert.equal(calls.length,0);
  c.downloadTuitionNoticeStudentImage('visible'); c.downloadSelectedTuitionNoticesImages();
  assert.deepEqual(calls,[['visible'],['visible']]);
});

test('iPad desktop user agent keeps the mobile share sheet', async () => {
  const h = setup(true); h.c.navigator.maxTouchPoints = 5;
  await h.c.downloadTuitionNoticesImages(groups);
  assert.equal(h.shared.length,1); assert.equal(h.downloads.length,0);
});
test('mobile without file sharing still downloads PNG files', async () => {
  const h = setup(false, true); await h.c.downloadTuitionNoticesImages(groups);
  assert.equal(h.downloads.length,2); assert.equal(h.shared.length,0);
});
