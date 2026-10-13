import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
test('Marketplace declares executable transitive modules and WASM with correct MIME types',async()=>{
 execFileSync(process.execPath,['build.mjs'],{cwd:root,stdio:'pipe'});
 const manifest=JSON.parse(await readFile(resolve(root,'vss-extension.package.json'),'utf8'));
 assert.deepEqual(manifest.scopes,['vso.code_write']);
 assert.equal(manifest.public,false);
 for(const path of ['dist/app.js','dist/analysis-worker.js','dist/roslyn/index.js','dist/comlink.mjs'])assert.equal(manifest.files.find(file=>file.path===path)?.contentType,'application/javascript',path);
 const modules=manifest.files.filter(file=>/\.(js|mjs)$/.test(file.path));assert.ok(modules.length>10);
 for(const file of modules)assert.equal(file.contentType,'application/javascript',file.path);
 const binaries=manifest.files.filter(file=>file.path.endsWith('.wasm'));assert.ok(binaries.length>0);
 for(const file of binaries)assert.equal(file.contentType,'application/wasm',file.path);
});
