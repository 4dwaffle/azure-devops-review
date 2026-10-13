import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';

const base=process.env.FILTERED_REVIEW_CDN_URL;
test('Deployed CDN: module worker, WASM and trusted semantic equivalence analyzer', {skip:!base,timeout:90000},async()=>{
 assert.match(base,/^https:\/\/vaclavberny\.gallerycdn\.vsassets\.io\/extensions\/vaclavberny\/azure-filtered-review\/\d+\.\d+\.\d+\/\d+$/i);
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try {
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(base+'/dist/equivalence.cs',{waitUntil:'domcontentloaded',timeout:30000});
  const result=await page.evaluate(async()=>{
   const module=await import('./roslyn/index.js');
   const runtime=await module.WasmSharpModule.initializeAsync();
   const files=[
    {path:'Origin.cs',original:'class Old {}',modified:'class New {}',renameOnly:false},
    {path:'Reference.cs',original:'class R { Old value; }',modified:'class R { New value; }',renameOnly:true},
    {path:'Format.cs',original:'class F {}',modified:'class F { }',formattingOnly:true},
    {path:'Using.cs',original:'using System; class U {}',modified:'class U {}',usingsOnly:true},
    {path:'Behavior.cs',original:'class B { int M()=>1; }',modified:'class B { int M()=>2; }',formattingOnly:true},
   ];
   const literal=value=>'D("'+btoa(value)+'")';
   const input='var files = new File[] {'+files.map(file=>'new File {path='+literal(file.path)+',original='+literal(file.original)+',modified='+literal(file.modified)+',formattingOnly='+!!file.formattingOnly+',usingsOnly='+!!file.usingsOnly+',renameOnly='+!!file.renameOnly+'}').join(',')+'}; var pairs = new Pair[] {new Pair {ns='+literal('')+',from='+literal('Old')+',to='+literal('New')+',kind='+literal('type')+'}};';
   const response=await fetch('./equivalence.cs');if(!response.ok)throw new Error('Deployed analyzer unavailable');
   const source=(await response.text()).replace('__REVIEW_DATA__',input);
   const compilation=await runtime.createCompilationAsync(source);
   return await compilation.run();
  });
  assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.stdErr,'');assert.deepEqual(errors,[]);
  const rows=new Map(result.stdOut.trim().split('\n').map(line=>{const [path,formatting,usings,rename]=line.trim().split('|');return [Buffer.from(path,'base64').toString('utf8'),{formatting,usings,rename}];}));
  assert.equal(rows.size,5);
  assert.equal(rows.get('Origin.cs').rename,'False');
  assert.equal(rows.get('Reference.cs').rename,'True');
  assert.equal(rows.get('Format.cs').formatting,'True');
  assert.equal(rows.get('Using.cs').usings,'True');
  assert.deepEqual(rows.get('Behavior.cs'),{formatting:'False',usings:'False',rename:'False'});
 } finally {await browser.close();}
});
