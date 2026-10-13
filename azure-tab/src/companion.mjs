export function companionUrl(value){
 if(!value)return '';
 const url=new URL(value.trim());
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||!/^\/[a-f0-9]{64}\/verify$/.test(url.pathname))throw new Error('Use the private 127.0.0.1 capability URL printed by the local compiler companion.');
 return url.href;
}
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('');
export async function verifyWithCompanion(url,snapshot,files,classifications,fetcher=fetch){
 if(!url)return {results:[],summary:''};
 try{
  const endpoint=companionUrl(url);const request={version:1,repositoryId:snapshot.repositoryId,base:snapshot.base,source:snapshot.source,files:await Promise.all(files.filter(file=>/\.cs$/i.test(file.path)&&!file.binary&&!file.error&&!file.modeChanged&&typeof file.original==='string'&&typeof file.modified==='string').map(async file=>({path:file.path,oldPath:file.oldPath||file.path,originalHash:await hash(file.original),modifiedHash:await hash(file.modified)})))};
  const response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:AbortSignal.timeout(35000)});
  if(!response.ok)throw new Error('Unavailable');const data=await response.json();
  if(data.version!==1||data.repositoryId!==request.repositoryId||data.base!==request.base||data.source!==request.source||data.contextValid!==true||!Array.isArray(data.results)||data.results.length>request.files.length)throw new Error('Unverified context');
  const identities=new Map(request.files.map(file=>[file.path,file])),classes=new Map(classifications.map(value=>[value.path,value])),seen=new Set();
  const results=data.results.map(value=>{const expected=identities.get(value.path);if(!expected||seen.has(value.path)||!classes.get(value.path)?.renameOnly||value.oldPath!==expected.oldPath||value.originalHash!==expected.originalHash||value.modifiedHash!==expected.modifiedHash||value.renameOnly!==true||value.semanticVerified!==true)throw new Error('Stale or unsupported result');seen.add(value.path);return {path:value.path,renameOnly:true,semanticVerified:true,semanticReason:'Local Roslyn verified reference bindings with the explicitly configured compiler profile'};});
  return {results,summary:`Local compiler verified ${results.length} additional rename candidates with the trusted profile.`};
 }catch{return {results:[],summary:'Local compiler unavailable or its context/snapshot could not be verified. Browser verification remains active; unknown changes stay visible.'};}
}
