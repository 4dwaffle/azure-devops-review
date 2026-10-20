import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.self={};
await import('../src/analysis-worker.mjs');
function analyze(files,configurations=[]){
 const messages=[];globalThis.postMessage=value=>messages.push(value);
 self.onmessage({data:{files:files.map(file=>({status:'M',...file})),configurations,companionUrl:`http://127.0.0.1:1/${'a'.repeat(64)}/verify`}});
 assert.equal(messages.length,1,'Text analysis returns one completed result');
 assert.equal(messages[0].error,undefined);
 return messages[0];
}
test('C# formatting, using and reference edits stay visible without any compiler or network work',()=>{
 const savedFetch=globalThis.fetch;let requests=0;globalThis.fetch=()=>{requests++;throw Error('Analysis must not request a compiler');};
 try{
  const result=analyze([
   {path:'Format.cs',original:'class F {}',modified:'class F { }'},
   {path:'Using.cs',original:'using System; class U {}',modified:'using System.Text; class U {}'},
   {path:'Origin.cs',original:'class Old {}',modified:'class New {}'},
   {path:'Reference.cs',original:'class Ref { Old value; }',modified:'class Ref { New value; }'},
   {path:'Caller.cs',original:'using System.Runtime.CompilerServices; class C { static int L([CallerLineNumber] int n=0)=>n; static int M()=>L(); }',modified:'using System.Runtime.CompilerServices; class C { static int L([CallerLineNumber] int n=0)=>n;\n static int M()=>L(); }'},
   {path:'Mixed.cs',original:'class M { int value=1; }',modified:'class M { int value=2; }'},
  ]);
  assert.equal(requests,0);assert.equal(result.semanticPending,undefined);
  for(const value of result.classifications){assert.equal(value.formattingOnly,false,value.path);assert.equal(value.usingsOnly,false,value.path);assert.equal(value.renameOnly,false,value.path);assert.notEqual(value.semanticVerified,true);}
 }finally{globalThis.fetch=savedFetch;}
});
test('Exact file moves, JSON formatting and generated policies work; mode changes and uncertain configuration stay visible',()=>{
 const files=[
  {path:'New.cs',oldPath:'Old.cs',status:'R100',blobUnchanged:true,original:'class A {}',modified:'class A {}'},
  {path:'Mode.cs',oldPath:'ModeOld.cs',status:'R100',blobUnchanged:true,modeChanged:true,original:'class B {}',modified:'class B {}'},
  {path:'Format.json',original:'{"a":1}',modified:'{ "a": 1 }'},
  {path:'Generated.g.cs',original:'class G {}',modified:'class G { int x; }'},
 ];
 const values=new Map(analyze(files).classifications.map(value=>[value.path,value]));
 assert.equal(values.get('New.cs').renameOnly,true);assert.equal(values.get('Mode.cs').renameOnly,false);assert.equal(values.get('Format.json').formattingOnly,true);assert.equal(values.get('Generated.g.cs').generated,true);
 const configured=analyze(files,[{contents:'[*.cs]\ngenerated_code = false'}]);assert.equal(configured.configUnknown,true);assert.equal(configured.classifications.find(value=>value.path==='Generated.g.cs').generated,false);
});
test('Namespace text candidates remain independent of C# equivalence filtering',()=>{
 const result=analyze([
  {path:'Entity.cs',original:'namespace Old.Data; public class Entity {}',modified:'namespace New.Data; public class Entity {}'},
  {path:'Reference.cs',original:'using Old.Data; class R { Old.Data.Entity value; }',modified:'using New.Data; class R { New.Data.Entity value; }'},
  {path:'Mixed.cs',original:'using Old.Data; class M { int x=1; }',modified:'using New.Data; class M { int x=2; }'},
 ]);
 const values=new Map(result.classifications.map(value=>[value.path,value]));
 assert.deepEqual(result.namespaceRenames.map(value=>[value.from,value.to]),[['Old.Data','New.Data']]);
 assert.equal(values.get('Reference.cs').namespaceTextOnly,true);assert.equal(values.get('Reference.cs').renameOnly,false);assert.equal(values.get('Mixed.cs').namespaceTextOnly,false);
});
