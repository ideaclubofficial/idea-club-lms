const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const staffSource=html.slice(html.indexOf('    const STAFF_DATA_GROUPS ='),html.indexOf('    async function ensureCoreDataLoaded('));
function source(name){const m=new RegExp('^    (?:async )?function '+name+'\\(','m').exec(html);return html.slice(m.index,html.indexOf('\n    }',m.index)+6);}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function setup(){
 const reads=[],renders=[],attendanceLoads=[],roots={};
 function element(){return {style:{},parentElement:null,hidden:false,attrs:{},children:[],classList:{hidden:false,contains(k){return k==='hidden'&&this.hidden;}},setAttribute(k,v){this.attrs[k]=v;},querySelector(){return this.children[0]||null;},prepend(n){n.parent=this;this.children.unshift(n);},remove(){this.parent.children=[];}};}
 for(const id of ['admin-video','admin-courses','admin-dashboard','admin-settings','teacher-dashboard','teacher-attendance'])roots[id]=element();
 const c={firebaseReady:true,db:{},firebaseUser:{uid:'A'},studentDataSessionVersion:1,coreDataLoaded:false,PRODUCTION_MODE:true,
   firestoreQuotaBlocked:false,isQuotaOptimizedLoadingEnabled:()=>false,
   adminRealtimeSession:null,isCurrentStudentSession:()=>false,startAdminPaymentDataListeners:()=>null,
   courseEndScheduleTimer:null,courseEndScheduleProcessing:false,clearInterval(){},startCourseEndScheduleChecks(){},
   getFirebaseCollection:async(name,deleted,status)=>{reads.push(name);return [{id:name}];},getFirebasePaymentCollection:async()=>{reads.push('payments');return [{id:'bill'}];},
   applyPaymentRepairsSync() {}, safeRun:fn=>fn(),replaceArray:(a,b)=>a.splice(0,a.length,...b),rebuildStudentLookupMap(){},applySystemSettingsToPage(){},cacheStartupSettings(){},systemSettings:{},prizeWheelSettings:{},
   getElement:id=>roots[id]||null,document:{createElement:element},console:{warn(){},error(){}},
   getPickupDateValue:()=> '2026-11-09',isAttendanceRosterReadyForDate:()=>true,
   loadAttendanceRosterForDate:async date=>{attendanceLoads.push(date);},
   canOpenAdminTab:()=>true,canOpenTeacherTab:()=>true,canOpenTeacherTool:()=>true,
   renderAdminTabContent:id=>renders.push(id),renderTeacherTabContent:id=>renders.push(id)
 };
 for(const name of source('getStaffCollectionTargets').match(/return \{([\s\S]*?)\};/)[1].match(/\b\w+\b/g))if(!c[name])c[name]=[];
 vm.createContext(c);vm.runInContext(staffSource,c);vm.runInContext(source('loadCoreDataFromFirebase'),c);
 return {c,reads,renders,attendanceLoads,roots};
}

test('staff core requests only the five base collections and never repairs records',async()=>{
 const h=setup();await h.c.loadCoreDataFromFirebase();
 assert.deepEqual(h.reads.sort(),['courseEnrollments','courses','settings','students','teachers']);assert.equal(h.c.coreDataLoaded,true);
 assert.ok(!source('loadCoreDataFromFirebase').includes('repair'));
});

test('quota optimized staff startup reads settings only and defers tab datasets',async()=>{
 const h=setup();h.c.isQuotaOptimizedLoadingEnabled=()=>true;await h.c.loadCoreDataFromFirebase();
 assert.deepEqual(h.reads,['settings']);
 assert.deepEqual(Array.from(h.c.getStaffTabCollections('admin-dashboard')),['settings']);
 assert.ok(h.c.getStaffTabCollections('admin-students').includes('courses'));
 assert.ok(!h.c.getStaffTabCollections('admin-students').includes('payments'));
  assert.deepEqual(Array.from(h.c.getStaffTabCollections('teacher-attendance')),['settings','attendanceHistory']);
});

test('quota optimized attendance skips generic 50-student page and uses date roster loader',async()=>{
 const h=setup();h.c.isQuotaOptimizedLoadingEnabled=()=>true;
 await h.c.requestStaffTabData('teacher-attendance');
 assert.deepEqual(h.reads,['settings','attendanceHistory']);
 assert.deepEqual(h.attendanceLoads,['2026-11-09']);
 assert.deepEqual(h.renders,['teacher-attendance']);
});

