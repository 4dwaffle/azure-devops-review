import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/azure.mjs',import.meta.url),'utf8');
const imports=source.slice(0,source.indexOf('export function contextId')).replace(/import .*?(?:SDK|CommonServiceIds|GitRestClient).*?;\r?\n/g,'').replace("'./review.mjs'",JSON.stringify(new URL('../src/review.mjs',import.meta.url).href)).replace("'../../test-projects.mjs'",JSON.stringify(new URL('../../test-projects.mjs',import.meta.url).href));
const {loadPullRequest}=await import('data:text/javascript;base64,'+Buffer.from(imports+source.slice(source.indexOf('export async function loadPullRequest'))).toString('base64'));
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
