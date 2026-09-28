const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('    const optionalLibraryLoads ='), html.indexOf('    async function downloadAttendanceRosterPng('));
function setup() {
  const scripts = [], timers = new Map(); let timerId = 0;
  const context = { window: {}, console: { warn() {} }, setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    document: { createElement() { return { remove() { this.removed = true; } }; }, head: { appendChild(script) { scripts.push(script); } } } };
  vm.createContext(context); vm.runInContext(source, context);
  return { context, scripts, timers };
}
test('no library loads until requested; concurrent requests share one script', async () => {
  const { context: c, scripts } = setup(); assert.equal(scripts.length, 0);
  const first = c.loadOptionalLibrary('canvas'), second = c.loadOptionalLibrary('canvas');
  assert.equal(first, second); assert.equal(scripts.length, 1);
  c.window.html2canvas = () => {}; scripts[0].onload(); await first;
  await c.loadOptionalLibrary('canvas'); assert.equal(scripts.length, 1);
});
test('network failure clears cache so next request retries', async () => {
  const { context: c, scripts } = setup();
  const first = c.loadOptionalLibrary('pdf'); scripts[0].onerror(); await assert.rejects(first);
  assert.equal(scripts[0].removed, true);
  const retry = c.loadOptionalLibrary('pdf'); assert.equal(scripts.length, 2);
  c.window.jspdf = { jsPDF() {} }; scripts[1].onload(); await retry;
});
test('missing global and timeout both permit retry', async () => {
  const { context: c, scripts, timers } = setup();
  const first = c.loadOptionalLibrary('qr'); scripts[0].onload(); await assert.rejects(first);
  const next = c.loadOptionalLibrary('qr'); [...timers.values()][0](); await assert.rejects(next);
  assert.equal(scripts[1].removed, true);
  const retry = c.loadOptionalLibrary('qr'); c.window.QRCode = () => {}; scripts[2].onload(); await retry;
  assert.equal(timers.size, 0);
});
test('PNG loads canvas only; PDF reuses canvas and loads PDF', async () => {
  const { context: c, scripts } = setup();
  const png = c.ensureExportLibraries(false); assert.equal(scripts.length, 1);
  c.window.html2canvas = () => {}; scripts[0].onload(); assert.equal(await png, true);
  const pdf = c.ensureExportLibraries(true); assert.equal(scripts.length, 2);
  c.window.jspdf = { jsPDF() {} }; scripts[1].onload(); assert.equal(await pdf, true);
});
test('export load failure resolves false for caller error UI', async () => {
  const { context: c, scripts } = setup(); const pending = c.ensureExportLibraries(false);
  scripts[0].onerror(); assert.equal(await pending, false);
});
test('export libraries have no eager script tags', () => {
  const tags = [...html.matchAll(/<script\b[^>]*\bsrc=[^>]*>/g)].map(m => m[0]).join('\n');
  assert.doesNotMatch(tags, /html2canvas|jspdf|html2pdf|qrcodejs/);
});