test('attendance shows the roster while history is pending and only becomes ready after history',async()=>{
 const h=setup(),gate=deferred(),started=deferred(),read=h.c.getFirebaseCollection;
 let rosterRenders=0;
 h.c.isQuotaOptimizedLoadingEnabled=()=>true;
 h.c.renderPickupList=()=>{rosterRenders++;};
 h.c.setAttendanceResult=()=>{};
 h.c.getFirebaseCollection=async(name,...args)=>{
   if(name==='attendanceHistory'){started.resolve();return gate.promise;}
   return read(name,...args);
 };
 const pending=h.c.requestStaffTabData('teacher-attendance');
 await started.promise;
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rosterRenders,1);
 assert.equal(h.roots['teacher-attendance'].attrs['data-staff-data-state'],'loading');
 assert.equal(h.c.isStaffCollectionReady('attendanceHistory'),false);
 gate.resolve([]);
 assert.equal(await pending,true);
 assert.equal(h.roots['teacher-attendance'].attrs['data-staff-data-state'],'ready');
});

test('attendance changes are blocked until both roster and history are ready',()=>{
 const h=setup();let message='';
 h.c.setAttendanceResult=text=>{message=text;};
 vm.runInContext(source('attendanceDataReadyForChanges'),h.c);
 assert.equal(h.c.attendanceDataReadyForChanges(),false);
 assert.match(message,/โหลดไม่ครบ/);
 vm.runInContext("staffCollectionStates.attendanceHistory = { status: 'ready' }",h.c);
 assert.equal(h.c.attendanceDataReadyForChanges(),true);
 h.c.isAttendanceRosterReadyForDate=()=>false;
 assert.equal(h.c.attendanceDataReadyForChanges(),false);
});

test('teacher home loads schedules but not finance, scores, clips, games or expenses',async()=>{
 const h=setup();await h.c.requestStaffTabData('teacher-dashboard');
 assert.ok(h.reads.includes('monthlyPlanSessions'));assert.ok(h.reads.includes('attendanceHistory'));
 for(const name of ['payments','adminScoreRecords','onDemandClips','gamificationRewards','expenses'])assert.ok(!h.reads.includes(name),name);
 assert.deepEqual(h.renders,['teacher-dashboard']);
});

test('concurrent menus share base collection reads and revisit uses cache',async()=>{
 const h=setup();await Promise.all([h.c.requestStaffTabData('admin-video'),h.c.requestStaffTabData('admin-courses')]);
 for(const name of ['students','teachers','courses','courseEnrollments','settings'])assert.equal(h.reads.filter(x=>x===name).length,1,name);
 const count=h.reads.length;await h.c.requestStaffTabData('admin-video');assert.equal(h.reads.length,count);
});

test('late tab load cannot reopen a tab that the user left',async()=>{
 const h=setup(),gate=deferred(),started=deferred(),read=h.c.getFirebaseCollection;
 h.c.getFirebaseCollection=(name,...args)=>{if(name==='onDemandClips'){started.resolve();return gate.promise;}return read(name,...args);};
 const old=h.c.requestStaffTabData('admin-video');await started.promise;
 h.roots['admin-video'].classList.hidden=true;await h.c.requestStaffTabData('admin-courses');
 gate.resolve([{id:'clip'}]);await old;assert.deepEqual(h.renders,['admin-courses']);
});

test('failed required collection keeps content unavailable and retry fetches only failed data',async()=>{
 const h=setup(),read=h.c.getFirebaseCollection;
 h.c.getFirebaseCollection=async(name,deleted,status)=>{if(name==='onDemandClips'){status.failed=true;return [];}return read(name,deleted,status);};
 assert.equal(await h.c.requestStaffTabData('admin-video'),false);
 assert.equal(h.roots['admin-video'].attrs['data-staff-data-state'],'error');assert.equal(h.renders.length,0);
 h.c.getFirebaseCollection=read;await h.c.requestStaffTabData('admin-video');
 assert.equal(h.reads.filter(n=>n==='students').length,1);assert.deepEqual(h.renders,['admin-video']);
});

test('logout and re-login rejects old dataset and cannot clear newer pending work',async()=>{
 const h=setup(),gate=deferred(),started=deferred();
 h.c.getFirebaseCollection=async(name)=>{if(name==='onDemandClips'){started.resolve();return gate.promise;}return [];};
 const old=h.c.requestStaffTabData('admin-video');await started.promise;
 h.c.resetStaffDataSession();h.c.studentDataSessionVersion++;h.c.firebaseUser={uid:'B'};
 gate.resolve([{id:'old-user'}]);await old;
 assert.equal(h.c.onDemandClips.length,0);assert.equal(h.renders.length,0);
});

