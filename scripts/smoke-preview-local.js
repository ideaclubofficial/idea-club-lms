const fs = require('fs');

function padNumber(num, size) { return String(num).padStart(size, '0'); }
function parseTimeToMinutes(t) { if (!t) return null; const m = t.match(/^(\d{1,2}):(\d{2})$/); if(!m) return null; return Number(m[1])*60+Number(m[2]); }
function isTimeOverlap(startA, endA, startB, endB) { const a = parseTimeToMinutes(startA); const b = parseTimeToMinutes(endA); const c = parseTimeToMinutes(startB); const d = parseTimeToMinutes(endB); if (a===null||b===null||c===null||d===null) return false; return a < d && c < b; }

const MONTHLY_PLAN_DAYS = [ { key: 'monday', jsDay: 1 }, { key: 'tuesday', jsDay: 2 }, { key: 'wednesday', jsDay: 3 }, { key: 'thursday', jsDay: 4 }, { key: 'friday', jsDay: 5 }, { key: 'saturday', jsDay: 6 }, { key: 'sunday', jsDay: 0 } ];
function getMonthlyPlanDayKey(date) { const item = MONTHLY_PLAN_DAYS.find(d=>d.jsDay===date.getDay()); return item?item.key:''; }

function generateMonthlySessionsFromPattern(plan) {
  const parts = plan.monthKey.split('-'); const year=Number(parts[0]); const monthIndex=Number(parts[1])-1; const daysInMonth = new Date(year, monthIndex+1, 0).getDate(); const nowText = new Date().toLocaleString('th-TH'); const sessions = [];
  for (let dayNumber=1; dayNumber<=daysInMonth; dayNumber++){
    const date = new Date(year, monthIndex, dayNumber);
    const dayKey = getMonthlyPlanDayKey(date);
    const dateText = plan.monthKey + '-' + padNumber(dayNumber,2);
    (plan.pattern.onsiteSlots||[]).forEach(slot=>{ if (slot.day!==dayKey) return; sessions.push({ planId: plan.id||plan.firebaseDocId, monthKey: plan.monthKey, monthText: plan.monthText, month: plan.monthText, date: dateText, sessionDate: dateText, dayName: dayKey, type:'onsite', center: plan.center, courseId: plan.courseId, courseName: plan.courseName, subject:'', teacherUid:'', teacherId:'', teacherName:'', topic:'', timeStart: slot.startTime||'', timeEnd: slot.endTime||'', publishTime:'', status:'draft', publishStatus:'', isHoliday:false, createdAtText: nowText, updatedAtText: nowText }); });
    (plan.pattern.onlineSlots||[]).forEach(slot=>{ if(slot.day!==dayKey) return; sessions.push(Object.assign({}, { planId: plan.id||plan.firebaseDocId, monthKey: plan.monthKey, monthText: plan.monthText, month: plan.monthText, date: dateText, sessionDate: dateText, dayName: dayKey, type:'online', center: plan.center, courseId: plan.courseId, courseName: plan.courseName, subject:'', teacherUid:'', teacherId:'', teacherName:'', topic:'', timeStart: slot.startTime||'', timeEnd: slot.endTime||'', publishTime:'', status:'draft', publishStatus:'', isHoliday:false, createdAtText: nowText, updatedAtText: nowText })); });
    (plan.pattern.ondemandSlots||[]).forEach(slot=>{ if(slot.day!==dayKey) return; sessions.push({ planId: plan.id||plan.firebaseDocId, monthKey: plan.monthKey, monthText: plan.monthText, month: plan.monthText, date: dateText, sessionDate: dateText, dayName: dayKey, type:'ondemand', center: plan.center, courseId: plan.courseId, courseName: plan.courseName, subject:'', teacherUid:'', teacherId:'', teacherName:'', topic:'', timeStart:'', timeEnd:'', publishTime: slot.publishTime||'', status:'draft', publishStatus:'planned', isHoliday:false, createdAtText: nowText, updatedAtText: nowText }); });
  }
  return sessions;
}

