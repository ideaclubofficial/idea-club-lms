const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const featureSource = html.slice(html.indexOf('    const STUDENT_FEATURE_VIEWS ='), html.indexOf('    function resetStudentDataSession('));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
function setup() {
  const reads = [], renders = [], liveStarts = [], roots = {};
  let observer;
  function element() {
    return { attrs: {}, children: [], innerHTML: '', className: '',
      setAttribute(k,v) { this.attrs[k]=v; }, getAttribute(k) {return this.attrs[k];},
      querySelector(selector) { return this.children.find(x=>'.'+x.className.split(' ')[0]===selector)||null; },
      prepend(child) {child.parent=this;this.children.unshift(child);},
      remove() {this.parent.children=this.parent.children.filter(x=>x!==this);} };
  }
  for(const id of ['studentDashboard','student-learning','student-monthly-test','studentGamificationPanel','studentMobileGamificationPanel'])roots[id]=element();
  const c = {
    firebaseUser:{uid:'A'},firebaseUserProfile:{},studentDataSessionUid:'A',studentDataSessionVersion:1,studentDataLoadedForUid:'A',
    currentStudent:{id:'A'},onlineExamCoursesLoadSeq:0,onlineExamCoursesLoaded:false,onlineExamCourseCache:[],prizeWheelSettings:{},
    studentRealtimeSession:{studentDocIds:['A'],paymentStudentIds:['A'],groups:{}},
    isCurrentStudentSession:()=>true, getElement:id=>roots[id]||null,
    document:{createElement:element},console:{warn(){}},safeRun:fn=>fn(),
    ensureStudentDataLoaded:async()=>c.currentStudent,
    getFirebaseCollectionQuiet:async(name,deleted,status)=>{reads.push(name);return [{id:name}];},
    replaceArray:(a,b)=>a.splice(0,a.length,...b),
    getCurrentStudentCourse:()=>({id:'course'}),getStudentMediaEntitledCourses:()=>[],studentCanUseCourseEntitlements:()=>true,getProfileGrade:()=>'',
    startStudentPaymentListeners:(ids,uid,paymentIds,names)=>{
      liveStarts.push(...names); for(const name of names)c.studentRealtimeSession.groups[name]={ready:Promise.resolve(true),failed:false};
    },
    waitForRealtimeCollection:async(live,name,status)=>{if(!await live.groups[name].ready)status.failed=true;},
    IntersectionObserver:class {constructor(callback){observer=this;this.callback=callback;this.targets=[];}observe(root){this.targets.push(root);}disconnect(){this.disconnected=true;}}
  };
  function query(name) { return {where(){return this;},orderBy(){return this;},limit(){return this;},get:async()=>{reads.push(name);return {docs:[{id:name,data:()=>({id:name})}]};}}; }
  c.db={collection:query};
  for(const name of ['onDemandClips','monthlyExamLinks','leaderboardProfiles','gamificationRewards','specialVoucherActivities','prizeWheelItems','prizeWheelSpins','avatarBattleQuestions','gamificationRedemptions'])c[name]=[];
  for(const name of ['renderStudentOnlineClasses','renderStudentOnDemandClasses','renderStudentMobileLearning','renderStudentExamFilters','renderScoreHistoryByMonth','renderStudentMobileExam','renderOnlineExamCourseGrid','updateStudentInWebExamUx','renderStudentGamificationPanel']) c[name]=()=>renders.push(name);
  vm.createContext(c);vm.runInContext(featureSource,c);
  return {c,reads,renders,liveStarts,roots,get observer(){return observer;}};
}

test('preparing UI performs no reads; visible learning section fetches only clips',async()=>{
  const h=setup();h.c.prepareStudentFeatureViews();assert.deepEqual(h.reads,[]);
  assert.equal(h.roots['student-learning'].attrs['data-student-feature-state'],'idle');
  h.observer.callback([{isIntersecting:true,target:h.roots['student-learning']}]);
  await h.c.ensureStudentFeatureData('learning');
  assert.deepEqual(h.reads,['onDemandClips']);assert.equal(h.c.onDemandClips.length,1);
  assert.equal(h.roots['student-learning'].attrs['data-student-feature-state'],'ready');
});

