import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const base=process.env.FILTERED_REVIEW_CDN_URL;
test('Deployed CDN: packaged UI and compiler-free text-analysis worker', {skip:!base,timeout:90000},async()=>{
 assert.match(base,/^https:\/\/vaclavberny\.gallerycdn\.vsassets\.io\/extensions\/vaclavberny\/azure-filtered-review\/\d+\.\d+\.\d+\/\d+$/i);
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try {
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(base+'/dist/styles.css',{waitUntil:'domcontentloaded',timeout:30000});
  const deployed=await page.evaluate(async()=>{
   const response=await fetch('./app.js');if(!response.ok)throw new Error('Deployed UI unavailable');
   const bytes=await response.arrayBuffer(),source=new TextDecoder().decode(bytes);
   return {sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join(''),moveLabel:source.includes('Moved + renamed'),filterLabel:source.includes('File moves (identical contents)'),namespaceLabel:source.includes('Namespace rename propagation (text-only)')};
  });
  const bundled=await readFile(new URL('../dist/app.js',import.meta.url));
  assert.equal(deployed.sha256,createHash('sha256').update(bundled).digest('hex'),'CDN must serve the exact packaged UI');
  assert.equal(deployed.moveLabel,true);assert.equal(deployed.filterLabel,true);assert.equal(deployed.namespaceLabel,true);
  const propagation=await page.evaluate(()=>new Promise((resolve,reject)=>{
   const worker=new Worker(new URL('./analysis-worker.js',location.href),{type:'module'}),timer=setTimeout(()=>{worker.terminate();reject(new Error('Deployed namespace worker timed out'));},15000);
   worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(new Error(event.message));};worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data);};
   worker.postMessage({configurations:[],files:[{path:'New/Entity.cs',oldPath:'Old/Entity.cs',status:'R',original:'namespace Old.Data; public class Entity {}',modified:'namespace New.Data; public class Entity {}'},{path:'Reference.cs',status:'M',original:'using Old.Data; class R { Old.Data.Entity value; }',modified:'using New.Data; class R { New.Data.Entity value; }'},{path:'UpdateMachineUseCase.cs',status:'M',original:'using Old.Data;\nclass Handler { string M(int id)=>$"Machine {id} not found."; }',modified:'using New.Data;\nclass Handler { string M(int id)=>$"Machine {id} not found."; }'},{path:'Mixed.cs',status:'M',original:'using Old.Data; class X { int x=1; }',modified:'using New.Data; class X { int x=2; }'}]});
  }));
  assert.equal(propagation.semanticPending,undefined);assert.deepEqual(propagation.namespaceRenames.map(pair=>[pair.from,pair.to]),[['Old.Data','New.Data']]);
  const candidates=new Map(propagation.classifications.map(value=>[value.path,value]));
  for(const path of ['New/Entity.cs','Reference.cs','UpdateMachineUseCase.cs']){assert.equal(candidates.get(path).namespaceTextOnly,true);assert.equal(candidates.get(path).renameOnly,false);assert.notEqual(candidates.get(path).semanticVerified,true);}
  assert.equal(candidates.get('Mixed.cs').namespaceTextOnly,false);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
