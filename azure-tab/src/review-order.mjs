// PR descriptions are data. Prose never expands into inferred groups or globs.
export function reviewOrderPaths(description='') {
 const paths=[],seen=new Set();let level=0,fence;
 for(const line of String(description??'').split(/\r?\n/)){
  const marker=line.match(/^\s*(`{3,}|~{3,})/);
  if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;continue;}
  if(fence)continue;
  const heading=line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if(heading){
   if(level&&heading[1].length<=level)level=0;
   if(/^review[\s_-]*order$/i.test(heading[2]))level=heading[1].length;
   continue;
  }
  if(!level||!/^\s*(?:\d+[.)]|[-+*])\s+/.test(line))continue;
  const item=line.replace(/^\s*(?:\d+[.)]|[-+*])\s+/, '').split(/\s+[—–-]\s+/)[0];
  // Keep code spans and link labels intact, including paths with spaces.
  for(const match of item.matchAll(/`+([^`]+)`+|\[([^\]]+)\]\([^)]*\)|([^\s,;`]+)/g)){
   const raw=match[1]??match[2]??match[3];
   const path=raw.replaceAll('\\','/').replace(/^(?:\.\/|\/)+/,'').replace(/[.,;:]$/,'');
   if(!path||seen.has(path))continue;
   // Bare prose words, URLs and glob patterns are not file references.
   if((!match[1]&&!match[2]&&!/(?:\/|\.[\w-]+$)/.test(path))||/[:*?<>|]/.test(path))continue;
   seen.add(path);paths.push(path);
  }
 }
 return paths;
}
export function resolveReviewOrder(files,description) {
 const ordered=[],used=new Set(),unmatched=[];
 for(const path of reviewOrderPaths(description)){
  // Prefer a current exact path. Short paths and rename origins must be unique.
  const exact=files.find(file=>file.path===path);
  const matches=exact?[exact]:files.filter(file=>[file.path,file.oldPath].some(value=>value===path||value?.endsWith('/'+path)));
  if(matches.length!==1){unmatched.push(path);continue;}
  const file=matches[0];if(!used.has(file)){used.add(file);ordered.push(file);}
 }
 const matched=ordered.length;
 ordered.push(...files.filter(file=>!used.has(file)).sort((a,b)=>a.path.localeCompare(b.path)));
 return {files:ordered,matched,unmatched};
}
