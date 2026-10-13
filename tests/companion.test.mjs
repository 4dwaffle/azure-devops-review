import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {fixture,nativeAvailable} from './companion-fixture.mjs';
import {loadProfile} from '../companion/serve.mjs';

test('Native compiler uses full immutable context, verifies large reviews, and rejects caller changes and mixed edits',{timeout:120000,skip:!nativeAvailable},async()=>{
 const input=await fixture({large:true});let server;
 try{
  server=await input.start();const request=input.request();const response=await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:1'},body:JSON.stringify(request)});assert.equal(response.status,200);const data=await response.json();assert.equal(data.contextValid,true);assert.equal(data.results.length,252);assert.ok(data.results.some(value=>value.path==='Reference.cs'));for(const name of ['Origin.cs','Caller.cs','Mixed.cs','Moved.cs'])assert.ok(!data.results.some(value=>value.path===name),name);
  const preflight=await fetch(server.url,{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:1','Access-Control-Request-Private-Network':'true'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-private-network'),'true');assert.equal(preflight.headers.get('access-control-allow-origin'),'http://127.0.0.1:1');
  assert.equal((await fetch(server.url,{headers:{Origin:'https://malicious.invalid'}})).status,403);
  assert.equal((await fetch(server.url.replace(/\/[a-f0-9]{64}\//,'/invalid/'))).status,404);
  const mismatch=await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,source:'0'.repeat(40)})});assert.equal(mismatch.status,422);
  const altered=structuredClone(request);altered.files[1].modifiedHash='0'.repeat(64);assert.equal((await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(altered)})).status,422);
 }finally{if(server)await server.close();await input.close();}
});

test('Effective compiler paths, not Git paths, determine observable caller file defaults',{timeout:120000,skip:!nativeAvailable},async()=>{
 const input=await fixture();let server;try{
  for(const side of ['before','after'])input.profile[side][0].sources.find(source=>source.path===(side==='before'?'Move.cs':'Moved.cs')).compilerPath='StableCompilerPath.cs';
  server=await input.start();const data=await (await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input.request())})).json();assert.equal(data.contextValid,true);assert.ok(data.results.some(value=>value.path==='Moved.cs'));
 }finally{if(server)await server.close();await input.close();}
});

test('Trusted profiles reject missing options, unsupported properties, changed compiler switches and incomplete projects',{timeout:120000,skip:!nativeAvailable},async()=>{
 const input=await fixture();try{
  for(const mutate of [profile=>delete profile.before[0].options.checkOverflow,profile=>delete profile.before[0].sources[0].compilerPath,profile=>profile.after[0].options.symbols=['CHANGED'],profile=>profile.before[0].complete=false,profile=>profile.before[0].options.sourceGenerators=['arbitrary.dll'],profile=>profile.before[0].sources[0].path='../escape.cs']){
   const profile=structuredClone(input.profile);mutate(profile);await writeFile(input.filename,JSON.stringify(profile));await assert.rejects(()=>loadProfile(input.filename));
  }
 }finally{await input.close();}
});

test('Native compiler keeps unresolved references, changed pinned references, and broken project graphs visible',{timeout:120000,skip:!nativeAvailable},async()=>{
 const input=await fixture();try{
  for(const mutate of [profile=>{for(const side of ['before','after'])profile[side][0].references=[];},profile=>profile.before[0].references[0].sha256='0'.repeat(64),profile=>{for(const side of ['before','after'])profile[side][0].projectReferences=['fixture'];}]){
   const saved=structuredClone(input.profile);mutate(input.profile);const server=await input.start();try{const response=await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input.request())});assert.equal(response.status,200);const data=await response.json();assert.equal(data.contextValid,false);assert.deepEqual(data.results,[]);}finally{await server.close();input.profile=Object.assign(input.profile,saved);}
  }
 }finally{await input.close();}
});

test('Complete project references and every owning target are compiled without running project files',{timeout:120000,skip:!nativeAvailable},async()=>{
 const input=await fixture();let server;try{
  for(const side of ['before','after']){const all=input.profile[side][0];const declaration=all.sources.filter(source=>['Origin.cs','Helper.cs'].includes(source.path));all.sources=all.sources.filter(source=>!declaration.includes(source));all.projectReferences=['support'];input.profile[side].push({...structuredClone(all),id:'support',assemblyName:'Support',sources:declaration,projectReferences:[]});input.profile[side].push({...structuredClone(all),id:'alternate',assemblyName:'Alternate'});}
  server=await input.start();const data=await (await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input.request())})).json();assert.equal(data.contextValid,true);assert.deepEqual(data.results.map(value=>value.path),['Reference.cs']);
 }finally{if(server)await server.close();await input.close();}
});
