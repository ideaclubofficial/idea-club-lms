const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function load(c, names) {
  for (const name of names) {
    const match = new RegExp('^    (?:async )?function ' + name + '\\(', 'm').exec(html);
    assert.ok(match, name);
    vm.runInContext(html.slice(match.index, html.indexOf('\n    }', match.index) + 6), c);
  }
}
const now = 1800000000000;
const draft = (extra = {}) => ({
  status: 'in_progress', startedAtMs: now - 60000, deadlineAtMs: now + 300000, updatedAtMs: now - 1000,
  answers: { q1: 0, q2: 3 }, questionOrder: ['q2', 'q3', 'q1'],
  choiceOrder: { q1: [2, 0, 3, 1], q2: [3, 2, 1, 0], q3: [1, 0, 2, 3] }, ...extra
});

function setup() {
  const nodes = {}, prompts = [], alerts = [], events = [];
  for (const id of ['onlineExamCourseGrid', 'onlineExamActiveExam', 'onlineExamResultView', 'onlineExamActiveCourseTitle',
    'onlineExamStickySubmit', 'onlineExamQuestionFeed', 'onlineExamNavigator', 'onlineExamAnsweredCount',
    'onlineExamTotalCount', 'onlineExamStickyAnswered', 'onlineExamStickyTotal']) {
    nodes[id] = { style: {}, innerHTML: '', textContent: '' };
  }
  nodes.onlineExamActiveExam.style.display = 'none';
  let remote = draft(), local = null, failDraft = false, failResults = false, results = [];
  const query = {
    where() { return this; }, limit() { return this; },
    async get() { if (failResults) throw new Error('results offline'); return { docs: results.map(data => ({ data: () => data })) }; }
  };
  class FixedDate extends Date { static now() { return now; } }
  const course = { firebaseDocId: 'exam', title: 'Exam', durationMinutes: 15, shuffleQuestions: true, shuffleChoices: true,
    questions: ['q1', 'q2', 'q3'].map(questionId => ({ questionId, text: questionId, choices: ['A', 'B', 'C', 'D'] })) };
  const c = {
    Date: FixedDate, currentStudent: { name: 'Student' }, firebaseUser: { uid: 'student' },
    onlineExamCourseCache: [course], onlineExamStartPending: false, onlineExamActiveCourseId: '',
    onlineExamStudentAnswers: {}, onlineExamQuestionOrder: [], onlineExamChoiceOrder: {},
    studentCanUseCourseEntitlements: () => true, getOnlineExamScheduleStatus: () => ({ state: 'open' }),
    getElement: id => nodes[id], onlineExamChoiceLabel: i => String(i + 1),
    onlineExamRichTextHtml: value => value, getOnlineExamQuestionImageUrl: () => '',
    confirm: message => { prompts.push(message); return true; }, alert: message => alerts.push(message),
    console: { error() {} },
    localStorage: { getItem: () => JSON.stringify(local) },
    db: { collection: name => name === 'onlineExamResults' ? query : { doc: () => ({
      async get() { if (failDraft) throw new Error('draft offline'); return { exists: !!remote, data: () => remote }; }
    }) } },
    startOnlineExamTimer() { events.push('timer'); },
    onlineExamStartAutosave() { events.push('autosave'); },
    onlineExamDeleteDraft() { events.push('delete'); }, onlineExamSaveDraft() { events.push('save'); },
    onlineExamShuffleArray: a => a.slice().reverse()
  };
  vm.createContext(c);
  load(c, ['startOnlineExam', 'startOnlineExamSession', 'restoreOnlineExamDraft', 'onlineExamLoadDraft',
    'switchToOnlineExamPhase', 'renderOnlineExamQuestionFeed', 'updateOnlineExamNavigator']);
  return { c, nodes, prompts, alerts, events, course, query,
    setRemote: value => { remote = value; }, setLocal: value => { local = value; },
    failDraft: () => { failDraft = true; }, failResults: value => { failResults = value; },
    setResults: value => { results = value; } };
}

function assertRestored(h) {
  const { c, nodes, prompts } = h;
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /คืนคำตอบทุกข้อ/);
  assert.deepEqual({ ...c.onlineExamStudentAnswers }, { q1: 0, q2: 3 });
  const feed = nodes.onlineExamQuestionFeed.innerHTML;
  assert.equal((feed.match(/ checked/g) || []).length, 2);
  assert.match(feed, /onlineExamLabel_q1_1[\s\S]*?<input[^>]*checked/);
  assert.match(feed, /onlineExamLabel_q2_0[\s\S]*?<input[^>]*checked/);
  const blankQuestion = feed.slice(feed.indexOf('id="onlineExamQNode_1"'), feed.indexOf('id="onlineExamQNode_2"'));
  assert.doesNotMatch(blankQuestion, / checked/);
  assert.equal(nodes.onlineExamAnsweredCount.textContent, 2);
  assert.equal(nodes.onlineExamStickyAnswered.textContent, 2);
  assert.equal(nodes.onlineExamTotalCount.textContent, 3);
  assert.equal(nodes.onlineExamActiveExam.style.display, '');
  assert.equal(c.onlineExamStartedAt.getTime(), now - 60000);
  assert.equal(c.onlineExamTimeRemaining, 300);
}

