const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const INDEX = path.resolve(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');

function waitLoad(dom) {
  return new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') return resolve();
    dom.window.addEventListener('load', function() { setTimeout(resolve, 50); });
  });
}

(async function(){
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'file://' + INDEX });
  await waitLoad(dom);
  const w = dom.window;

  // Helper to reset global arrays
  function resetGlobals() {
    w.teachers.length = 0;
    w.courses.length = 0;
    w.courseTeachingSettings.length = 0;
    w.teacherPreferenceRules.length = 0;
    w.monthlyPlanSessions.length = 0;
    w.monthlyPlanSessionPreview.length = 0;
    w.holidays.length = 0;
  }

  function addTeacher(id, name) { w.teachers.push({ id: id, firebaseDocId: id, name: name }); }
  function addCourse(id, name) { w.courses.push({ id: id, firebaseDocId: id, name: name, title: name }); }
  function setForm(monthKey, courseId) {
    const monthEl = w.document.getElementById('monthlyPlanGeneratorMonthKey');
    const courseEl = w.document.getElementById('monthlyPlanGeneratorCourse');
    if (monthEl) monthEl.value = monthKey;
    if (courseEl) {
      // ensure option exists
      let opt = Array.from(courseEl.options).find(o => o.value === courseId);
      if (!opt) {
        const o = w.document.createElement('option'); o.value = courseId; o.text = courseId; courseEl.appendChild(o);
      }
      courseEl.value = courseId;
    }
  }

  function runPreviewWithPlan(plan) {
    // plan must be a valid monthly plan object
    try {
      const candidates = w.generateMonthlySessionsFromPattern(plan);
      const preview = [];
      const distribution = w.generateSubjectDistribution(candidates.length, plan.subjectWeights || []);
      let distIndex = 0;
      const courseSetting = w.courseTeachingSettings.find(function(c) { return String(c.courseId || '') === String(plan.courseId || ''); });
      candidates.forEach(function(cand) {
        const copy = Object.assign({}, cand);
        copy.subject = distribution[distIndex++] || '';
        copy.problem = '';
        if (courseSetting && Array.isArray(courseSetting.subjects)) {
          const subj = courseSetting.subjects.find(function(s) { return String((s.subject||'')).trim().toLowerCase() === String((copy.subject||'')).trim().toLowerCase(); });
          if (subj && subj.primaryTeacherId) {
            if (w.isTeacherAvailableForSession(subj.primaryTeacherId, w.getMonthlySessionDate(copy), w.getMonthlySessionTimeRange(copy).start, w.getMonthlySessionTimeRange(copy).end, preview)) {
              copy.teacherId = subj.primaryTeacherId; copy.teacherName = w.getTeacherNameById(subj.primaryTeacherId);
            } else if (Array.isArray(subj.backupTeacherIds)) {
              let assigned = false;
              subj.backupTeacherIds.forEach(function(bid) {
                if (assigned) return;
                if (w.isTeacherAvailableForSession(bid, w.getMonthlySessionDate(copy), w.getMonthlySessionTimeRange(copy).start, w.getMonthlySessionTimeRange(copy).end, preview)) {
                  copy.teacherId = bid; copy.teacherName = w.getTeacherNameById(bid); assigned = true;
                }
              });
              if (!assigned && !copy.teacherId) copy.problem = 'ต้องเลือกครู';
            } else {
              copy.problem = 'ต้องเลือกครู';
            }
          } else {
            copy.problem = copy.subject ? 'ไม่มีครู' : 'ไม่มีวิชา';
          }
        } else {
          copy.problem = copy.subject ? '' : 'ไม่มีวิชา';
        }
        if (copy.teacherId && !w.isTeacherAvailableForSession(copy.teacherId, w.getMonthlySessionDate(copy), w.getMonthlySessionTimeRange(copy).start, w.getMonthlySessionTimeRange(copy).end, preview)) {
          copy.problem = 'ครูชนเวลา';
        }
        preview.push(copy);
      });
      return { preview };
    } catch (err) {
      return { error: String(err) };
    }
  }

  const results = [];

  // Test helper to build a minimal valid plan
  function buildPlan(courseId, courseName, monthKey, subjectWeights) {
    return {
      id: 'plan-' + courseId,
      firebaseDocId: 'plan-' + courseId,
      monthKey: monthKey,
      monthText: monthKey,
      center: 'HQ',
      courseId: courseId,
      courseName: courseName,
      subjectWeights: subjectWeights || [],
      pattern: {
        onsiteSlots: [ { day: 'monday', startTime: '10:00', endTime: '11:00' } ],
        onlineSlots: [ { day: 'tuesday', startTime: '15:00', endTime: '16:00' } ],
        ondemandSlots: [ { day: 'wednesday', publishTime: '12:00' } ]
      }
    };
  }

  // Test 1: All weights zero
  resetGlobals();
  addTeacher('t1','Teacher One');
  addCourse('c1','Course One');
  w.courseTeachingSettings.push({ courseId: 'c1', subjects: [ { subject: 'Math', weight: 0, primaryTeacherId: 't1', backupTeacherIds: [] }, { subject: 'Eng', weight: 0, primaryTeacherId: '', backupTeacherIds: [] } ] });
  results.push({ name: 'all-weights-zero', result: runPreviewWithPlan(buildPlan('c1','Course One','2026-06', [ { subject: 'Math', weight:0 }, { subject: 'Eng', weight:0 } ])) });

  // Test 2: Single subject
  resetGlobals();
  addTeacher('t1','Teacher One');
  addCourse('c1','Course One');
  w.courseTeachingSettings.push({ courseId: 'c1', subjects: [ { subject: 'Math', weight: 1, primaryTeacherId: 't1', backupTeacherIds: [] } ] });
  results.push({ name: 'single-subject', result: runPreviewWithPlan(buildPlan('c1','Course One','2026-06', [ { subject: 'Math', weight:1 } ])) });

  // Test 3: Primary conflict -> backup used
  resetGlobals();
  addTeacher('tp','Primary');
  addTeacher('tb','Backup');
  addCourse('c2','Course Two');
  w.courseTeachingSettings.push({ courseId: 'c2', subjects: [ { subject: 'Sci', weight: 1, primaryTeacherId: 'tp', backupTeacherIds: ['tb'] } ] });
  // Create existing session that conflicts with first candidate session time
  const conflictSession = { id: 'existing1', firebaseDocId: 'existing1', date: '2026-06-02', timeStart: '10:00', timeEnd: '11:00', teacherId: 'tp', teacherUid: 'tp', status: 'draft' };
  w.monthlyPlanSessions.push(conflictSession);
  results.push({ name: 'primary-conflict-uses-backup', preExisting: conflictSession, result: runPreviewWithPlan(buildPlan('c2','Course Two','2026-06', [ { subject: 'Sci', weight:1 } ])) });

  // Test 4: No teachers available
  resetGlobals();
  addCourse('c3','Course Three');
  w.courseTeachingSettings.push({ courseId: 'c3', subjects: [ { subject: 'Art', weight: 1, primaryTeacherId: '', backupTeacherIds: [] } ] });
  results.push({ name: 'no-teachers', result: runPreviewWithPlan(buildPlan('c3','Course Three','2026-06', [ { subject: 'Art', weight:1 } ])) });

  // Print summary
  console.log('SMOKE TEST RESULTS:');
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
})();
