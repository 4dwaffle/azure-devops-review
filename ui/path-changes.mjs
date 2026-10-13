export function pathChange(file) {
 if(!file.status?.startsWith('R')||!file.oldPath||file.oldPath===file.path)return null;
 const split=path=>{const index=path.lastIndexOf('/');return {directory:path.slice(0,index+1),name:path.slice(index+1)};};
 const before=split(file.oldPath),after=split(file.path);
 const moved=before.directory!==after.directory,renamed=before.name!==after.name;
 return {label:moved&&renamed?'Moved + renamed':moved?'Moved':'Renamed',paths:`${file.oldPath} → ${file.path}`};
}
