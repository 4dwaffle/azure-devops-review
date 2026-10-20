import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function startup({id=7,fail=false}={}){
 const editor=gate(),acquired=gate(),connection={pullRequestId:id},calls=[],notice={textContent:''};
 const key='startup'+Math.random(),previousDocument=globalThis.document;
 const state={editor:editor.promise,connect:async()=>connection,load:async(context,id)=>{
  assert.equal(context,connection);calls.push(id);acquired.resolve();
  if(fail)throw new Error('Snapshot read denied');
  return {pr:{pullRequestId:id},source:'source-'+calls.length};
 },start:async(context,load)=>{state.load=load;state.initial=id?await load(context,id):null;}};
 globalThis[key]=state;globalThis.document={getElementById:()=>notice};
 const azure=moduleUrl(`const state=globalThis[${JSON.stringify(key)}];export const connect=state.connect,loadPullRequest=state.load;`);
 const app=moduleUrl(`const state=globalThis[${JSON.stringify(key)}];await state.editor;export const start=state.start;`);
 const running=import(moduleUrl(source.replace("'./azure.mjs'",JSON.stringify(azure)).replaceAll("'./app.mjs'",JSON.stringify(app))));
 const close=async()=>{editor.resolve();await running;delete globalThis[key];globalThis.document=previousDocument;};
 return {editor,acquired,connection,calls,notice,state,running,close};
}

test('SDK acquisition starts while the editor is blocked; refresh consumes a new snapshot',async()=>{
 const run=await startup();let timeout;
 try{
  await Promise.race([run.acquired.promise,new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error('Acquisition waited for the editor module')),1000))]);
  assert.deepEqual(run.calls,[7]);run.editor.resolve();await run.running;
  assert.equal(run.state.initial.source,'source-1');
  const refreshed=await run.state.load(run.connection,7);assert.equal(refreshed.source,'source-2');
  const another=await run.state.load(run.connection,9);assert.equal(another.source,'source-3');assert.deepEqual(run.calls,[7,7,9]);
 }finally{clearTimeout(timeout);await run.close();}
});

test('Early acquisition failures remain handled and visible after the editor loads',async()=>{
 const run=await startup({fail:true}),unhandled=[];const onUnhandled=error=>unhandled.push(error);process.on('unhandledRejection',onUnhandled);
 try{
  await run.acquired.promise;await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(unhandled,[]);run.editor.resolve();await run.running;
  assert.equal(run.notice.textContent,'Snapshot read denied');assert.deepEqual(run.calls,[7]);
 }finally{process.off('unhandledRejection',onUnhandled);await run.close();}
});

test('Hosts without PR context retain manual ID loading without an eager request',async()=>{
 const run=await startup({id:null});
 try{
  run.editor.resolve();await run.running;assert.deepEqual(run.calls,[]);
  assert.equal((await run.state.load(run.connection,8)).pr.pullRequestId,8);assert.deepEqual(run.calls,[8]);
 }finally{await run.close();}
});

test('SDK connection obtains a supported repository hint without blocking startup on the host service',async()=>{
 const azureSource=await readFile(new URL('../src/azure.mjs',import.meta.url),'utf8');
 const connectSource=azureSource.slice(azureSource.indexOf('export function contextId'),azureSource.indexOf('export async function loadPullRequest'));
 for(const failed of [false,true]){
  const repository=gate(),key='connect'+Math.random(),calls=[],client={};
  globalThis[key]={client,SDK:{init:()=>{},ready:async()=>{},getConfiguration:()=>({pullRequestId:7}),notifyLoadSucceeded:async()=>{},getUser:()=>({id:'user'}),getHost:()=>({id:'org'}),getService:async id=>{
   calls.push(id);if(id==='repository'){if(failed)throw new Error('Host service unavailable');return {getCurrentGitRepository:()=>repository.promise};}
   if(id==='project')return {getProject:async()=>({id:'project'})};throw new Error('Unexpected service');
  }}};
  try{
   const {connect}=await import(moduleUrl(`const {SDK,client}=globalThis[${JSON.stringify(key)}];const getClient=()=>client,GitRestClient={},CommonServiceIds={ProjectPageService:'project'},GitServiceIds={VersionControlRepositoryService:'repository'};\n`+connectSource));
   const connection=await connect();assert.equal(connection.pullRequestId,7);assert.equal(connection.client,client);assert.ok(calls.includes('repository'));
   repository.resolve({id:'repo'});assert.equal(await connection.repositoryId,failed?null:'repo');
  }finally{delete globalThis[key];repository.resolve(null);}
 }
});
