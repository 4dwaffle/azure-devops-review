import {test} from 'node:test';import assert from 'node:assert/strict';
import {companionUrl,verifyWithCompanion} from '../src/companion.mjs';
const url=`http://127.0.0.1:54321/${'a'.repeat(64)}/verify`;
const snapshot={repositoryId:'repo',base:'b'.repeat(40),source:'c'.repeat(40)};
const files=[{path:'Reference.cs',original:'class Ref { Old field; }',modified:'class Ref { New field; }'}],classifications=[{path:'Reference.cs',renameOnly:true}];
test('Companion is opt-in, numeric loopback only, and sends identities rather than source text',async()=>{
 assert.equal(companionUrl(''),'');for(const invalid of ['https://remote.invalid/verify',url.replace('127.0.0.1','localhost'),url+'?token=external',url+'#fragment',url.replace('/verify','/other')])assert.throws(()=>companionUrl(invalid));
 let calls=0;const disabled=await verifyWithCompanion('',snapshot,files,classifications,()=>{calls++;throw new Error();});assert.equal(calls,0);assert.deepEqual(disabled.results,[]);
 const response=await verifyWithCompanion(url,snapshot,files,classifications,async(endpoint,options)=>{calls++;assert.equal(endpoint,url);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');assert.ok(!options.body.includes(files[0].original));const request=JSON.parse(options.body);assert.equal(request.files[0].originalHash.length,64);return {ok:true,json:async()=>({...request,contextValid:true,results:request.files.map(file=>({...file,renameOnly:true,semanticVerified:true}))})};});assert.equal(calls,1);assert.equal(response.results[0].renameOnly,true);
});
test('Stale snapshots, wrong paths, wrong hashes, duplicate proofs and unreachable companions fail open',async()=>{
 for(const mutate of [data=>data.source='d'.repeat(40),data=>data.results[0].oldPath='Another.cs',data=>data.results[0].modifiedHash='0'.repeat(64),data=>data.contextValid=false,data=>data.results.push(data.results[0]),data=>data.results[0].path='Injected.cs']){
  const response=await verifyWithCompanion(url,snapshot,files,classifications,async(_,options)=>{const request=JSON.parse(options.body);const data={...request,contextValid:true,results:request.files.map(file=>({...file,renameOnly:true,semanticVerified:true}))};mutate(data);return {ok:true,json:async()=>data};});assert.deepEqual(response.results,[]);assert.match(response.summary,/stay visible/);assert.ok(!response.summary.includes(url));
 }
 const failure=await verifyWithCompanion(url,snapshot,files,classifications,()=>{throw new Error(url)});assert.deepEqual(failure.results,[]);assert.ok(!failure.summary.includes(url));
 const unsafe=await verifyWithCompanion(url,snapshot,files.map(file=>({...file,modeChanged:true})),classifications,async(_,options)=>{const request=JSON.parse(options.body);assert.deepEqual(request.files,[]);return {ok:true,json:async()=>({...request,contextValid:true,results:[]})};});assert.deepEqual(unsafe.results,[]);
});
