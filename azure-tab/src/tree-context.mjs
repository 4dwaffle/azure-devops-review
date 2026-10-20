import {mapBounded} from './review.mjs';

// Small reviews need the entries in changed-file directories and their
// ancestors, not every descendant in the repository. These listings retain
// Unix modes and discover every applicable config/project on both snapshots.
export async function scopedTrees(client,repository,project,versions,files){
 if(!client.getItemsBatch||files.length>10)return null;
 const directories=new Set(['']);
 for(const file of files)for(const path of [file.path,file.oldPath].filter(Boolean)){
  let directory=path.slice(0,path.lastIndexOf('/')+1);
  while(directory){directories.add(directory.slice(0,-1));directory=directory.slice(0,-1);directory=directory.slice(0,directory.lastIndexOf('/')+1);}
 }
 // Keep request fan-out bounded. Broad/deep reviews retain the bulk recursive
 // path, which is more efficient when most of the repository is relevant.
 const descriptors=[...new Set(versions)].flatMap(version=>[...directories].map(directory=>({path:'/'+directory,version,versionType:2,recursionLevel:0})));
 if(descriptors.length>32)return null;
 try{
  const items=await client.getItemsBatch({itemDescriptors:descriptors},repository,project);
  if(!Array.isArray(items)||items.length!==descriptors.length)return null;
  const snapshots=new Map([...new Set(versions)].map(version=>[version,{entries:new Map(),complete:true}])),trees=new Map();
  await mapBounded(descriptors.map((descriptor,index)=>({descriptor,items:items[index]})),async({descriptor,items})=>{
   if(!Array.isArray(items)||items.length>1)throw new Error('Invalid directory response');
   const item=items[0];
   if(!item){if(descriptor.path==='/')throw new Error('Missing repository root');return;}
   if(item.path!==descriptor.path||item.commitId!==descriptor.version||!(/^[a-f0-9]{40}$/i.test(item.objectId||''))||/^0+$/.test(item.objectId))throw new Error('Directory snapshot mismatch');
   if(!item.isFolder||![2,'tree'].includes(item.gitObjectType))return;
   const id=item.objectId.toLowerCase();
   if(!trees.has(id))trees.set(id,client.getTree(repository,id,project,undefined,false));
   const tree=await trees.get(id),snapshot=snapshots.get(descriptor.version);
   if(!Array.isArray(tree.treeEntries))throw new Error('Missing directory entries');
   snapshot.complete &&= tree.truncated!==true;
   for(const entry of tree.treeEntries){
    if(!entry.relativePath||entry.relativePath.includes('/'))throw new Error('Expected immediate directory entries');
    snapshot.entries.set((descriptor.path==='/'?'':descriptor.path.slice(1)+'/')+entry.relativePath,entry);
   }
  },8);
  return snapshots;
 }catch{
  // Unsupported batch discovery or inconsistent metadata must use the complete
  // immutable tree reader, never silently omit required context.
  return null;
 }
}
