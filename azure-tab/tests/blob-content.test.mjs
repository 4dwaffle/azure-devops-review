import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {zipSync} from 'fflate';
import {decodeContent,preloadContents} from '../src/blob-content.mjs';

const base='b'.repeat(40),source='c'.repeat(40);
const utf8={encoding:65001,isBinary:false};
const gitBlobId=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const archive=files=>{
 const bytes=zipSync(files,{level:1});
 return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
};
function blob(path,text,{version=source,mode='100644',metadata=utf8}={}){
 const bytes=typeof text==='string'?Buffer.from(text):text;
 const id=gitBlobId(bytes);
 return {id,bytes,request:{path,version,entry:{objectId:id,mode}},item:{path:'/'+path,commitId:version,objectId:id,contentMetadata:metadata}};
}
const descriptor=request=>({path:'/'+request.path,version:request.version,versionType:2,recursionLevel:0});
function bulkClient(records,{zipFiles,items}={}){
 const zipCalls=[],metadataCalls=[];
 return {zipCalls,metadataCalls,client:{
  getBlobsZip:async(...args)=>{zipCalls.push(args);return archive(zipFiles??Object.fromEntries(records.map(record=>[record.id,record.bytes])));},
  getItemsBatch:async(...args)=>{metadataCalls.push(args);return items??records.map(record=>[record.item]);}
 }};
}

test('Decodes ASCII marked 1252 and strict UTF-8, including BOM, without changing Azure metadata',()=>{
 for(const [bytes,metadata,content] of [
  [Buffer.from('class C {}\r\n'),{encoding:1252,isBinary:false},'class C {}\r\n'],
  [Buffer.from('Příliš žluťoučký 🐈\n'),utf8,'Příliš žluťoučký 🐈\n'],
  [Buffer.from('\ufeffclass C {}\r\n'),utf8,'class C {}\r\n'],
  [Buffer.alloc(0),utf8,'']
 ]){
  const result=decodeContent(bytes,metadata);
  assert.deepEqual(result,{content,contentMetadata:metadata});
  assert.equal(result.contentMetadata,metadata);
 }
 const metadata={encoding:-1,isBinary:true};
 assert.deepEqual(decodeContent(Uint8Array.of(0,255,254,128),metadata),{contentMetadata:metadata});
});

test('Missing metadata, legacy or ambiguous encodings, malformed UTF-8 and NUL text require Azure conversion',()=>{
 for(const [bytes,metadata] of [
  [Buffer.from('text'),undefined],
  [Buffer.from('text'),{}],
  [Buffer.from('text'),{encoding:'65001',isBinary:false}],
  [Buffer.from('text','utf16le'),{encoding:1200,isBinary:false}],
  [Uint8Array.of(0x80,0x96),{encoding:1252,isBinary:false}],
  [Buffer.from('český UTF-8 labelled 1252'),{encoding:1252,isBinary:false}],
  [Uint8Array.of(0xc3,0x28),utf8],
  [Uint8Array.of(0xf0,0x9f,0x90),utf8],
  [Buffer.from('text\0more'),utf8]
 ])assert.throws(()=>decodeContent(bytes,metadata),undefined,JSON.stringify(metadata));
});

test('ZIP and nested Azure metadata order cannot associate the wrong blob or immutable snapshot',async()=>{
 const before=blob('src/A.cs','class Before {}',{version:base});
 const after=blob('src/A.cs','class After {}');
 const ascii=blob('README.md','ASCII\r\n',{metadata:{encoding:1252,isBinary:false},mode:'100755'});
 const empty=blob('empty.txt','');
 const records=[before,after,ascii,empty];
 const {client,zipCalls,metadataCalls}=bulkClient(records,{
  zipFiles:Object.fromEntries([...records].reverse().map(record=>[record.id,record.bytes])),
  items:[[ascii.item,after.item],[],[{...before.item,path:'/unrequested.cs'},empty.item],[before.item]]
 });
 const duplicate={...before.request,path:'old/A.cs',entry:{...before.request.entry,objectId:before.id.toUpperCase()}};
 // The last descriptor for the shared blob wins; supply its actual location.
 const requests=[duplicate,...records.map(record=>record.request)];
 const snapshot=structuredClone(requests),contents=new Map();
 await preloadContents(client,'repo','project',requests,contents);
 assert.deepEqual(requests,snapshot,'Preloading must not rewrite the tree requests');
 assert.equal(zipCalls.length,1);assert.equal(metadataCalls.length,1);
 assert.deepEqual(zipCalls[0],[[before.id,after.id,ascii.id,empty.id],'repo','project']);
 assert.deepEqual(metadataCalls[0],[{includeContentMetadata:true,itemDescriptors:records.map(record=>descriptor(record.request))},'repo','project']);
 assert.equal(contents.size,records.length);
 for(const record of records)assert.deepEqual(await contents.get(record.id),{content:record.bytes.toString(),contentMetadata:record.item.contentMetadata});
});

