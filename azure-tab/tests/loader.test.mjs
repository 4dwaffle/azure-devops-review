import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {zipSync} from 'fflate';
const source=await readFile(new URL('../src/azure.mjs',import.meta.url),'utf8');
const imports=source.slice(0,source.indexOf('export function contextId')).replace(/import .*?(?:SDK|CommonServiceIds|GitRestClient).*?;\r?\n/g,'').replace("'./review.mjs'",JSON.stringify(new URL('../src/review.mjs',import.meta.url).href)).replace("'../../test-projects.mjs'",JSON.stringify(new URL('../../test-projects.mjs',import.meta.url).href));
const {loadPullRequest}=await import('data:text/javascript;base64,'+Buffer.from(imports.replace("'./blob-content.mjs'",JSON.stringify(new URL('../src/blob-content.mjs',import.meta.url).href)).replace("'./tree-context.mjs'",JSON.stringify(new URL('../src/tree-context.mjs',import.meta.url).href))+source.slice(source.indexOf('export async function loadPullRequest'))).toString('base64'));
const entry=(relativePath,id,mode='100644')=>({relativePath,objectId:id.repeat(40),mode});
function fixture(truncated=false) {
 const calls=[];
 const client={
  getPullRequestById:async()=>({repository:{id:'r'},lastMergeSourceCommit:{commitId:'s'},lastMergeTargetCommit:{commitId:'t'}}),
  getCommitDiffs:async()=>({commonCommit:'b',allChangesIncluded:true,changes:[{changeType:'edit, rename',originalPath:'/old/A.cs',item:{path:'/new/A.cs'}}]}),
  getCommit:async version=>({treeId:version}),
  getTree:async(_r,version)=>({truncated,treeEntries:version==='b'?[entry('old/A.cs','a'),entry('old/.editorconfig','b')]:[entry('new/A.cs','a'),entry('new/.editorconfig','c')]}),
  getPullRequestIterations:async()=>[{id:2,sourceRefCommit:{commitId:'s'},targetRefCommit:{commitId:'t'}}],getThreads:async()=>[],
  getItem:async(...args)=>{const path=args[1],version=args[8].version;calls.push([path,version]);if(path.endsWith('A.cs'))return {content:'class A {}',contentMetadata:{isBinary:false}};if(path=== '/old/.editorconfig'&&version==='b')return {content:'[*.cs]\ngenerated_code = false'};if(path=== '/new/.editorconfig'&&version==='s')throw new Error('Configuration read failed');throw {status:404};}
 };
 return {client,calls};
}
test('Immutable blob deduplication and tree-backed configuration reads preserve failures and both rename ancestors',async()=>{
 const {client,calls}=fixture();const result=await loadPullRequest({client,project:'p'},1);
 assert.equal(calls.length,3);assert.deepEqual(calls.map(value=>value[0]).sort(),['/new/.editorconfig','/old/.editorconfig','/old/A.cs']);
 assert.equal(result.files[0].original,result.files[0].modified);assert.equal(result.files[0].status,'R100');assert.ok(result.files[0].fingerprint);
 assert.deepEqual(result.configurations.find(value=>value.contents),{path:'old/.editorconfig',side:'base',contents:'[*.cs]\ngenerated_code = false'});
 assert.match(result.configurations.find(value=>value.error).error,/Configuration read failed/);
});
test('Truncated trees retain conservative configuration discovery rather than treating missing entries as absent',async()=>{
 const {client,calls}=fixture(true);const result=await loadPullRequest({client,project:'p'},1);
 assert.ok(calls.some(([path,version])=>path==='/.editorconfig'&&version==='b'));
 assert.ok(calls.some(([path,version])=>path==='/old/.editorconfig'&&version==='s'));
 assert.equal(result.configurations.length,2);
});