test('feature waits for home and concurrent requests including force share one load',async()=>{
  const h=setup(),gate=deferred();h.c.ensureStudentDataLoaded=()=>gate.promise;
  const tasks=[h.c.ensureStudentFeatureData('learning'),h.c.ensureStudentFeatureData('learning',true)];
  assert.deepEqual(h.reads,[]);assert.equal(h.roots['student-learning'].attrs['aria-busy'],'true');
  gate.resolve(h.c.currentStudent);await Promise.all(tasks);
  await h.c.ensureStudentFeatureData('learning');assert.equal(h.reads.length,1);
  await h.c.ensureStudentFeatureData('learning',true);assert.equal(h.reads.length,2);
});

test('failed fetch shows retry state and does not publish incomplete arrays',async()=>{
  const h=setup();h.c.getFirebaseCollectionQuiet=async(name,deleted,status)=>{status.failed=true;return [];};
  await assert.rejects(h.c.ensureStudentFeatureData('learning'));
  assert.equal(h.roots['student-learning'].attrs['data-student-feature-state'],'error');
  assert.match(h.roots['student-learning'].children[0].innerHTML,/ลองใหม่/);
  h.c.getFirebaseCollectionQuiet=async()=>[{id:'clip'}];
  assert.equal(await h.c.ensureStudentFeatureData('learning'),true);
  assert.equal(h.c.onDemandClips[0].id,'clip');
});

test('account change discards old feature result and never renders it',async()=>{
  const h=setup(),gate=deferred(),started=deferred();
  h.c.getFirebaseCollectionQuiet=()=>{started.resolve();return gate.promise;};
  const loading=h.c.ensureStudentFeatureData('learning');await started.promise;
  h.c.resetStudentFeatureData();h.c.studentDataSessionVersion++;h.c.firebaseUser={uid:'B'};
  gate.resolve([{id:'old-A'}]);assert.equal(await loading,false);
  assert.equal(h.c.onDemandClips.length,0);assert.equal(h.renders.length,0);
});

test('games share exam dependency and add only the two deferred realtime groups',async()=>{
  const h=setup();await Promise.all([h.c.ensureStudentFeatureData('games'),h.c.ensureStudentFeatureData('exams')]);
  assert.equal(h.reads.filter(x=>x==='onlineExamCourses').length,2);
  assert.equal(h.reads.filter(x=>x==='monthlyExamLinks').length,1);
  assert.ok(!h.reads.includes('onDemandClips'));
  assert.deepEqual(h.liveStarts,['gamificationRedemptions','prizeWheelSpins']);
  assert.equal(h.c.onlineExamCourseCache.length,1);
  assert.equal(h.c.isStudentFeatureReady('games'),true);
});

test('failed exam dependency keeps games unavailable and retry recovers',async()=>{
  const h=setup(),original=h.c.db.collection;
  h.c.db.collection=name=>{if(name==='onlineExamCourses')return {where(){return this;},get:async()=>{throw new Error('offline');}};return original(name);};
  await assert.rejects(h.c.ensureStudentFeatureData('games'),/offline/);
  assert.equal(h.roots.studentGamificationPanel.attrs['data-student-feature-state'],'error');
  assert.equal(h.liveStarts.length,0);
  h.c.db.collection=original;await h.c.ensureStudentFeatureData('games');
  assert.equal(h.c.isStudentFeatureReady('games'),true);
});

test('home loading/error states expose a retry and ready removes the notice',()=>{
  const h=setup();h.c.updateStudentHomeLoadStatus('loading');
  assert.equal(h.roots.studentDashboard.attrs['aria-busy'],'true');
  h.c.updateStudentHomeLoadStatus('error');assert.match(h.roots.studentDashboard.children[0].innerHTML,/ลองใหม่/);
  h.c.updateStudentHomeLoadStatus('ready');assert.equal(h.roots.studentDashboard.children.length,0);
});