test('Missing and SHA-corrupt ZIP entries fall back independently while verified siblings are cached',async()=>{
 const good=blob('good.cs','class Good {}');
 const missing=blob('missing.cs','class Missing {}');
 const corrupt=blob('corrupt.cs','class Expected {}');
 const records=[good,missing,corrupt];
 const {client}=bulkClient(records,{zipFiles:{[corrupt.id]:Buffer.from('class Injected {}'),[good.id]:good.bytes,'unrequested.txt':Buffer.from('not a blob')}});
 const contents=new Map();
 await preloadContents(client,'repo','project',records.map(record=>record.request),contents);
 assert.deepEqual([...contents.keys()],[good.id]);
 assert.equal((await contents.get(good.id)).content,'class Good {}');
 assert.equal(contents.has(missing.id),false);
 assert.equal(contents.has(corrupt.id),false,'A valid ZIP member name is insufficient without Git blob SHA-1 verification');
});

test('Metadata must match exact case-sensitive path, immutable version and object ID',async()=>{
 const records=['path','version','object','no-commit','case','good'].map(name=>blob(`src/${name}.cs`,`class ${name.replace('-','_')} {}`));
 const items=records.map(record=>({...record.item}));
 items[0].path='/elsewhere/path.cs';
 items[1].commitId=base;
 items[2].objectId=records[0].id;
 delete items[3].commitId;
 items[4].path='/SRC/case.cs';
 items[5].objectId=records[5].id.toUpperCase();
 const {client}=bulkClient(records,{items:items.reverse().map(item=>[item])});
 const contents=new Map();
 await preloadContents(client,'repo','project',records.map(record=>record.request),contents);
 assert.deepEqual([...contents.keys()],[records[5].id]);
 assert.equal((await contents.get(records[5].id)).content,'class good {}');
});

test('Preloading leaves every unsupported decode uncached and preserves binary, ASCII and UTF-8 BOM results',async()=>{
 const records=[
  blob('ascii.txt','plain ASCII',{metadata:{encoding:1252,isBinary:false}}),
  blob('bom.txt','\ufeffCafé č 🐈'),
  blob('binary.bin',Uint8Array.of(0,255,128),{metadata:{encoding:-1,isBinary:true}}),
  blob('windows.txt',Uint8Array.of(0x80,0x96),{metadata:{encoding:1252,isBinary:false}}),
  blob('ambiguous.txt','český',{metadata:{encoding:1252,isBinary:false}}),
  blob('legacy.txt',Buffer.from('legacy','utf16le'),{metadata:{encoding:1200,isBinary:false}}),
  blob('malformed.txt',Uint8Array.of(0xc3,0x28)),
  blob('nul.txt','text\0more'),
  blob('unknown.txt','unknown',{metadata:{isBinary:false}})
 ];
 const {client}=bulkClient(records),contents=new Map();
 await preloadContents(client,'repo','project',records.map(record=>record.request),contents);
 assert.deepEqual([...contents.keys()].sort(),records.slice(0,3).map(record=>record.id).sort());
 assert.equal((await contents.get(records[0].id)).content,'plain ASCII');
 assert.equal((await contents.get(records[1].id)).content,'Café č 🐈');
 assert.deepEqual(await contents.get(records[2].id),{contentMetadata:{encoding:-1,isBinary:true}});
 for(const record of records.slice(3))assert.equal(contents.has(record.id),false,record.request.path);
});

test('Absent bulk APIs and non-regular or invalid tree objects keep the immutable reader available',async()=>{
 const valid=blob('valid.cs','valid');
 for(const client of [{getBlobsZip:()=>assert.fail('Metadata API is required')},{getItemsBatch:()=>assert.fail('ZIP API is required')},{}]){
  const contents=new Map();
  await preloadContents(client,'repo','project',[valid.request],contents);
  assert.equal(contents.size,0);
 }
 const invalid=[
  {...valid.request,path:'symlink',entry:{...valid.request.entry,mode:'120000'}},
  {...valid.request,path:'submodule',entry:{...valid.request.entry,mode:'160000'}},
  {...valid.request,path:'tree',entry:{...valid.request.entry,mode:'040000'}},
  {...valid.request,entry:{objectId:'0'.repeat(40),mode:'100644'}},
  {...valid.request,entry:{objectId:'g'.repeat(40),mode:'100644'}},
  {...valid.request,entry:{objectId:'abc',mode:'100644'}},
  {...valid.request,entry:undefined}
 ];
 const contents=new Map();
 await preloadContents({getBlobsZip:()=>assert.fail('No regular blob requests'),getItemsBatch:()=>assert.fail('No regular blob requests')},'repo','project',invalid,contents);
 assert.equal(contents.size,0);
});

test('Rejected ZIP/metadata requests and invalid archives do not reject preloading or erase cached reads',async()=>{
 const record=blob('file.cs','class C {}');
 for(const failure of ['zip','metadata','archive']){
  const {client}=bulkClient([record]);
  if(failure==='metadata')client.getItemsBatch=async()=>{throw new Error('Metadata denied');};
  else client.getBlobsZip=async()=>{if(failure==='zip')throw new Error('Download denied');return Uint8Array.of(80,75,3).buffer;};
  const existing=Promise.resolve({content:'previous immutable read'}),contents=new Map([['already-read',existing]]);
  await preloadContents(client,'repo','project',[record.request],contents);
  assert.deepEqual([...contents],[['already-read',existing]],failure);
 }
});

