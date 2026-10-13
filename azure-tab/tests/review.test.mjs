import {test} from 'node:test';import assert from 'node:assert/strict';
import {pagedDiff,changedFiles,inferExactRenames,fingerprint,Progress,totals,mapBounded} from '../src/review.mjs';
const storage=()=>{const entries=new Map();return {getItem:key=>entries.get(key),setItem:(key,value)=>entries.set(key,value)};};
test('Pages all changed files using stable merge base',async()=>{const calls=[];const result=await pagedDiff(async(skip,top)=>{calls.push([skip,top]);return {commonCommit:'base',changes:Array.from({length:skip===0?100:35},(_,i)=>({id:skip+i})),allChangesIncluded:skip>0};});assert.equal(result.changes.length,135);assert.deepEqual(calls,[[0,100],[100,100]]);});
test('Refuses missing, changing and incomplete merge bases',async()=>{await assert.rejects(pagedDiff(async()=>({})),/merge base/);await assert.rejects(pagedDiff(async skip=>({commonCommit:skip?'b':'a',changes:[{}],allChangesIncluded:!!skip})),/changed/);await assert.rejects(pagedDiff(async()=>({commonCommit:'a',changes:[]})),/incomplete/);});
test('Handles additions, deletes and Azure originalPath renames',()=>{assert.deepEqual(changedFiles([{changeType:1,item:{path:'/A.cs'}},{changeType:16,item:{path:'/D.cs'}},{changeType:10,originalPath:'/Old.cs',item:{path:'/New.cs'}},{item:{path:'/folder',isFolder:true}}]).map(file=>[file.path,file.status,file.oldPath]),[['A.cs','A',undefined],['D.cs','D',undefined],['New.cs','R','Old.cs']]);assert.throws(()=>changedFiles([{changeType:8,item:{path:'/New.cs'}}]),/original/);});
test('Handles live Azure string enums without treating adds and deletes as edits',()=>{assert.deepEqual(changedFiles([{changeType:'add',item:{path:'/A.cs'}},{changeType:'delete',item:{path:'/D.cs'}},{changeType:'edit, rename',originalPath:'/Old.cs',item:{path:'/New.cs'}},{changeType:'edit',item:{path:'/folder',gitObjectType:'tree'}}]).map(file=>[file.path,file.status,file.oldPath]),[['A.cs','A',undefined],['D.cs','D',undefined],['New.cs','R','Old.cs']]);assert.throws(()=>changedFiles([{changeType:'unknown',item:{path:'/x'}}]),/Unknown Azure/);});
test('Azure rename destinations represent their unique original deletion once',()=>{
 const rename=(path,oldPath)=>({changeType:'edit, rename',originalPath:oldPath,item:{path}});
 const deleted=path=>({changeType:'delete',item:{path}});
 const changes=[deleted('/Old.cs'),rename('/New.cs','/Old.cs'),deleted('/Removed.cs')];
 for(const input of [changes,[...changes].reverse()])assert.deepEqual(changedFiles(input).map(file=>[file.path,file.status,file.oldPath]),[['New.cs','R','Old.cs'],['Removed.cs','D',undefined]]);
 assert.deepEqual(changedFiles([deleted('/Old.cs'),rename('/One.cs','/Old.cs'),rename('/Two.cs','/Old.cs')]).map(file=>file.path),['Old.cs','One.cs','Two.cs']);
 assert.deepEqual(changedFiles([deleted('/old.cs'),rename('/New.cs','/Old.cs')]).map(file=>file.path),['New.cs','old.cs']);
});
const blob=(id='a',mode='100644')=>({objectId:id.repeat(40),mode});
test('Unique immutable blobs identify renames, moves and combined path changes without mutating input',()=>{
 for(const [oldPath,path] of [['Old.cs','New.cs'],['before/C.cs','after/C.cs'],['before/Old.cs','after/New.cs'],['c.cs','C.cs']]){
  const files=[{path:oldPath,status:'D'},{path,status:'A'}],before=new Map([[oldPath,blob()]]),after=new Map([[path,blob()]]);
  for(const input of [files,[...files].reverse()])assert.deepEqual(inferExactRenames(input,before,after),[{path,status:'R100',oldPath,blobUnchanged:true,inferredRename:true}]);
  assert.equal(files[1].status,'A');assert.equal(files[1].oldPath,undefined);
 }
});
test('Exact move detection keeps duplicate-content ambiguity, copies, edits and incomplete metadata visible',()=>{
 const run=(files,before,after)=>inferExactRenames(files,new Map(before),new Map(after));
 for(const [files,before,after] of [
  [[{path:'Old',status:'D'},{path:'One',status:'A'},{path:'Two',status:'A'}],[['Old',blob()]],[['One',blob()],['Two',blob()]]],
  [[{path:'One',status:'D'},{path:'Two',status:'D'},{path:'New',status:'A'}],[['One',blob()],['Two',blob()]],[['New',blob()]]],
  [[{path:'Old',status:'D'},{path:'New',status:'A'}],[['Old',blob()]],[['Old',blob()],['New',blob()]]],
  [[{path:'New',status:'A'}],[['Old',blob()]],[['Old',blob()],['New',blob()]]],
  [[{path:'Old',status:'D'},{path:'New',status:'A'}],[['Old',blob()]],[['New',blob('b')]]],
  [[{path:'Old',status:'D'},{path:'New',status:'A'}],[],[['New',blob()]]],
  [[{path:'Old',status:'D'},{path:'New',status:'A'}],[['Old',blob()]],[]],
  [[{path:'Old',status:'D'},{path:'New',status:'A'}],[['Old',{mode:'100644'}]],[['New',{mode:'100644'}]]],
  [[{path:'Old',status:'D'},{path:'New',status:'A'}],[['Old',blob('0')]],[['New',blob('0')]]],
  [[{path:'Old',status:'D'},{path:'New',status:'A'}],[['Old',blob('a','120000')]],[['New',blob()]]],
  [[{path:'Old',status:'D'},{path:'New',status:'A',error:'unverified'}],[['Old',blob()]],[['New',blob()]]]
 ])assert.deepEqual(run(files,before,after),files);
});
test('Incomplete candidate sets cannot establish unique rename pairs',()=>{
 for(const extra of [{path:'Other',status:'A'},{path:'Other',status:'D'},{path:'Other',status:'A',error:'unverified'}]){
  const files=[{path:'Old',status:'D'},{path:'New',status:'A'},extra];
  const before=new Map([['Old',blob()]]),after=new Map([['New',blob()]]);
  assert.deepEqual(inferExactRenames(files,before,after),files);
  (extra.status==='A'?after:before).set('Other',{mode:'100644'});
  assert.deepEqual(inferExactRenames(files,before,after),files);
 }
});
test('Moves retain mode changes and do not steal an explicit rename origin',()=>{
 const files=[{path:'Old',status:'D'},{path:'New',status:'A'}];
 const paired=inferExactRenames(files,new Map([['Old',blob()]]),new Map([['New',blob('a','100755')]]));
 assert.equal(paired[0].oldPath,'Old');assert.equal(paired[0].status,'R100');
 const explicit={path:'Edited',oldPath:'Old',status:'R',original:'before',modified:'after'};
 const all=[...files,explicit];assert.deepEqual(inferExactRenames(all,new Map([['Old',blob()]]),new Map([['New',blob()],['Edited',blob('b')]])),all);
 assert.equal(explicit.modified,'after');
});
test('Progress survives reopening, invalidates contents and Git modes, supports 50 files atomically',async()=>{const files=await Promise.all(Array.from({length:50},async(_,i)=>{const file={path:`File${i}.cs`,status:'M',original:'old',modified:'new',beforeMode:'100644',afterMode:'100644'};return {...file,fingerprint:await fingerprint(file)};}));const store=storage(),progress=new Progress(store,'pr');progress.mark(files,true);assert.equal(new Progress(store,'pr').viewed(files[49]),true);assert.notEqual(await fingerprint({...files[0],modified:'changed'}),files[0].fingerprint);assert.notEqual(await fingerprint({...files[0],afterMode:'100755'}),files[0].fingerprint);assert.deepEqual(totals(files,file=>file.path==='File0.cs'?['ignored']:[],progress),{viewed:49,total:49,ignored:1});progress.mark(files,false);assert.equal(progress.viewed(files[0]),false);});
test('Failed durable writes do not report reviewed in memory',()=>{const progress=new Progress({getItem:()=>null,setItem:()=>{throw new Error('quota');}},'pr');assert.throws(()=>progress.mark([{path:'x',fingerprint:'abc'}],true),/quota/);assert.equal(progress.viewed({path:'x',fingerprint:'abc'}),false);});
test('Literal special property file names survive persistence',()=>{const store=storage(),progress=new Progress(store,'pr');progress.mark([{path:'__proto__',fingerprint:'abc'}],true);assert.equal(new Progress(store,'pr').viewed({path:'__proto__',fingerprint:'abc'}),true);});
test('Read concurrency stays bounded',async()=>{let running=0,max=0,count=0;await mapBounded(Array.from({length:30}),async()=>{running++;max=Math.max(max,running);await new Promise(resolve=>setTimeout(resolve,1));running--;count++;});assert.equal(max,4);assert.equal(count,30);});