function projectFixture({truncated=false,failed=false,changed=false}={}){
 const {client,calls}=fixture(truncated);
 const paths=['src/Verification/Check.cs','src/Library.Tests/Production.cs','src/Verification/Nested/Production.cs'];
 client.getCommitDiffs=async()=>({commonCommit:'b',allChangesIncluded:true,changes:paths.map(path=>({changeType:'edit',item:{path:'/'+path}}))});
 client.getTree=async(_r,version)=>({truncated,treeEntries:[
  ...paths.map((path,index)=>entry(path,String(index+1))),
  entry('src/Verification/Verify.csproj',version==='s'&&changed?'f':'a'),
  entry('src/Library.Tests/Library.Tests.csproj','b'),
  entry('src/Verification/Nested/Production.csproj','b'),
  entry('unrelated/Unchanged.csproj','c')
 ]});
 client.getItem=async(...args)=>{
  const path=args[1],version=args[8].version;calls.push([path,version]);
  if(path==='/src/Verification/Verify.csproj'){
   if(failed)throw new Error('Project unavailable');
   return {content:version==='s'&&changed?'<Project/>':'<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0"/></ItemGroup></Project>'};
  }
  if(path.endsWith('.csproj'))return {content:'<Project/>'};
  if(path.endsWith('.cs'))return {content:'class C {}'};
  throw {status:404};
 };
 return {client,calls};
}

test('Unchanged csproj metadata identifies tests without names and respects nested production projects',async()=>{
 const {client,calls}=projectFixture();const result=await loadPullRequest({client,project:'p'},1);
 assert.deepEqual(result.files.map(file=>[file.path,file.testProject]),[
  ['src/Library.Tests/Production.cs',false],['src/Verification/Check.cs',true],['src/Verification/Nested/Production.cs',false]
 ]);
 const reads=calls.filter(([path])=>path.endsWith('.csproj'));
 assert.equal(reads.length,2,'Unchanged project blobs are read once across immutable snapshots');
 assert.ok(reads.every(([path,version])=>path!=='/unrelated/Unchanged.csproj'&&['b','s'].includes(version)));
});

test('Test status transitions, project read failures and truncated trees keep files visible',async()=>{
 for(const options of [{changed:true},{failed:true},{truncated:true}]){
  const {client}=projectFixture(options);const result=await loadPullRequest({client,project:'p'},1);
  assert.ok(result.files.every(file=>file.testProject===false),JSON.stringify(options));
 }
});