test('one confirmation restores every saved selection, shuffled order, counters and remaining time', async () => {
  const h = setup();
  const saved = draft();
  h.setRemote(saved);
  await h.c.startOnlineExam('exam');
  assertRestored(h);
  assert.deepEqual(Array.from(h.c.onlineExamQuestionOrder), ['q2', 'q3', 'q1']);
  assert.equal(h.events.filter(e => e === 'autosave').length, 1);
  h.c.onlineExamStudentAnswers.q1 = 2;
  h.c.onlineExamChoiceOrder.q1[0] = 1;
  assert.equal(saved.answers.q1, 0);
  assert.equal(saved.choiceOrder.q1[0], 2);
});

test('repeated starts during loading show one confirmation and start one exam', async () => {
  const h = setup();
  let finish;
  h.query.get = () => new Promise(resolve => { finish = resolve; });
  const first = h.c.startOnlineExam('exam');
  await h.c.startOnlineExam('exam');
  assert.equal(h.prompts.length, 0);
  finish({ docs: [] });
  await first;
  assertRestored(h);
  assert.equal(h.events.filter(e => e === 'timer').length, 1);
  assert.equal(h.c.onlineExamStartPending, false);
});

test('all selections and counters render before revealing the exam', async () => {
  const h = setup();
  const render = h.c.renderOnlineExamQuestionFeed;
  h.c.renderOnlineExamQuestionFeed = course => {
    assert.equal(h.nodes.onlineExamActiveExam.style.display, 'none');
    render(course);
  };
  await h.c.startOnlineExam('exam');
  assertRestored(h);
});

function localDraft(data) {
  return { ...data, startedAt: data.startedAtMs, deadlineAt: data.deadlineAtMs };
}

test('Firestore failure restores all locally saved answers after one confirmation', async () => {
  const h = setup();
  h.failDraft();
  h.setLocal(localDraft(draft()));
  await h.c.startOnlineExam('exam');
  assertRestored(h);
});

test('newest draft wins regardless of whether it is remote or local', async () => {
  for (const source of ['local', 'remote']) {
    const h = setup();
    const old = draft({ answers: { q1: 1 }, updatedAtMs: now - 10000 });
    h.setRemote(source === 'remote' ? draft() : old);
    h.setLocal(localDraft(source === 'local' ? draft() : old));
    await h.c.startOnlineExam('exam');
    assertRestored(h);
  }
});

test('cancel restores no answers and starts fresh once', async () => {
  const h = setup();
  let confirms = 0;
  h.c.confirm = () => { confirms++; return false; };
  await h.c.startOnlineExam('exam');
  assert.equal(confirms, 1);
  assert.equal(Object.keys(h.c.onlineExamStudentAnswers).length, 0);
  assert.equal(h.c.onlineExamTimeRemaining, 900);
  assert.equal(h.nodes.onlineExamAnsweredCount.textContent, 0);
  assert.deepEqual(h.events, ['delete', 'autosave', 'save', 'timer']);
});

test('missing or expired drafts use the existing fresh-start behavior', async () => {
  for (const saved of [null, draft({ deadlineAtMs: now - 1 })]) {
    const h = setup(); h.setRemote(saved);
    await h.c.startOnlineExam('exam');
    assert.equal(h.prompts.length, 0);
    assert.equal(h.c.onlineExamTimeRemaining, 900);
    assert.equal(Object.keys(h.c.onlineExamStudentAnswers).length, 0);
  }
});

test('failed start releases the lock so the student can retry', async () => {
  const h = setup(); h.failResults(true);
  await h.c.startOnlineExam('exam');
  assert.equal(h.c.onlineExamStartPending, false);
  assert.equal(h.alerts.length, 1);
  h.failResults(false);
  await h.c.startOnlineExam('exam');
  assertRestored(h);
});

test('submitted exams remain blocked and do not prompt to restore', async () => {
  const h = setup(); h.setResults([{ resultStatus: 'submitted' }]);
  await h.c.startOnlineExam('exam');
  assert.equal(h.prompts.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.alerts.length, 1);
});
