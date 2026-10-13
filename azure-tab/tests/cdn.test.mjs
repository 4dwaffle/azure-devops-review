import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const base=process.env.FILTERED_REVIEW_CDN_URL;
test('Deployed CDN: module worker, WASM and trusted semantic equivalence analyzer', {skip:!base,timeout:90000},async()=>{
 assert.match(base,/^https:\/\/vaclavberny\.gallerycdn\.vsassets\.io\/extensions\/vaclavberny\/azure-filtered-review\/\d+\.\d+\.\d+\/\d+$/i);
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try {
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(base+'/dist/equivalence.cs',{waitUntil:'domcontentloaded',timeout:30000});
  const deployed=await page.evaluate(async()=>{
   const response=await fetch('./app.js');if(!response.ok)throw new Error('Deployed UI unavailable');
   const bytes=await response.arrayBuffer(),source=new TextDecoder().decode(bytes);
   return {sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join(''),moveLabel:source.includes('Moved + renamed'),filterLabel:source.includes('File moves and verified rename references'),namespaceLabel:source.includes('Namespace rename propagation (text-only)')};
  });
  const bundled=await readFile(new URL('../dist/app.js',import.meta.url));
  assert.equal(deployed.sha256,createHash('sha256').update(bundled).digest('hex'),'CDN must serve the exact packaged UI');
  assert.equal(deployed.moveLabel,true);assert.equal(deployed.filterLabel,true);assert.equal(deployed.namespaceLabel,true);
  const propagation=await page.evaluate(()=>new Promise((resolve,reject)=>{
   const worker=new Worker(new URL('./analysis-worker.js',location.href),{type:'module'}),timer=setTimeout(()=>{worker.terminate();reject(new Error('Deployed namespace worker timed out'));},15000);
   worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(new Error(event.message));};worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data);};
   worker.postMessage({configurations:[],files:[{path:'New/Entity.cs',oldPath:'Old/Entity.cs',status:'R',original:'namespace Old.Data; public class Entity {}',modified:'namespace New.Data; public class Entity {}'},{path:'Reference.cs',status:'M',original:'using Old.Data; class R { Old.Data.Entity value; }',modified:'using New.Data; class R { New.Data.Entity value; }'},{path:'Mixed.cs',status:'M',original:'using Old.Data; class X { int x=1; }',modified:'using New.Data; class X { int x=2; }'}]});
  }));
  assert.equal(propagation.semanticPending,true);assert.deepEqual(propagation.namespaceRenames.map(pair=>[pair.from,pair.to]),[['Old.Data','New.Data']]);
  const candidates=new Map(propagation.classifications.map(value=>[value.path,value]));
  for(const path of ['New/Entity.cs','Reference.cs']){assert.equal(candidates.get(path).namespaceTextOnly,true);assert.equal(candidates.get(path).renameOnly,false);assert.notEqual(candidates.get(path).semanticVerified,true);}
  assert.equal(candidates.get('Mixed.cs').namespaceTextOnly,false);
  const result=await page.evaluate(async()=>{
   const module=await import('./roslyn/index.js');
   const runtime=await module.WasmSharpModule.initializeAsync();
   const files=[
    {path:'Origin.cs',original:'class Old {}',modified:'class New {}',renameOnly:false},
    {path:'Reference.cs',original:'class R { Old value; }',modified:'class R { New value; }',renameOnly:true},
    {path:'Format.cs',original:'class F {}',modified:'class F { }',formattingOnly:true},
    {path:'Using.cs',original:'using System; class U {}',modified:'class U {}',usingsOnly:true},
    {path:'Behavior.cs',original:'class B { int M()=>1; }',modified:'class B { int M()=>2; }',formattingOnly:true},
    {path:'Moved.cs',oldPath:'Original.cs',original:'using System; using System.Runtime.CompilerServices; class M { static string P([CallerFilePath] string path="")=>path; static string Value()=>P(); }',modified:'using System.Runtime.CompilerServices; class M { static string P([CallerFilePath] string path="")=>path; static string Value()=>P(); }',usingsOnly:true},
    {path:'CallerReference.cs',oldPath:'OriginalCallerReference.cs',original:'using System.Runtime.CompilerServices; class PathReference { static string P(object value, [CallerFilePath] string path="")=>path; static string M()=>P(new Old()); }',modified:'using System.Runtime.CompilerServices; class PathReference { static string P(object value, [CallerFilePath] string path="")=>path; static string M()=>P(new New()); }',renameOnly:true},
    {path:'ArgumentReference.cs',original:'using System.Runtime.CompilerServices; class ArgumentReference { static string P(object value, [CallerArgumentExpression("value")] string expression="")=>expression; static string M()=>P(new Old()); }',modified:'using System.Runtime.CompilerServices; class ArgumentReference { static string P(object value, [CallerArgumentExpression("value")] string expression="")=>expression; static string M()=>P(new New()); }',renameOnly:true},
    {path:'LineReference.cs',original:'using System.Runtime.CompilerServices; class LineReference { static int P(object value, [CallerLineNumber] int line=0)=>line; static int M()=>P(new Old()); }',modified:'using System.Runtime.CompilerServices; class LineReference { static int P(object value, [CallerLineNumber] int line=0)=>line;\n static int M()=>P(new New()); }',renameOnly:true},
    {path:'ConstructorReference.cs',oldPath:'OriginalConstructorReference.cs',original:'using System.Runtime.CompilerServices; class ConstructorReference { public ConstructorReference(object value, [CallerFilePath] string path="") {} static object M()=>new ConstructorReference(new Old()); }',modified:'using System.Runtime.CompilerServices; class ConstructorReference { public ConstructorReference(object value, [CallerFilePath] string path="") {} static object M()=>new ConstructorReference(new New()); }',renameOnly:true},
    {path:'AttributeReference.cs',oldPath:'OriginalAttributeReference.cs',original:'using System.Runtime.CompilerServices; class A:System.Attribute { public A(System.Type type, [CallerFilePath] string path="") {} } [A(typeof(Old))] class AttributeReference {}',modified:'using System.Runtime.CompilerServices; class A:System.Attribute { public A(System.Type type, [CallerFilePath] string path="") {} } [A(typeof(New))] class AttributeReference {}',renameOnly:true},
    {path:'StableReference.cs',original:'using System.Runtime.CompilerServices; class StableReference { static string P(object value, [CallerFilePath] string path="", [CallerLineNumber] int line=0)=>path+line; static string M()=>P(new Old()); }',modified:'using System.Runtime.CompilerServices; class StableReference { static string P(object value, [CallerFilePath] string path="", [CallerLineNumber] int line=0)=>path+line; static string M()=>P(new New()); }',renameOnly:true},
   ];
   const literal=value=>'D("'+btoa(value)+'")';
   const input='var files = new File[] {'+files.map(file=>'new File {path='+literal(file.path)+',oldPath='+literal(file.oldPath||file.path)+',original='+literal(file.original)+',modified='+literal(file.modified)+',formattingOnly='+!!file.formattingOnly+',usingsOnly='+!!file.usingsOnly+',renameOnly='+!!file.renameOnly+'}').join(',')+'}; var pairs = new Pair[] {new Pair {ns='+literal('')+',from='+literal('Old')+',to='+literal('New')+',kind='+literal('type')+'}};';
   const response=await fetch('./equivalence.cs');if(!response.ok)throw new Error('Deployed analyzer unavailable');
   const source=(await response.text()).replace('__REVIEW_DATA__',input);
   const compilation=await runtime.createCompilationAsync(source);
   return await compilation.run();
  });
  assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.stdErr,'');assert.deepEqual(errors,[]);
  const rows=new Map(result.stdOut.trim().split('\n').map(line=>{const [path,formatting,usings,rename]=line.trim().split('|');return [Buffer.from(path,'base64').toString('utf8'),{formatting,usings,rename}];}));
  assert.equal(rows.size,12);
  for(const path of ['Moved.cs','CallerReference.cs','ArgumentReference.cs','LineReference.cs','ConstructorReference.cs','AttributeReference.cs'])assert.deepEqual(rows.get(path),{formatting:'False',usings:'False',rename:'False'},path);
  assert.equal(rows.get('StableReference.cs').rename,'True');
  assert.equal(rows.get('Origin.cs').rename,'False');
  assert.equal(rows.get('Reference.cs').rename,'True');
  assert.equal(rows.get('Format.cs').formatting,'True');
  assert.equal(rows.get('Using.cs').usings,'True');
  assert.deepEqual(rows.get('Behavior.cs'),{formatting:'False',usings:'False',rename:'False'});
 } finally {await browser.close();}
});