// Use real Git blob identities and the installed SDK's getBlobsZip /
// getItemsBatch shapes, so this exercises the same loader path as production.
const snapshotBase='1'.repeat(40),snapshotSource='2'.repeat(40),snapshotTarget='3'.repeat(40);
const textMetadata={encoding:65001,isBinary:false};
const blobIdentity=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const immutableKey=(path,version)=>JSON.stringify([path,version]);
function bulkLoaderFixture({bulk=true,failure}={}){
 const records=new Map(),changes=[],itemCalls=[],zipCalls=[],metadataCalls=[],threadCalls=[];
 const add=(version,path,content,{bytes=Buffer.from(content),metadata=textMetadata,mode='100644',error}={})=>{
  const record={path,version,content,bytes,metadata,mode,error,id:blobIdentity(bytes)};
  records.set(immutableKey('/'+path,version),record);return record;
 };
 const both=(path,before,after=before,options={})=>{
  add(snapshotBase,path,before,options);add(snapshotSource,path,after,options);
 };
 const edit=(path,before,after=before,options={})=>{
  both(path,before,after,options);changes.push({changeType:'edit',item:{path:'/'+path}});
 };
 const testProject='<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>';
 both('Root.csproj',testProject);
 both('src/Tests/Tests.csproj',testProject);
 both('src/Tests/Nested/Library.csproj','<Project/>');
 both('src/Transition/Transition.csproj',testProject,'<Project/>');
 both('src/Broken/Broken.csproj','<Project><PropertyGroup><Broken>true</Broken></PropertyGroup></Project>',undefined,{error:new Error('Project read denied')});
 both('unrelated/NotAnAncestor.csproj','<Project/>');
 both('.editorconfig','root = true\n[*.cs]\ngenerated_code = false\n');
 both('.globalconfig','is_global = true\n');
 add(snapshotBase,'src/Tests/.editorconfig','[*.cs]\nindent_size = 2\n');
 add(snapshotSource,'src/Tests/.editorconfig','[*.cs]\nindent_size = 4\n',{error:new Error('Configuration read denied')});
 // A known tree entry can disappear from the item endpoint; a 404 config is
 // still absent rather than an error in the existing loader contract.
 add(snapshotSource,'enc/.editorconfig','[*.txt]\ncharset = utf-8\n',{error:Object.assign(new Error('Configuration not found'),{status:404})});
 edit('src/Tests/Changed.cs','class Before {}\n','class After {}\n');
 add(snapshotSource,'src/Tests/Added.cs','class Added {}\n');changes.push({changeType:'add',item:{path:'/src/Tests/Added.cs'}});
 add(snapshotBase,'src/Tests/Deleted.cs','class Deleted {}\n');changes.push({changeType:'delete',item:{path:'/src/Tests/Deleted.cs'}});
 add(snapshotBase,'src/Tests/Before.cs','class Moved {}\n');add(snapshotSource,'src/Tests/After.cs','class Moved {}\n');
 changes.push({changeType:'delete',item:{path:'/src/Tests/Before.cs'}},{changeType:'edit, rename',originalPath:'/src/Tests/Before.cs',item:{path:'/src/Tests/After.cs'}});
 add(snapshotBase,'old/Inferred.cs','class Inferred {}\n');add(snapshotSource,'new/Inferred.cs','class Inferred {}\n',{mode:'100755'});
 changes.push({changeType:'delete',item:{path:'/old/Inferred.cs'}},{changeType:'add',item:{path:'/new/Inferred.cs'}});
 add(snapshotBase,'scripts/run.sh','#!/bin/sh\necho ready\n');add(snapshotSource,'scripts/run.sh','#!/bin/sh\necho ready\n',{mode:'100755'});
 changes.push({changeType:'edit',item:{path:'/scripts/run.sh'}});
 add(snapshotBase,'assets/image.png','',{bytes:Uint8Array.of(0,137,80,78,71,255),metadata:{encoding:-1,isBinary:true}});
 add(snapshotSource,'assets/image.png','',{bytes:Uint8Array.of(0,137,80,78,71,254),metadata:{encoding:-1,isBinary:true}});
 changes.push({changeType:'edit',item:{path:'/assets/image.png'}});
 edit('link','old/target','new/target',{mode:'120000'});
 edit('vendor/lib','old-commit','new-commit',{mode:'160000'});
 edit('enc/ascii.txt','plain ASCII\r\n','new ASCII\r\n',{metadata:{encoding:1252,isBinary:false}});
 add(snapshotBase,'enc/utf8.txt','Příliš 🐈\n',{bytes:Buffer.from('\ufeffPříliš 🐈\n')});
 add(snapshotSource,'enc/utf8.txt','Žluťoučký 🐈\n',{bytes:Buffer.from('\ufeffŽluťoučký 🐈\n')});
 changes.push({changeType:'edit',item:{path:'/enc/utf8.txt'}});
 edit('enc/windows.txt','€ – café','€ – café',{bytes:Uint8Array.of(0x80,32,0x96,32,99,97,102,0xe9),metadata:{encoding:1252,isBinary:false}});
 edit('enc/ambiguous.txt','český','český',{bytes:Buffer.from('český'),metadata:{encoding:1252,isBinary:false}});
 edit('enc/legacy.txt','legacy text','legacy text',{bytes:Buffer.from('legacy text','utf16le'),metadata:{encoding:1200,isBinary:false}});
 edit('enc/malformed.txt','�(','�(',{bytes:Uint8Array.of(0xc3,0x28)});
 edit('enc/nul.txt','before\0after');
 edit('enc/unknown.txt','unknown encoding','unknown encoding',{metadata:{isBinary:false}});
 edit('errors/denied.cs','class DeniedBefore {}','class DeniedAfter {}',{error:new Error('File read denied')});
 edit('src/Tests/Nested/Code.cs','class Nested {}');
 edit('src/Transition/Code.cs','class Transition {}');
 edit('src/Broken/Code.cs','class Broken {}');
 add(snapshotSource,'errors/no-tree.cs','class Incomplete {}');changes.push({changeType:'edit',item:{path:'/errors/no-tree.cs'}});
 const byId=new Map([...records.values()].map(record=>[record.id,record]));
 const client={
  getPullRequestById:async(id,project)=>{
   assert.equal(id,2620);assert.equal(project,'project');
   return {pullRequestId:id,repository:{id:'repo'},lastMergeSourceCommit:{commitId:snapshotSource},lastMergeTargetCommit:{commitId:snapshotTarget}};
  },
  getCommitDiffs:async(repository,project,merge,top,skip,target,source)=>{
   assert.equal(repository,'repo');assert.equal(project,'project');assert.equal(merge,true);assert.equal(top,2000);assert.equal(skip,0);
   assert.deepEqual(target,{version:snapshotTarget,versionType:2});assert.deepEqual(source,{version:snapshotSource,versionType:2});
   return {commonCommit:snapshotBase,allChangesIncluded:true,changes:[...changes].reverse()};
  },
  getCommit:async(version,repository,project,changeCount)=>{
   assert.ok([snapshotBase,snapshotSource].includes(version));assert.equal(repository,'repo');assert.equal(project,'project');assert.equal(changeCount,0);
   return {treeId:version};
  },
  getTree:async(repository,version,project,_url,recursive)=>{
   assert.equal(repository,'repo');assert.equal(project,'project');assert.equal(recursive,true);
   return {truncated:false,treeEntries:[...records.values()].filter(record=>record.version===version).map(record=>({relativePath:record.path,objectId:record.id,mode:record.mode}))};
  },
  getPullRequestIterations:async()=>[{id:3,sourceRefCommit:{commitId:snapshotSource},targetRefCommit:{commitId:snapshotTarget}}],
  getThreads:async(...args)=>{threadCalls.push(args);return [{id:17,comments:[{content:'Existing review comment'}]}];},
  getItem:async(...args)=>{
   itemCalls.push(args);
   const record=records.get(immutableKey(args[1],args[8].version));
   if(!record)throw Object.assign(new Error('Item not found'),{statusCode:404});
   if(record.error)throw record.error;
   return {content:record.content,contentMetadata:record.metadata};
  }
 };
 if(bulk){
  client.getBlobsZip=async(...args)=>{
   zipCalls.push(args);const [ids,repository,project]=args;
   assert.equal(repository,'repo');assert.equal(project,'project');
   assert.ok(ids.length>0&&ids.length<=256);assert.equal(new Set(ids).size,ids.length);
   if(failure==='zip-rejected')throw new Error('ZIP unavailable');
   if(failure==='malformed-zip')return Uint8Array.of(80,75,3).buffer;
   const files=Object.fromEntries([...ids].reverse().flatMap((id,index)=>{
    const record=byId.get(id);assert.ok(record);
    if(record.error||failure==='missing-blobs')return [];
    return [[id,failure==='corrupt-blobs'?Buffer.from(`wrong bytes ${index}`):record.bytes]];
   }));
   const zip=zipSync(files,{level:1});return zip.buffer.slice(zip.byteOffset,zip.byteOffset+zip.byteLength);
  };
  client.getItemsBatch=async(...args)=>{
   metadataCalls.push(args);const [request,repository,project]=args;
   assert.equal(repository,'repo');assert.equal(project,'project');assert.equal(request.includeContentMetadata,true);
   if(failure==='metadata-rejected')throw new Error('Metadata unavailable');
   return [...request.itemDescriptors].reverse().map(descriptor=>{
    assert.equal(descriptor.versionType,2);assert.equal(descriptor.recursionLevel,0);
    const record=records.get(immutableKey(descriptor.path,descriptor.version));assert.ok(record);
    if(record.error)return [];
    const item={path:descriptor.path,commitId:descriptor.version,objectId:record.id,contentMetadata:record.metadata};
    if(failure==='wrong-path')item.path='/unexpected'+item.path;
    if(failure==='wrong-version')item.commitId=snapshotTarget;
    if(failure==='wrong-object')item.objectId='f'.repeat(40);
    return [item];
   });
  };
 }
 return {client,records,itemCalls,zipCalls,metadataCalls,threadCalls};
}
const normalized=result=>({...result,configurations:[...result.configurations].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
const loadFixture=fixture=>loadPullRequest({client:fixture.client,project:'project'},2620);
function assertImmutableItemCalls(calls){
 for(const args of calls){
  assert.equal(args[0],'repo');assert.equal(args[2],'project');
  assert.equal(args[5],true,'Request Azure content metadata');
  assert.equal(args[9],true,'Request the Azure text representation');
  assert.equal(args[10],false,'Do not resolve LFS into different bytes');
  assert.equal(args[8].versionType,2);
  assert.ok([snapshotBase,snapshotSource].includes(args[8].version),'Read the merge base or snapshotted source, never a mutable branch or target tip');
 }
}

test('Supported bulk APIs preserve the complete immutable loader result, rename modes and fingerprints',async()=>{
 const immutable=bulkLoaderFixture({bulk:false}),bulk=bulkLoaderFixture();
 const expected=await loadFixture(immutable),actual=await loadFixture(bulk);
 assert.deepEqual(normalized(actual),normalized(expected));
 const inventory=[
  'assets/image.png','enc/ambiguous.txt','enc/ascii.txt','enc/legacy.txt','enc/malformed.txt','enc/nul.txt','enc/unknown.txt','enc/utf8.txt','enc/windows.txt',
  'errors/denied.cs','errors/no-tree.cs','link','new/Inferred.cs','scripts/run.sh','src/Broken/Code.cs','src/Tests/Added.cs','src/Tests/After.cs',
  'src/Tests/Changed.cs','src/Tests/Deleted.cs','src/Tests/Nested/Code.cs','src/Transition/Code.cs','vendor/lib'
 ];
 assert.deepEqual(actual.files.map(file=>file.path).sort(),inventory.sort());
 assert.equal(bulk.zipCalls.length,1);assert.equal(bulk.metadataCalls.length,1);
 assert.ok(bulk.itemCalls.length<immutable.itemCalls.length,'Verified bulk results replace individual content reads');
 const files=new Map(actual.files.map(file=>[file.path,file]));
 const rename=files.get('src/Tests/After.cs');
 assert.equal(rename.oldPath,'src/Tests/Before.cs');assert.equal(rename.status,'R100');assert.equal(rename.blobUnchanged,true);assert.equal(rename.modeChanged,false);
 const inferred=files.get('new/Inferred.cs');
 assert.equal(inferred.oldPath,'old/Inferred.cs');assert.equal(inferred.status,'R100');assert.equal(inferred.inferredRename,true);assert.equal(inferred.blobUnchanged,true);
 assert.equal(inferred.beforeMode,'100644');assert.equal(inferred.afterMode,'100755');assert.equal(inferred.modeChanged,true);
 const executable=files.get('scripts/run.sh');assert.equal(executable.status,'M');assert.equal(executable.modeChanged,true);assert.equal(executable.original,executable.modified);
 assert.equal(files.get('src/Tests/Added.cs').original,'');assert.equal(files.get('src/Tests/Deleted.cs').modified,'');
 assert.equal(files.get('src/Tests/Changed.cs').original,'class Before {}\n');assert.equal(files.get('src/Tests/Changed.cs').modified,'class After {}\n');
 assert.equal(files.get('enc/utf8.txt').original,'Příliš 🐈\n');assert.equal(files.get('enc/utf8.txt').modified,'Žluťoučký 🐈\n');
 for(const path of ['assets/image.png','link','vendor/lib']){
  const file=files.get(path);assert.equal(file.binary,true);
  assert.equal(file.original,bulk.records.get(immutableKey('/'+path,snapshotBase)).id);
  assert.equal(file.modified,bulk.records.get(immutableKey('/'+path,snapshotSource)).id);
 }
 for(const file of actual.files){
  if(file.error){assert.equal(file.fingerprint,undefined);continue;}
  const hash=createHash('sha256').update(JSON.stringify([file.path,file.oldPath,file.status,file.original,file.modified,file.binary,file.beforeMode,file.afterMode])).digest('hex');
  assert.equal(file.fingerprint,hash,file.path);
 }
 assert.equal(files.get('src/Tests/Changed.cs').testProject,true);
 for(const path of ['src/Broken/Code.cs','src/Tests/Nested/Code.cs','src/Transition/Code.cs','new/Inferred.cs','scripts/run.sh'])assert.equal(files.get(path).testProject,false,path);
 assert.match(files.get('errors/denied.cs').error,/File read denied/);
 assert.match(files.get('errors/no-tree.cs').error,/tree metadata is incomplete/);
 assert.ok(actual.configurations.some(config=>config.path==='src/Tests/.editorconfig'&&config.side==='base'&&config.contents.includes('indent_size = 2')));
 assert.ok(actual.configurations.some(config=>config.path==='src/Tests/.editorconfig'&&/Configuration read denied/.test(config.error)));
 assert.equal(actual.configurations.some(config=>config.path==='enc/.editorconfig'),false,'Configuration 404s retain their existing absent semantics');
 assert.deepEqual(bulk.threadCalls,[['repo',2620,'project',3,3]]);assert.equal(actual.latestIteration,3);assert.equal(actual.threads[0].id,17);
 const individuallyRead=new Set(bulk.itemCalls.map(args=>args[1]));
 for(const path of ['/enc/windows.txt','/enc/ambiguous.txt','/enc/legacy.txt','/enc/malformed.txt','/enc/nul.txt','/enc/unknown.txt','/errors/denied.cs','/src/Tests/.editorconfig','/src/Broken/Broken.csproj','/link','/vendor/lib'])assert.ok(individuallyRead.has(path),path);
 for(const path of ['/src/Tests/Changed.cs','/enc/ascii.txt','/enc/utf8.txt','/assets/image.png','/Root.csproj','/.editorconfig'])assert.equal(individuallyRead.has(path),false,path);
 const batchedPaths=bulk.metadataCalls.flatMap(([request])=>request.itemDescriptors.map(item=>item.path));
 assert.ok(batchedPaths.includes('/src/Tests/Tests.csproj'),'Read unchanged ancestor project metadata through the bulk API');
 assert.equal(batchedPaths.includes('/unrelated/NotAnAncestor.csproj'),false);
 assertImmutableItemCalls(bulk.itemCalls);assertImmutableItemCalls(immutable.itemCalls);
});

test('Bulk download, metadata, SHA and snapshot failures preserve all per-file, configuration and project read errors',async t=>{
 const immutable=bulkLoaderFixture({bulk:false}),expected=normalized(await loadFixture(immutable));
 for(const failure of ['zip-rejected','metadata-rejected','malformed-zip','missing-blobs','corrupt-blobs','wrong-path','wrong-version','wrong-object'])await t.test(failure,async()=>{
  const fixture=bulkLoaderFixture({failure}),actual=await loadFixture(fixture);
  assert.deepEqual(normalized(actual),expected);
  assert.equal(actual.files.length,22);
  assert.equal(fixture.itemCalls.length,immutable.itemCalls.length,'Invalid bulk data must use the same immutable cache and item reads');
  const requests=fixture.itemCalls.map(args=>immutableKey(args[1],args[8].version));
  assert.deepEqual(new Set(requests),new Set(immutable.itemCalls.map(args=>immutableKey(args[1],args[8].version))));
  assert.ok(fixture.itemCalls.some(args=>args[1]==='/src/Broken/Broken.csproj'),'Project errors must reach conservative test classification');
  assert.ok(actual.files.some(file=>file.path==='errors/denied.cs'&&file.error==='File read denied'));
  assert.ok(actual.configurations.some(config=>config.error==='Configuration read denied'));
  assertImmutableItemCalls(fixture.itemCalls);
 });
});

test('A client with only one bulk API falls back to immutable per-item reads without changing inventory',async()=>{
 const immutable=bulkLoaderFixture({bulk:false}),expected=normalized(await loadFixture(immutable));
 for(const missing of ['getBlobsZip','getItemsBatch']){
  const fixture=bulkLoaderFixture();delete fixture.client[missing];
  const actual=await loadFixture(fixture);
  assert.deepEqual(normalized(actual),expected);
  assert.equal(fixture.zipCalls.length,0);assert.equal(fixture.metadataCalls.length,0);
  assert.equal(fixture.itemCalls.length,immutable.itemCalls.length);assertImmutableItemCalls(fixture.itemCalls);
 }
});

function smallRepositoryFixture({scoped=true,failure,truncated=false}={}){
 const fixture=bulkLoaderFixture(),{client,records}=fixture,fullDiff=client.getCommitDiffs,fullTree=client.getTree,metadata=client.getItemsBatch;
 // Eight changes, but 20,000 unrelated files: repository size must not dictate
 // small-review acquisition. Include moves, old ancestors and an added file.
 const selected=new Set(['src/Tests/Changed.cs','src/Tests/Added.cs','src/Tests/Deleted.cs','old/Inferred.cs','new/Inferred.cs','scripts/run.sh','src/Tests/Nested/Code.cs','src/Transition/Code.cs']);
 client.getCommitDiffs=async(...args)=>{const diff=await fullDiff(...args);return {...diff,changes:diff.changes.filter(change=>selected.has(change.item.path.slice(1)))};};
 const all=[...records.values()].map(record=>({...record,entry:{relativePath:record.path,objectId:record.id,mode:record.mode}}));
 for(const version of [snapshotBase,snapshotSource])for(let i=0;i<20000;i++)all.push({version,path:`unrelated/Deep/File${i}.cs`,entry:entry(`unrelated/Deep/File${i}.cs`,'e')});
 const directories=new Map(),trees=new Map(),treeCalls=[],directoryCalls=[];
 for(const version of [snapshotBase,snapshotSource]){
  const paths=new Set(['']);
  for(const record of all.filter(record=>record.version===version)){let path=record.path;while(path.includes('/')){path=path.slice(0,path.lastIndexOf('/'));paths.add(path);}}
  for(const path of paths){
   const id=createHash('sha1').update(version+':'+path).digest('hex'),prefix=path?path+'/':'';
   const entries=all.filter(record=>record.version===version&&record.path.startsWith(prefix)&&!record.path.slice(prefix.length).includes('/')).map(record=>({...record.entry,relativePath:record.path.slice(prefix.length)}));
   for(const child of paths)if(child.startsWith(prefix)&&child!==path&&!child.slice(prefix.length).includes('/'))entries.push({relativePath:child.slice(prefix.length),mode:'040000',objectId:createHash('sha1').update(version+':'+child).digest('hex')});
   directories.set(immutableKey('/'+path,version),{path:'/'+path,commitId:version,objectId:id,gitObjectType:2,isFolder:true});trees.set(id,{truncated,treeEntries:entries});
  }
 }
 client.getTree=async(...args)=>{
  treeCalls.push(args);
  if(args[4]){const result=await fullTree(...args);return {...result,truncated,treeEntries:all.filter(record=>record.version===args[1]).map(record=>record.entry)};}
  assert.ok(trees.has(args[1]));
  if(failure==='tree-rejected')throw new Error('Scoped listing unavailable');
  return trees.get(args[1]);
 };
 client.getItemsBatch=async(...args)=>{
  if(args[0].includeContentMetadata)return metadata(...args);
  directoryCalls.push(args);
  if(!scoped||failure==='batch-rejected')throw new Error('Directory batches unavailable');
  const items=args[0].itemDescriptors.map(descriptor=>{
   assert.equal(descriptor.recursionLevel,0);assert.equal(descriptor.versionType,2);
   assert.ok(!descriptor.path.includes('unrelated'),'Unchanged descendants must not be enumerated');
   const item=directories.get(immutableKey(descriptor.path,descriptor.version));return item?[{...item}]:[];
  });
  if(failure==='wrong-version')items[0][0].commitId=snapshotTarget;
  if(failure==='wrong-path')items[0][0].path='/elsewhere';
  if(failure==='missing-root')items[0]=[];
  if(failure==='partial-batch')items.pop();
  return items;
 };
 return {...fixture,treeCalls,directoryCalls};
}

test('A small diff in a large repository loads only applicable directories with identical modes, configs, projects and fingerprints',async()=>{
 const full=smallRepositoryFixture({scoped:false}),small=smallRepositoryFixture();
 const expected=normalized(await loadFixture(full)),actual=normalized(await loadFixture(small));
 assert.deepEqual(actual,expected);assert.equal(actual.files.length,7,'Exact delete/add rename inference is retained');
 assert.equal(actual.files.find(file=>file.path==='src/Tests/Changed.cs').testProject,true);
 assert.equal(actual.files.find(file=>file.path==='src/Tests/Nested/Code.cs').testProject,false);
 assert.equal(actual.files.find(file=>file.path==='src/Transition/Code.cs').testProject,false);
 assert.equal(actual.files.find(file=>file.path==='new/Inferred.cs').modeChanged,true);
 assert.ok(small.treeCalls.length>0);assert.ok(small.treeCalls.every(args=>args[4]===false),'No repository-wide recursive reads for a small diff');
 assert.ok(full.treeCalls.some(args=>args[4]===true),'The comparison exercises the original full-tree path');
 assert.equal(small.directoryCalls.length,1);assert.equal(small.zipCalls.length,1);
});

test('Small-review directory snapshot, batch and tree failures fall back without losing any review context',async t=>{
 const expected=normalized(await loadFixture(smallRepositoryFixture({scoped:false})));
 for(const failure of ['batch-rejected','wrong-version','wrong-path','missing-root','partial-batch','tree-rejected'])await t.test(failure,async()=>{
  const fixture=smallRepositoryFixture({failure});assert.deepEqual(normalized(await loadFixture(fixture)),expected);
  assert.ok(fixture.treeCalls.some(args=>args[4]===true),'Fallback reads the full immutable trees');
 });
 const full=smallRepositoryFixture({scoped:false,truncated:true}),small=smallRepositoryFixture({truncated:true});
 assert.deepEqual(normalized(await loadFixture(small)),normalized(await loadFixture(full)));
});