function normalizeSubjectWeights(subjectWeights, balanceMode) {
  const DEFAULT = [ { subject: 'Math', weight:1 }, { subject:'Science', weight:1 }, { subject:'English', weight:1 } ];
  const source = Array.isArray(subjectWeights) && subjectWeights.length ? subjectWeights : DEFAULT;
  const rows = source.map(item=>({ subject: String(item.subject||'').trim(), weight: Number(item.weight) })).filter(i=>!!i.subject).map(i=>({ subject: i.subject, weight: Number.isFinite(i.weight)&&i.weight>0?i.weight:0 }));
  const normalized = rows.length?rows: DEFAULT.map(i=>Object.assign({},i));
  const allZero = normalized.every(i=>Number(i.weight||0)<=0);
  if (balanceMode==='equal' || allZero) return normalized.map(i=>({ subject: i.subject, weight:1 }));
  return normalized;
}

function generateSubjectDistribution(totalCount, subjectWeights) {
  const weights = normalizeSubjectWeights(subjectWeights || [], 'weighted');
  const totalWeight = weights.reduce((s,w)=>s+ (Number(w.weight)||0),0) || weights.length;
  const parts = weights.map((item,index)=>{ const raw = totalCount * (Number(item.weight)||0)/ totalWeight; return { subject: item.subject, raw: raw, floor: Math.floor(raw), remainder: raw - Math.floor(raw), index: index }; });
  let assigned = parts.reduce((s,p)=>s+p.floor,0);
  let remaining = totalCount - assigned;
  parts.slice().sort((a,b)=> b.remainder - a.remainder || a.index - b.index).forEach(p=>{ if (remaining>0){ p.floor+=1; remaining-=1; } });
  const pool = [];
  parts.forEach(p=>{ for(let i=0;i<p.floor;i++) pool.push(p.subject); });
  const counts = {};
  pool.forEach(s=>{ counts[s]=(counts[s]||0)+1; });
  const result = [];
  while (Object.keys(counts).length){ const candidates = Object.keys(counts).sort((a,b)=> counts[b]-counts[a]); let chosen=null; for(let i=0;i<candidates.length;i++){ if (candidates[i]!== result[result.length-1]){ chosen=candidates[i]; break; } } if(!chosen) chosen=candidates[0]; result.push(chosen); counts[chosen]-=1; if(counts[chosen]<=0) delete counts[chosen]; }
  return result;
}

function isTeacherAvailableForSession(teacherId, date, start, end, previewList, existingSessions){ if(!teacherId) return false; const key = String(teacherId||''); const checkAgainst = (previewList||[]).concat(existingSessions||[]); for(let i=0;i<checkAgainst.length;i++){ const s=checkAgainst[i]; const sTeacherKey=String(s.teacherId||s.teacherUid||s.teacherAuthUid||''); if(!sTeacherKey|| String(sTeacherKey)!== key) continue; const sDate = s.date || s.sessionDate || ''; if(!sDate || sDate!==date) continue; const rangeStart = s.timeStart || s.sessionTime || s.publishTime || ''; const rangeEnd = s.timeEnd || ''; if(!rangeStart || !rangeEnd || !start || !end) continue; if (isTimeOverlap(start,end, rangeStart, rangeEnd)) return false; } return true; }

function buildPlan(courseId, courseName, monthKey, subjectWeights){ return { id:'plan-'+courseId, firebaseDocId:'plan-'+courseId, monthKey: monthKey, monthText: monthKey, center:'HQ', courseId: courseId, courseName: courseName, subjectWeights: subjectWeights||[], pattern: { onsiteSlots: [ { day: 'monday', startTime: '10:00', endTime: '11:00' } ], onlineSlots: [ { day: 'tuesday', startTime: '15:00', endTime: '16:00' } ], ondemandSlots: [ { day:'wednesday', publishTime:'12:00' } ] } }; }

