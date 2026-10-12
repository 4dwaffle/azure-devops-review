import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const root=fileURLToPath(new URL('.',import.meta.url));
const server=createServer(async(req,res)=>{
 try {
  let path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(path.startsWith('/wasm/')&&!extname(path))path+='.js';
  const relative=path==='/comlink.mjs'?'node_modules/comlink/dist/esm/comlink.mjs':path.startsWith('/wasm/')?'node_modules/@wasmsharp/core/'+path.slice(6):'index.html';
  const file=resolve(root,relative);
  if(!file.startsWith(root.endsWith(sep)?root:root+sep)) throw new Error('Invalid path');
  let data=await readFile(file);
  const type=extname(file);
  if(type==='.js') data=Buffer.from(data.toString().replaceAll('https://unpkg.com/comlink/dist/esm/comlink.mjs','/comlink.mjs').replace(/import (\w+) from (["'])(\.\/[^"']+\.(?:dll|wasm|dat|pdb))\2;/g,(_,name,quote,url)=>`const ${name}=new URL(${JSON.stringify(url)},import.meta.url).href;`));
  res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.wasm':'application/wasm'})[type]||'application/octet-stream');res.end(data);
 }catch(error){res.writeHead(404);res.end(String(error));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
 browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 const context=await browser.newContext();
 const external=[];
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='127.0.0.1'){external.push(url.href);return route.abort();}return route.continue();});
 const page=await context.newPage();let workers=0;page.on('worker',()=>workers++);
 page.on('pageerror',error=>console.error('Browser error:',String(error)));page.on('console',message=>{if(['error','warning'].includes(message.type()))console.error('Browser console:',message.text());});page.on('response',response=>{if(response.status()>=400||response.request().resourceType()==='script'&&!response.headers()['content-type']?.includes('javascript'))console.error('HTTP:',response.status(),response.headers()['content-type'],response.url());});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>window.probeResult||window.failure,{},{timeout:120000});
 const {result,failure}=await page.evaluate(()=>({result:window.probeResult,failure:window.failure}));
 assert.equal(failure,undefined);assert.ok(workers>0,'Roslyn must actually run in a web worker');assert.deepEqual(external,[]);
 assert.ok(result.cases.syntax.some(d=>d.id==='CS1525'),'Real Roslyn syntax diagnostic');
 assert.ok(result.cases.unreachable.some(d=>d.id==='CS0162'),'Real Roslyn unreachable-code warning');
 const report={...result,workers,externalRequests:external.length,ide0051:result.cases.unusedPrivate.some(d=>d.id==='IDE0051')};
 await writeFile(new URL('results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
