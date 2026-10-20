import {unzipSync} from 'fflate';
import {mapBounded} from './review.mjs';

const blobId=value=>/^[a-f0-9]{40}$/i.test(value||'')&&!/^0+$/.test(value);
// Only decode encodings whose browser and .NET representations agree. Azure's
// item reader remains authoritative for legacy encodings and malformed text.
export function decodeContent(bytes,metadata){
 if(!metadata||metadata.encoding===undefined)throw new Error('Missing content metadata');
 if(metadata.isBinary)return {contentMetadata:metadata};
 // Azure can label BOM-less UTF-8 as 1252 while its JSON item reader still
 // returns Unicode. Only its ASCII subset has unambiguous decoding parity.
 if(metadata.encoding!==65001&&(metadata.encoding!==1252||bytes.some(byte=>byte>127)))throw new Error('Content requires Azure encoding conversion');
 if(bytes.includes(0))throw new Error('Content requires Azure text conversion');
 return {content:new TextDecoder('utf-8',{fatal:true}).decode(bytes),contentMetadata:metadata};
}

// Populate the same per-snapshot promise cache used by individual item reads.
// A rejected/capped archive, missing blob or unsupported encoding falls back to
// the immutable item endpoint, so optimization cannot suppress read errors.
export async function preloadContents(client,repository,project,requests,contents){
 if(!client.getBlobsZip||!client.getItemsBatch)return;
 const unique=new Map();
 for(const request of requests){const id=request.entry?.objectId;if(blobId(id)&&['100644','100755'].includes(String(request.entry.mode)))unique.set(id.toLowerCase(),request);}
 const entries=[...unique];
 const batches=[];for(let i=0;i<entries.length;i+=256)batches.push(entries.slice(i,i+256));
 await mapBounded(batches,async batch=>{
  try{
   const results=await Promise.allSettled([
    client.getBlobsZip(batch.map(([id])=>id),repository,project),
    client.getItemsBatch({includeContentMetadata:true,itemDescriptors:batch.map(([,request])=>({path:'/'+request.path,version:request.version,versionType:2,recursionLevel:0}))},repository,project)
   ]);
   if(results.some(result=>result.status==='rejected'))return;
   const [archive,metadata]=results.map(result=>result.value);
   const wanted=new Set(batch.map(([id])=>id));
   const blobs=unzipSync(new Uint8Array(archive),{filter:entry=>wanted.has(entry.name)&&entry.originalSize<=32*1024*1024});
   const byLocation=new Map(metadata.flat().map(item=>[JSON.stringify([item.path,item.commitId]),item]));
   await mapBounded(batch,async([id,request])=>{
    try{
     const item=byLocation.get(JSON.stringify(['/'+request.path,request.version]));
     const bytes=blobs[id];if(item?.objectId?.toLowerCase()!==id||!bytes) return;
     // Verify raw Git identity before decoding, independent of archive ordering.
     const header=new TextEncoder().encode(`blob ${bytes.length}\0`),data=new Uint8Array(header.length+bytes.length);data.set(header);data.set(bytes,header.length);
     const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',data)),byte=>byte.toString(16).padStart(2,'0')).join('');
     if(hash!==id)return;
     contents.set(id,Promise.resolve(decodeContent(bytes,item.contentMetadata)));
    }catch{/* Individual immutable read preserves Azure's conversion/errors. */}
   },8);
  }catch{/* Keep all files and use the existing bounded item reader. */}
 },4);
}
