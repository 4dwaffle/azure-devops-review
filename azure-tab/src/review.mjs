export async function pagedDiff(fetchPage) {
 const changes=[];let skip=0,common;
 for(let page=0;page<1000;page++) {
  const result=await fetchPage(skip,100);
  if(!result.commonCommit) throw new Error('Azure did not return a merge base; refusing a two-tip diff.');
  if(common && common!==result.commonCommit) throw new Error('Merge base changed while paging.');
  common=result.commonCommit;
  const batch=result.changes||[];changes.push(...batch);
  if(result.allChangesIncluded===true) return {base:common,changes};
  if(!batch.length) throw new Error('Azure returned an incomplete diff page without changes.');
  skip+=batch.length;
 }
 throw new Error('Diff exceeds the supported 100,000-change limit; no partial review displayed.');
}
export function changedFiles(changes) {
 const files=new Map();
 for(const change of changes) {
  const item=change.item;
  if(!item||item.isFolder||item.gitObjectType===2||item.gitObjectType==='tree') continue;
  const path=item.path?.replace(/^\//,'');
  if(!path) throw new Error('Missing change path');
  const namedFlags={none:0,add:1,edit:2,encoding:4,rename:8,delete:16,undelete:32,branch:64,merge:128,lock:256,rollback:512,sourceRename:1024,targetRename:2048,property:4096,all:8191};
  const flags=typeof change.changeType==='string'&&!/^\d+$/.test(change.changeType)?change.changeType.split(',').reduce((value,name)=>{const flag=namedFlags[name.trim()];if(flag===undefined)throw new Error(`Unknown Azure change type: ${name}`);return value|flag;},0):Number(change.changeType);
  if(!Number.isSafeInteger(flags)||flags<0)throw new Error('Missing or invalid Azure change type');
  const oldPath=(change.originalPath||change.sourceServerItem)?.replace(/^\//,'');
  const status=flags&16?'D':flags&1?'A':flags&8?'R':'M';
  if(status==='R'&&!oldPath) throw new Error(`Azure omitted original rename path for ${path}`);
  if(files.has(path)) throw new Error(`Duplicate changed path ${path}`);
  files.set(path,{path,oldPath:status==='R'?oldPath:undefined,status,modeChanged:false});
 }
 return [...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
export async function mapBounded(items, read, concurrency=4) {
 let cursor=0;await Promise.all(Array.from({length:Math.min(items.length,concurrency)},async()=>{while(cursor<items.length){const item=items[cursor++];await read(item);}}));
}
export async function fingerprint(file) {
 const data=new TextEncoder().encode(JSON.stringify([file.path,file.oldPath,file.status,file.original,file.modified,file.binary,file.beforeMode,file.afterMode]));
 const hash=await crypto.subtle.digest('SHA-256',data);
 return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export class Progress {
 constructor(storage,key) {this.storage=storage;this.key=key;const text=storage.getItem(key);this.values=text?JSON.parse(text):{};if(!this.values||Array.isArray(this.values)||typeof this.values!=='object') throw new Error('Invalid saved progress');}
 viewed(file){return !!file.fingerprint&&this.values[file.path]===file.fingerprint;}
 mark(files,viewed){const next=Object.assign(Object.create(null),this.values);for(const file of files){if(!file.fingerprint) throw new Error(`File not loaded: ${file.path}`);if(viewed)next[file.path]=file.fingerprint;else delete next[file.path];}this.storage.setItem(this.key,JSON.stringify(next));this.values=next;}
}
export function totals(files,reasons,progress){const eligible=files.filter(file=>!reasons(file).length);return {viewed:eligible.filter(file=>progress.viewed(file)).length,total:eligible.length,ignored:files.length-eligible.length};}
