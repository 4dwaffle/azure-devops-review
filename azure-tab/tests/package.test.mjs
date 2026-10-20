import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
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

test('TFX resolves manifest globs and packages nested assets with the private release identity',async()=>{
 const directory=await mkdtemp(resolve(tmpdir(),'review-vsix-'));
 try{
  const manifest=JSON.parse(await readFile(resolve(root,'vss-extension.json'),'utf8'));
  manifest.version='0.2.123';
  await writeFile(resolve(directory,'vss-extension.json'),JSON.stringify(manifest));
  await mkdir(resolve(directory,'dist/nested'),{recursive:true});
  const assets={'dist/index.html':'<script src="nested/app.js"></script>','dist/nested/app.js':'console.log("packaged");'};
  for(const [path,contents] of Object.entries(assets))await writeFile(resolve(directory,path),contents);
  const tfxRequire=createRequire(resolve(root,'node_modules/tfx-cli/package.json'));
  execFileSync(process.execPath,[tfxRequire.resolve('tfx-cli/_build/tfx-cli.js'),'extension','create','--root',directory,'--manifest-globs','vss-ext*.json','--output-path',directory,'--no-prompt'],{stdio:'pipe'});
  const packages=(await readdir(directory)).filter(path=>path.endsWith('.vsix'));
  assert.equal(packages.length,1);
  const archive=await tfxRequire('jszip').loadAsync(await readFile(resolve(directory,packages[0])));
  const vsix=await tfxRequire('xml2js').parseStringPromise(await archive.file('extension.vsixmanifest').async('string'));
  const metadata=vsix.PackageManifest.Metadata[0];
  assert.equal(metadata.Identity[0].$.Id,'azure-filtered-review');
  assert.equal(metadata.Identity[0].$.Publisher,'VaclavBerny');
  assert.equal(metadata.Identity[0].$.Version,manifest.version);
  assert.doesNotMatch(String(metadata.GalleryFlags),/Public/);
  for(const [path,contents] of Object.entries(assets))assert.equal(await archive.file(path).async('string'),contents,path);
 }finally{await rm(directory,{recursive:true,force:true});}
});
