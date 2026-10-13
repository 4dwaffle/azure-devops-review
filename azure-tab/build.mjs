import {build} from 'esbuild';
import {cp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=import.meta.dirname;
const testUi=process.argv.includes('--test-ui')||process.argv.includes('--companion-test');
const out=resolve(root,process.argv.includes('--companion-test')?'dist-companion-test':testUi?'dist-test':'dist');
const packages=new Set([resolve(root,'node_modules','@wasmsharp','core'),resolve(root,'node_modules','comlink')]);
async function bundle(options){const result=await build({absWorkingDir:root,metafile:true,...options});for(const input of Object.keys(result.metafile.inputs)){const match=resolve(root,input).match(/^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)/);if(match)packages.add(match[1]);}}
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
const generated=await readFile(resolve(root,'..','generated-code.mjs'),'utf8');
const plugins=[{name:'browser-review-core',setup(builder){
 builder.onResolve({filter:/^node:path$/},()=>({path:resolve(root,'src','path.mjs')}));
 builder.onLoad({filter:/[\\/]analysis\.mjs$/},async args=>({contents:(await readFile(args.path,'utf8')).replace("Buffer.byteLength(text, 'utf8')","new TextEncoder().encode(text).length"),loader:'js'}));
 builder.onLoad({filter:/generated-code\.mjs$/},()=>({contents:generated.slice(0,generated.indexOf('export function generatedClassifier')).replace("import { posix, resolve, sep } from 'node:path';","import { posix } from 'node:path';").replace("import { parseFromFilesSync } from 'editorconfig';",'')+'\nexport function generatedClassifier() { return () => null; }',loader:'js'}));
}}];
await bundle({entryPoints:[resolve(root,'src',testUi?'app.mjs':'main.mjs')],bundle:true,outfile:resolve(out,'app.js'),format:'esm',platform:'browser',plugins,minify:true,loader:{'.ttf':'file'},legalComments:'linked'});
await bundle({entryPoints:[resolve(root,'src','analysis-worker.mjs')],bundle:true,outfile:resolve(out,'analysis-worker.js'),format:'esm',platform:'browser',plugins,minify:true,legalComments:'linked'});
await bundle({entryPoints:[resolve(root,'node_modules','monaco-editor','esm','vs','editor','editor.worker.js')],bundle:true,outfile:resolve(out,'editor.worker.js'),format:'esm',platform:'browser',minify:true,legalComments:'linked'});
for(const file of ['index.html','styles.css','equivalence.cs']) await cp(resolve(root,'src',file),resolve(out,file));
await cp(resolve(root,'node_modules','@wasmsharp','core'),resolve(out,'roslyn'),{recursive:true});
await cp(resolve(root,'node_modules','comlink','dist','esm','comlink.mjs'),resolve(out,'comlink.mjs'));
async function localize(directory){for(const item of await readdir(directory,{withFileTypes:true})){const path=resolve(directory,item.name);if(item.isDirectory())await localize(path);else if(item.name.endsWith('.js')) {const source=await readFile(path,'utf8');await writeFile(path,'// Modified for Filtered Review: local Comlink, native ESM module paths, and URL-based binary assets.\n'+source.replaceAll('https://unpkg.com/comlink/dist/esm/comlink.mjs','../comlink.mjs').replace(/import (\w+) from (["'])(\.\/[^"']+\.(?:dll|wasm|dat|pdb))\2;/g,(_,name,quote,url)=>`const ${name}=new URL(${JSON.stringify(url)},import.meta.url).href;`).replace(/from (["'])(\.\.?\/[^"']+)\1/g,(match,quote,url)=>/\.[a-z]+$/i.test(url)?match:`from ${quote}${url}.js${quote}`));}}}
await localize(resolve(out,'roslyn'));
await mkdir(resolve(out,'licenses'),{recursive:true});
await cp(resolve(root,'third-party'),resolve(out,'licenses'),{recursive:true});
for(const directory of packages){const name=directory.split(/[\\/]node_modules[\\/]/).at(-1).replaceAll(/[/\\]/g,'-');for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isFile()&&/^(licen[sc]e|notice|copying)/i.test(entry.name))await cp(resolve(directory,entry.name),resolve(out,'licenses',name+'-'+entry.name+'.txt'));}}
if(!testUi){const manifest=JSON.parse(await readFile(resolve(root,'vss-extension.json'),'utf8'));manifest.files=[];async function assets(directory,prefix='dist'){for(const entry of await readdir(directory,{withFileTypes:true})){const path=prefix+'/'+entry.name;if(entry.isDirectory())await assets(resolve(directory,entry.name),path);else manifest.files.push({path,addressable:true,...(/\.(?:js|mjs)$/i.test(entry.name)?{contentType:'application/javascript'}:entry.name.endsWith('.wasm')?{contentType:'application/wasm'}:/\.(?:dat|dll|pdb)$/i.test(entry.name)?{contentType:'application/octet-stream'}:entry.name.endsWith('.cs')?{contentType:'text/plain'}:{})});}}await assets(out);await writeFile(resolve(root,'vss-extension.package.json'),JSON.stringify(manifest,null,2));}
console.log('Built self-contained Azure PR tab, Monaco workers and on-demand browser Roslyn.');
