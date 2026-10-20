import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
test('Marketplace packages the UI and workers without compiler runtimes or assemblies',async()=>{
 execFileSync(process.execPath,['build.mjs'],{cwd:root,stdio:'pipe'});
 const manifest=JSON.parse(await readFile(resolve(root,'vss-extension.package.json'),'utf8'));
 assert.deepEqual(manifest.scopes,['vso.code_write']);
 assert.equal(manifest.public,false);
 for(const path of ['dist/app.js','dist/analysis-worker.js','dist/editor.worker.js'])assert.equal(manifest.files.find(file=>file.path===path)?.contentType,'application/javascript',path);
 const modules=manifest.files.filter(file=>/\.(js|mjs)$/.test(file.path));assert.equal(modules.length,3);
 for(const file of modules)assert.equal(file.contentType,'application/javascript',file.path);
 assert.deepEqual(manifest.files.filter(file=>/\.(?:wasm|dll|pdb|dat|cs)$|roslyn|comlink/i.test(file.path)),[]);
 assert.ok(manifest.files.some(file=>file.path.includes('licenses/monaco-editor-')),'Retain licenses for shipped components');
 assert.ok(manifest.files.some(file=>file.path.includes('licenses/fflate-')),'Retain the bulk ZIP decoder license');
});