test('unauthorized menu and student session never trigger staff queries',async()=>{
 const h=setup();h.c.canOpenAdminTab=()=>false;h.c.canOpenTeacherTool=()=>false;
 assert.equal(await h.c.requestStaffTabData('admin-video'),false);assert.equal(h.reads.length,0);
 h.c.isCurrentStudentSession=()=>true;await assert.rejects(h.c.ensureStaffCollections(['students']));assert.equal(h.reads.length,0);
});

test('embedded teacher tool obeys visible parent and financial summary declares all inputs',()=>{
 const h=setup();const root=h.roots['admin-video'];root.parentElement={classList:{contains:()=>true},style:{},parentElement:null};
 assert.equal(h.c.isStaffTabVisible('admin-video'),false);root.parentElement=null;assert.equal(h.c.isStaffTabVisible('admin-video'),true);
 const names=h.c.getStaffTabCollections('admin-finance-summary');for(const name of ['payments','receipts','paymentBundles','paymentMonths','expenses'])assert.ok(names.includes(name),name);
});

test('backup waits for all datasets and refuses to download after a read failure',async()=>{
 const h=setup();let downloaded=false,message='';
 h.c.getFirebaseCollection=async()=>{throw new Error('offline');};h.c.alert=text=>message=text;h.c.confirm=()=>true;
 h.c.Blob=function(){downloaded=true;};vm.runInContext(source('exportAllDataBackup'),h.c);
 await h.c.exportAllDataBackup();assert.equal(downloaded,false);assert.match(message,/ข้อมูลสำรองไม่ครบ/);
});


test('teacher student list includes primary pupils beyond the first 50 and legacy records',async()=>{
 const h=setup();h.c.isQuotaOptimizedLoadingEnabled=()=>true;
 const rows={
  students:Array.from({length:50},(_,i)=>({id:'secondary-'+i,memberId:String(i).padStart(3,'0'),grade:'ม.1'})).concat([
   {id:'primary',memberId:'999',grade:'ป.4'}, {id:'legacy-primary',grade:'ป.5'}
  ]),
  courses:Array.from({length:100},(_,i)=>({id:'course-'+i,updatedAt:i})).concat([{id:'primary-course',grade:'ป.4'}])
 };
 h.c.COLLECTION_FETCH_LIMITS={students:{orderField:'memberId',limit:50},courses:{orderField:'updatedAt',limit:100}};
 h.c.rememberFirebaseDocument=()=>{};h.c.markFirestoreQuotaExceeded=()=>{};
 h.c.db={collection:name=>{
  let list=rows[name]||[];
  const q={orderBy(field){list=list.filter(r=>r[field]!==undefined);return q;},limit(n){list=list.slice(0,n);return q;},
   async get(){h.reads.push(name);return {docs:list.map(r=>({id:r.id,data:()=>r}))};}};return q;
 }};
 vm.runInContext(source('getFirebaseCollection'),h.c);
 // Another menu may already have cached a capped page.
 await h.c.ensureStaffCollections(['students','courses']);
 assert.equal(h.c.students.length,50);
 await h.c.requestStaffTabData('teacher-students');
 assert.ok(h.c.students.some(s=>s.id==='primary'));
 assert.ok(h.c.students.some(s=>s.id==='legacy-primary'));
 assert.ok(h.c.courses.some(c=>c.id==='primary-course'));
 const count=h.reads.length;
 await h.c.requestStaffTabData('teacher-students');
 assert.equal(h.reads.length,count,'complete roster is cached for the session');
});


test('teacher roster upgrades a concurrent capped load before it becomes ready',async()=>{
 const h=setup(),gate=deferred(),started=deferred(),calls=[];
 h.c.isQuotaOptimizedLoadingEnabled=()=>true;
 h.c.getFirebaseCollection=async(name,deleted,status,options)=>{
  calls.push({name,unbounded:!!(options&&options.unbounded)});
  if(name==='students'&&!options.unbounded){started.resolve();return gate.promise;}
  return [{id:options&&options.unbounded?'complete':'page'}];
 };
 const page=h.c.ensureStaffCollections(['students']);await started.promise;
 const roster=h.c.requestStaffTabData('teacher-students');
 gate.resolve([{id:'first-page'}]);await Promise.all([page,roster]);
 assert.equal(h.c.students[0].id,'complete');
 assert.deepEqual(calls.filter(c=>c.name==='students').map(c=>c.unbounded),[false,true]);
});

test('cached first page cannot bypass teacher roster loading through tab readiness',async()=>{
 const h=setup();h.c.isQuotaOptimizedLoadingEnabled=()=>true;
 await h.c.ensureStaffCollections(h.c.getStaffTabCollections('teacher-students'));
 assert.equal(h.c.requireStaffTabData('teacher-students'),false);
 await h.c.requestStaffTabData('teacher-students');
 assert.equal(h.c.requireStaffTabData('teacher-students'),true);
});