test('One failed batch retains successful batches instead of suppressing every file',async()=>{
 const records=Array.from({length:257},(_,index)=>blob(`file-${index}.cs`,`class C${index} {}`));
 const byId=new Map(records.map(record=>[record.id,record]));
 const byPath=new Map(records.map(record=>[record.item.path,record]));
 const client={
  getBlobsZip:async ids=>{if(ids.length===256)throw new Error('One capped archive');return archive(Object.fromEntries(ids.map(id=>[id,byId.get(id).bytes])));},
  getItemsBatch:async({itemDescriptors})=>itemDescriptors.map(({path})=>[byPath.get(path).item])
 };
 const contents=new Map();
 await preloadContents(client,'repo','project',records.map(record=>record.request),contents);
 assert.deepEqual([...contents.keys()],[records[256].id]);
 assert.equal((await contents.get(records[256].id)).content,'class C256 {}');
});

test('A fast failure waits for its paired request before starting another batch or fallback',async()=>{
 const records=Array.from({length:1025},(_,index)=>blob(`file-${index}.cs`,`class C${index} {}`));
 let active=0,maxActive=0;
 const client={
  getBlobsZip:async()=>{throw new Error('Bulk download refused');},
  getItemsBatch:async()=>{active++;maxActive=Math.max(maxActive,active);try{await delay(15);return [];}finally{active--;}}
 };
 const contents=new Map();
 await preloadContents(client,'repo','project',records.map(record=>record.request),contents);
 assert.equal(maxActive,4);assert.equal(active,0);assert.equal(contents.size,0);
});

test('A 1340-file two-snapshot workload verifies all content with bounded batches and injected network latency',async t=>{
 const records=[];
 for(let index=0;index<1340;index++)for(const version of [base,source]){
  const sizes=[96,64,32,32,32,32,16,16,16,16,16,8,8,8,8,8,4,4,4,4];
  const size=sizes[index%sizes.length]*1024;
  const lines=Array.from({length:Math.ceil(size/100)},(_,line)=>` public string Field${line} = "record ${index}, snapshot ${version}, value ${index*7919+line*31}";\n`).join('');
  records.push(blob(`src/Area${index%37}/File${index}.cs`,lines.slice(0,size),{version}));
 }
 const bytes=records.reduce((sum,record)=>sum+record.bytes.length,0);
 assert.ok(bytes>48*1024*1024,'Exercise source-sized data, not thousands of tiny placeholder strings');
 const byId=new Map(records.map(record=>[record.id,record]));
 const byLocation=new Map(records.map(record=>[JSON.stringify([record.item.path,record.item.commitId]),record]));
 const calls={zip:[],metadata:[]},active={zip:0,metadata:0},max={zip:0,metadata:0};
 const network=async(kind,request,respond)=>{
  calls[kind].push(request);active[kind]++;max[kind]=Math.max(max[kind],active[kind]);
  try{await delay(25);return respond();}finally{active[kind]--;}
 };
 const client={
  getBlobsZip:(ids,repository,project)=>{
   assert.equal(repository,'repo');assert.equal(project,'project');
   return network('zip',ids,()=>archive(Object.fromEntries([...ids].reverse().map(id=>[id,byId.get(id).bytes]))));
  },
  getItemsBatch:(request,repository,project)=>{
   assert.equal(repository,'repo');assert.equal(project,'project');assert.equal(request.includeContentMetadata,true);
   return network('metadata',request.itemDescriptors,()=>[...request.itemDescriptors].reverse().map(item=>{
    assert.equal(item.versionType,2);assert.equal(item.recursionLevel,0);
    const record=byLocation.get(JSON.stringify([item.path,item.version]));
    assert.ok(record,'Metadata descriptors must preserve path and immutable commit');
    return [record.item];
   }));
  }
 };
 const contents=new Map();
 await preloadContents(client,'repo','project',records.map(record=>record.request),contents);
 assert.equal(byId.size,2680);assert.equal(contents.size,byId.size);
 const batches=Math.ceil(records.length/256);
 assert.equal(calls.zip.length,batches);assert.equal(calls.metadata.length,batches);
 assert.deepEqual(calls.zip.map(ids=>ids.length),[...Array(batches-1).fill(256),records.length%256]);
 assert.deepEqual(calls.metadata.map(items=>items.length),calls.zip.map(ids=>ids.length));
 assert.deepEqual(new Set(calls.zip.flat()),new Set(byId.keys()));
 assert.deepEqual(max,{zip:4,metadata:4},'Network calls overlap but never exceed four batches per API');
 assert.deepEqual(active,{zip:0,metadata:0});
 for(const record of records)assert.deepEqual(await contents.get(record.id),{content:record.bytes.toString(),contentMetadata:utf8},record.request.path+'@'+record.request.version);
 t.diagnostic(`1340 paths / 2680 distinct blobs / ${(bytes/1024/1024).toFixed(1)} MiB; 25 ms latency per bulk API call. This checks correctness and concurrency, not end-to-end browser timing.`);
});
