let runtimePromise, compilation;
async function verifyBatch(candidates, classifications, pairs) {
 if(!classifications.some(value=>candidates.some(file=>file.path===value.path)&&(value.formattingOnly||value.usingsOnly||value.renameOnly&&!value.fileRenameOnly)))return [];
 if(candidates.length>250||candidates.reduce((sum,file)=>sum+file.original.length+file.modified.length,0)>4000000)throw new Error('Roslyn analysis size limit exceeded');
 const byPath=new Map(classifications.map(value=>[value.path,value]));
 const payload={files:candidates.map(file=>({path:file.path,original:file.original,modified:file.modified,formattingOnly:!!byPath.get(file.path)?.formattingOnly,usingsOnly:!!byPath.get(file.path)?.usingsOnly,renameOnly:!!byPath.get(file.path)?.renameOnly&&!byPath.get(file.path)?.fileRenameOnly})),pairs};
 const literal=text=>{const bytes=new TextEncoder().encode(text||'');let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return 'D("'+btoa(binary)+'")';};
 const inputs='var files = new File[] {'+payload.files.map(file=>'new File {path='+literal(file.path)+',original='+literal(file.original)+',modified='+literal(file.modified)+',formattingOnly='+file.formattingOnly+',usingsOnly='+file.usingsOnly+',renameOnly='+file.renameOnly+'}').join(',')+'}; var pairs = new Pair[] {'+pairs.map(pair=>'new Pair {ns='+literal(pair.namespace)+',from='+literal(pair.from)+',to='+literal(pair.to)+',kind='+literal(pair.kind)+'}').join(',')+'};';
 const template=await fetch(new URL('./equivalence.cs',import.meta.url)).then(response=>{if(!response.ok)throw new Error('Trusted Roslyn analyzer unavailable');return response.text();});
 // Every PR-controlled string is base64 data, never interpolated as executable C#.
 const source=template.replace('__REVIEW_DATA__',inputs);
 runtimePromise??=import(new URL('./roslyn/index.js',import.meta.url).href).then(module=>module.WasmSharpModule.initializeAsync());
 const runtime=await runtimePromise;
 if(!compilation)compilation=await runtime.createCompilationAsync(source);else await compilation.recompileAsync(source);
 const result=await compilation.run();
 if(!result.success||result.stdErr)throw new Error(result.stdErr||result.diagnostics?.map(d=>d.message).join('; ')||'Trusted Roslyn analyzer failed');
 const decode=value=>new TextDecoder().decode(Uint8Array.from(atob(value),char=>char.charCodeAt(0)));
 const verified=result.stdOut.trim().split('\n').filter(Boolean).map(line=>{const [path,formatting,usings,rename,reason]=line.trim().split('|');return {path:decode(path),formattingOnly:formatting==='True',usingsOnly:usings==='True',renameOnly:rename==='True',semanticVerified:[formatting,usings,rename].includes('True'),semanticReason:decode(reason)};});
 if(!Array.isArray(verified)||verified.length!==candidates.length)throw new Error('Invalid Roslyn equivalence response');
 return verified;
}
export async function verifyEquivalence(files, classifications, pairs) {
 const candidates=files.filter(file=>/\.cs$/i.test(file.path)&&!file.error&&!file.binary&&typeof file.original==='string'&&typeof file.modified==='string');
 const size=file=>file.original.length+file.modified.length;
 if(candidates.length<=250&&candidates.reduce((sum,file)=>sum+size(file),0)<=4000000)return verifyBatch(candidates,classifications,pairs);
 // Reference bindings require the complete changed-source context. Never pretend a truncated batch proves a rename.
 const byPath=new Map(classifications.map(value=>[value.path,value]));
 const eligible=candidates.filter(file=>byPath.get(file.path)?.formattingOnly||byPath.get(file.path)?.usingsOnly);
 const verified=[];let batch=[],characters=0;
 const flush=async()=>{if(batch.length)verified.push(...await verifyBatch(batch,classifications.map(value=>({...value,renameOnly:false})),[]));batch=[];characters=0;};
 for(const file of eligible){
  if(size(file)>4000000)continue;
  if(batch.length>=50||characters+size(file)>4000000)await flush();
  batch.push(file);characters+=size(file);
 }
 await flush();
 const results=new Map(verified.map(value=>[value.path,value]));
 return candidates.map(file=>results.get(file.path)||{path:file.path,formattingOnly:false,usingsOnly:false,renameOnly:false,semanticVerified:false,semanticReason:'Complete rename-binding context exceeds browser limits; kept visible. Formatting and using candidates are analyzed in bounded batches.'});
}
