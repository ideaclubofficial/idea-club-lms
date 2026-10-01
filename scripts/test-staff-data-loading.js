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
 const reads=[],renders=[],roots={};
 function element(){return {style:{},parentElement:null,hidden:false,attrs:{},children:[],classList:{hidden:false,contains(k){return k==='hidden'&&this.hidden;}},setAttribute(k,v){this.attrs[k]=v;},querySelector(){return this.children[0]||null;},prepend(n){n.parent=this;this.children.unshift(n);},remove(){this.parent.children=[];}};}
 for(const id of ['admin-video','admin-courses','admin-dashboard','admin-settings','teacher-dashboard','teacher-attendance'])roots[id]=element();
 const c={firebaseReady:true,db:{},firebaseUser:{uid:'A'},studentDataSessionVersion:1,coreDataLoaded:false,PRODUCTION_MODE:true,
   adminRealtimeSession:null,isCurrentStudentSession:()=>false,startAdminPaymentDataListeners:()=>null,
   courseEndScheduleTimer:null,courseEndScheduleProcessing:false,clearInterval(){},startCourseEndScheduleChecks(){},
   getFirebaseCollection:async(name,deleted,status)=>{reads.push(name);return [{id:name}];},getFirebasePaymentCollection:async()=>{reads.push('payments');return [{id:'bill'}];},
   applyPaymentRepairsSync() {}, safeRun:fn=>fn(),replaceArray:(a,b)=>a.splice(0,a.length,...b),rebuildStudentLookupMap(){},applySystemSettingsToPage(){},cacheStartupSettings(){},systemSettings:{},prizeWheelSettings:{},
   getElement:id=>roots[id]||null,document:{createElement:element},console:{warn(){},error(){}},
   canOpenAdminTab:()=>true,canOpenTeacherTab:()=>true,canOpenTeacherTool:()=>true,
   renderAdminTabContent:id=>renders.push(id),renderTeacherTabContent:id=>renders.push(id)
 };
 for(const name of source('getStaffCollectionTargets').match(/return \{([\s\S]*?)\};/)[1].match(/\b\w+\b/g))if(!c[name])c[name]=[];
 vm.createContext(c);vm.runInContext(staffSource,c);vm.runInContext(source('loadCoreDataFromFirebase'),c);
 return {c,reads,renders,roots};
}

test('staff core requests only the five base collections and never repairs records',async()=>{
 const h=setup();await h.c.loadCoreDataFromFirebase();
 assert.deepEqual(h.reads.sort(),['courseEnrollments','courses','settings','students','teachers']);assert.equal(h.c.coreDataLoaded,true);
 assert.ok(!source('loadCoreDataFromFirebase').includes('repair'));
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
 h.c.ensureStaffCollections=async()=>{throw new Error('offline');};h.c.alert=text=>message=text;
 h.c.Blob=function(){downloaded=true;};vm.runInContext(source('exportAllDataBackup'),h.c);
 await h.c.exportAllDataBackup();assert.equal(downloaded,false);assert.match(message,/ข้อมูลสำรองไม่ครบ/);
});
