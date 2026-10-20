import {mapBounded} from './review.mjs';

// Small reviews need the entries in changed-file directories and their
// ancestors, not every descendant in the repository. These listings retain
// Unix modes and discover every applicable config/project on both snapshots.
export async function scopedTrees(client,repository,project,versions,files,loadCommit=version=>client.getCommit(version,repository,project,0),changes=[]){
 if(!client.getItemsBatch||files.length>10)return null;
 const directories=new Set(['']);
 for(const file of files)for(const path of [file.path,file.oldPath].filter(Boolean)){
  let directory=path.slice(0,path.lastIndexOf('/')+1);
  while(directory){directories.add(directory.slice(0,-1));directory=directory.slice(0,-1);directory=directory.slice(0,directory.lastIndexOf('/')+1);}
 }
 // Keep request fan-out bounded. Broad/deep reviews retain the bulk recursive
 // path, which is more efficient when most of the repository is relevant.
 versions=[...new Set(versions)];
 if(versions.length*directories.size>32)return null;
 try{
  const validId=id=>/^[a-f0-9]{40}$/i.test(id||'')&&!/^0+$/.test(id);
  const snapshots=new Map(versions.map(version=>[version,{entries:new Map(),complete:true}])),trees=new Map();
  const readTree=id=>{id=id.toLowerCase();if(!trees.has(id))trees.set(id,client.getTree(repository,id,project,undefined,false));return trees.get(id);};
  // Diff directory identities can warm these immutable reads in parallel.
  // They are hints only: the root walk below must confirm every parent link.
  const hints=new Set();
  for(const {item}of changes)if(item&&[2,'tree'].includes(item.gitObjectType)&&item.commitId===versions[1]&&directories.has(item.path?.replace(/^\//,'')))
   for(const id of [item.objectId,item.originalObjectId])if(validId(id))hints.add(id.toLowerCase());
  const warm=mapBounded([...hints].slice(0,versions.length*directories.size),async id=>{try{await readTree(id);}catch{/* Only a root-verified read can require fallback. */}},8);
  // Walk from verified commit roots. Directory object IDs are already in
  // their parent tree, so a separate ItemsBatch discovery gate is unnecessary.
  const roots=Promise.all(versions.map(async version=>{
   const commit=await loadCommit(version);
   if(commit.commitId!==version||!validId(commit.treeId))throw new Error('Commit snapshot mismatch');
   return {version,path:'',id:commit.treeId};
  }));
  // Finish warming before traversal starts further reads, retaining the same
  // global eight-request bound rather than multiplying concurrency by depth.
  let [pending]=await Promise.all([roots,warm]);
  while(pending.length){
   const children=[];
   await mapBounded(pending,async({version,path,id})=>{
    id=id.toLowerCase();
    const tree=await readTree(id),snapshot=snapshots.get(version);
    if(tree.truncated||!Array.isArray(tree.treeEntries))throw new Error('Incomplete directory entries');
    for(const entry of tree.treeEntries){
     if(!entry.relativePath||entry.relativePath.includes('/')||['.','..'].includes(entry.relativePath))throw new Error('Expected immediate directory entries');
     const child=(path?path+'/':'')+entry.relativePath;
     snapshot.entries.set(child,entry);
     if(directories.has(child)&&['040000','40000'].includes(String(entry.mode))){
      if(!validId(entry.objectId))throw new Error('Invalid directory identity');
      children.push({version,path:child,id:entry.objectId});
     }
    }
   },8);
   pending=children;
  }
  return snapshots;
 }catch{
  // Unsupported scoped traversal or inconsistent metadata must use the complete
  // immutable tree reader, never silently omit required context.
  return null;
 }
}