function runTests(){ const results = [];
  // Test 1: all weights zero
  let teachers=[], courses=[], courseTeachingSettings=[], monthlyPlanSessions=[], holidays=[];
  teachers.push({ id:'t1', name:'Teacher One' }); courses.push({ id:'c1', name:'Course One'});
  courseTeachingSettings.push({ courseId:'c1', subjects:[ { subject:'Math', weight:0, primaryTeacherId:'t1', backupTeacherIds:[] }, { subject:'Eng', weight:0, primaryTeacherId:'', backupTeacherIds:[] } ] });
  const plan1 = buildPlan('c1','Course One','2026-06', [ { subject:'Math', weight:0 }, { subject:'Eng', weight:0 } ]);
  const candidates1 = generateMonthlySessionsFromPattern(plan1);
  const distribution1 = generateSubjectDistribution(candidates1.length, plan1.subjectWeights||[]);
  const preview1=[]; let di=0; candidates1.forEach(cand=>{ const copy=Object.assign({},cand); copy.subject = distribution1[di++]||''; copy.problem=''; const cs = courseTeachingSettings.find(c=>String(c.courseId)==String(plan1.courseId)); if(cs){ const subj = (cs.subjects||[]).find(s=>String(s.subject||'').trim().toLowerCase()===String(copy.subject||'').trim().toLowerCase()); if(subj && subj.primaryTeacherId){ if(isTeacherAvailableForSession(subj.primaryTeacherId, copy.date, cand.timeStart, cand.timeEnd, preview1, monthlyPlanSessions)){ copy.teacherId = subj.primaryTeacherId; copy.teacherName = subj.primaryTeacherId; } else if(Array.isArray(subj.backupTeacherIds)){ let assigned=false; subj.backupTeacherIds.forEach(bid=>{ if(assigned) return; if(isTeacherAvailableForSession(bid, copy.date, cand.timeStart, cand.timeEnd, preview1, monthlyPlanSessions)){ copy.teacherId=bid; copy.teacherName=bid; assigned=true; } }); if(!assigned && !copy.teacherId) copy.problem='ต้องเลือกครู'; } else copy.problem='ต้องเลือกครู'; } else { copy.problem = copy.subject ? 'ไม่มีครู' : 'ไม่มีวิชา'; } } else { copy.problem = copy.subject ? '' : 'ไม่มีวิชา'; } if(copy.teacherId && !isTeacherAvailableForSession(copy.teacherId, copy.date, cand.timeStart, cand.timeEnd, preview1, monthlyPlanSessions)) copy.problem='ครูชนเวลา'; preview1.push(copy); });
  results.push({ name:'all-weights-zero', totalCandidates: candidates1.length, previewSample: preview1.slice(0,3) });

  // Test 2: single subject
  teachers=[]; courses=[]; courseTeachingSettings=[]; monthlyPlanSessions=[];
  teachers.push({ id:'t1', name:'Teacher One' }); courses.push({ id:'c1', name:'Course One'});
  courseTeachingSettings.push({ courseId:'c1', subjects:[ { subject:'Math', weight:1, primaryTeacherId:'t1', backupTeacherIds:[] } ] });
  const plan2 = buildPlan('c1','Course One','2026-06', [ { subject:'Math', weight:1 } ]);
  const candidates2 = generateMonthlySessionsFromPattern(plan2);
  const distribution2 = generateSubjectDistribution(candidates2.length, plan2.subjectWeights||[]);
  const preview2=[]; di=0; candidates2.forEach(cand=>{ const copy=Object.assign({},cand); copy.subject=distribution2[di++]||''; copy.problem=''; const cs = courseTeachingSettings.find(c=>String(c.courseId)==String(plan2.courseId)); if(cs){ const subj = (cs.subjects||[]).find(s=>String(s.subject||'').trim().toLowerCase()===String(copy.subject||'').trim().toLowerCase()); if(subj && subj.primaryTeacherId){ if(isTeacherAvailableForSession(subj.primaryTeacherId, copy.date, cand.timeStart, cand.timeEnd, preview2, monthlyPlanSessions)){ copy.teacherId = subj.primaryTeacherId; copy.teacherName = subj.primaryTeacherId; } else copy.problem='ต้องเลือกครู'; } else copy.problem = copy.subject ? 'ไม่มีครู' : 'ไม่มีวิชา'; } else copy.problem = copy.subject ? '' : 'ไม่มีวิชา'; if(copy.teacherId && !isTeacherAvailableForSession(copy.teacherId, copy.date, cand.timeStart, cand.timeEnd, preview2, monthlyPlanSessions)) copy.problem='ครูชนเวลา'; preview2.push(copy); });
  results.push({ name:'single-subject', totalCandidates: candidates2.length, subjectCounts: distribution2.reduce((acc,s)=>{ acc[s]=(acc[s]||0)+1; return acc; },{}), previewSample: preview2.slice(0,3) });

  // Test 3: primary conflict -> backup
  teachers=[]; courses=[]; courseTeachingSettings=[]; monthlyPlanSessions=[];
  teachers.push({ id:'tp', name:'Primary' }); teachers.push({ id:'tb', name:'Backup' }); courses.push({ id:'c2', name:'Course Two'});
  courseTeachingSettings.push({ courseId:'c2', subjects:[ { subject:'Sci', weight:1, primaryTeacherId:'tp', backupTeacherIds:['tb'] } ] });
  // Add existing conflicting session on 2026-06-02 10:00-11:00 for tp
  monthlyPlanSessions.push({ id:'existing1', date:'2026-06-02', timeStart:'10:00', timeEnd:'11:00', teacherId:'tp' });
  const plan3 = buildPlan('c2','Course Two','2026-06', [ { subject:'Sci', weight:1 } ]);
  const candidates3 = generateMonthlySessionsFromPattern(plan3);
  const distribution3 = generateSubjectDistribution(candidates3.length, plan3.subjectWeights||[]);
  const preview3=[]; di=0; candidates3.forEach(cand=>{ const copy=Object.assign({},cand); copy.subject=distribution3[di++]||''; copy.problem=''; const cs = courseTeachingSettings.find(c=>String(c.courseId)==String(plan3.courseId)); if(cs){ const subj=(cs.subjects||[]).find(s=>String(s.subject||'').trim().toLowerCase()===String(copy.subject||'').trim().toLowerCase()); if(subj && subj.primaryTeacherId){ if(isTeacherAvailableForSession(subj.primaryTeacherId, copy.date, cand.timeStart, cand.timeEnd, preview3, monthlyPlanSessions)){ copy.teacherId=subj.primaryTeacherId; } else if(Array.isArray(subj.backupTeacherIds)){ let assigned=false; subj.backupTeacherIds.forEach(bid=>{ if(assigned) return; if(isTeacherAvailableForSession(bid, copy.date, cand.timeStart, cand.timeEnd, preview3, monthlyPlanSessions)){ copy.teacherId=bid; assigned=true; } }); if(!assigned && !copy.teacherId) copy.problem='ต้องเลือกครู'; } } else copy.problem = copy.subject ? 'ไม่มีครู' : 'ไม่มีวิชา'; } if(copy.teacherId && !isTeacherAvailableForSession(copy.teacherId, copy.date, cand.timeStart, cand.timeEnd, preview3, monthlyPlanSessions)) copy.problem='ครูชนเวลา'; preview3.push(copy); });
  results.push({ name:'primary-conflict-uses-backup', totalCandidates: candidates3.length, previewSample: preview3.slice(0,10) });

  // Test 4: no teachers
  teachers=[]; courses=[]; courseTeachingSettings=[]; monthlyPlanSessions=[];
  courses.push({ id:'c3', name:'Course Three' });
  courseTeachingSettings.push({ courseId:'c3', subjects:[ { subject:'Art', weight:1, primaryTeacherId:'', backupTeacherIds:[] } ] });
  const plan4 = buildPlan('c3','Course Three','2026-06', [ { subject:'Art', weight:1 } ]);
  const candidates4 = generateMonthlySessionsFromPattern(plan4);
  const distribution4 = generateSubjectDistribution(candidates4.length, plan4.subjectWeights||[]);
  const preview4=[]; di=0; candidates4.forEach(cand=>{ const copy=Object.assign({},cand); copy.subject=distribution4[di++]||''; copy.problem=''; const cs=courseTeachingSettings.find(c=>String(c.courseId)==String(plan4.courseId)); if(cs){ const subj=(cs.subjects||[]).find(s=>String(s.subject||'').trim().toLowerCase()===String(copy.subject||'').trim().toLowerCase()); if(subj && subj.primaryTeacherId){ if(isTeacherAvailableForSession(subj.primaryTeacherId, copy.date, cand.timeStart, cand.timeEnd, preview4, monthlyPlanSessions)){ copy.teacherId=subj.primaryTeacherId; } else if(Array.isArray(subj.backupTeacherIds)){ let assigned=false; subj.backupTeacherIds.forEach(bid=>{ if(assigned) return; if(isTeacherAvailableForSession(bid, copy.date, cand.timeStart, cand.timeEnd, preview4, monthlyPlanSessions)){ copy.teacherId=bid; assigned=true; } }); if(!assigned && !copy.teacherId) copy.problem='ต้องเลือกครู'; } } else copy.problem = copy.subject ? 'ไม่มีครู' : 'ไม่มีวิชา'; } if(copy.teacherId && !isTeacherAvailableForSession(copy.teacherId, copy.date, cand.timeStart, cand.timeEnd, preview4, monthlyPlanSessions)) copy.problem='ครูชนเวลา'; preview4.push(copy); });
  results.push({ name:'no-teachers', totalCandidates: candidates4.length, previewSample: preview4.slice(0,5) });

  console.log(JSON.stringify(results, null, 2)); }

runTests();
