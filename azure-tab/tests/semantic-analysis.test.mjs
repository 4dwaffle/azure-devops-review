import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEquivalence} from '../src/semantic-analysis.mjs';

test('large-context namespace import renames never run incomplete compiler batches',async()=>{
 const files=Array.from({length:251},(_,i)=>({path:`Reference${i}.cs`,original:`using Old.Namespace; class Reference${i} { Widget value; }`,modified:`using New.Namespace; class Reference${i} { Widget value; }`}));
 const classifications=files.map(file=>({path:file.path,usingsOnly:true,renameOnly:true}));
 const fetch=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;throw Error('Incomplete binding context must not initialize Roslyn');};
 try{
  const results=await verifyEquivalence(files,classifications,[{kind:'namespace',from:'Old.Namespace',to:'New.Namespace',namespace:''}]);
  assert.equal(requests,0);
  assert.equal(results.length,251);
  for(const result of results){assert.equal(result.semanticVerified,false);assert.equal(result.renameOnly,false);assert.equal(result.usingsOnly,false);assert.match(result.semanticReason,/Complete rename-binding context/);}
 }finally{globalThis.fetch=fetch;}
});
