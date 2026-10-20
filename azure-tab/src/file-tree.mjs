export function buildFileTree(files,ranks) {
 const root={children:[],folders:new Map(),files:[]};
 for(const file of files){
  const parts=file.path.split('/');let parent=root,prefix='';
  for(const name of parts.slice(0,-1)){
   prefix=prefix?`${prefix}/${name}`:name;
   let folder=parent.folders.get(name);
   if(!folder){folder={kind:'folder',name,path:prefix,children:[],folders:new Map(),files:[]};parent.folders.set(name,folder);parent.children.push(folder);}
   folder.files.push(file);parent=folder;
  }
  parent.children.push({kind:'file',name:parts.at(-1),path:file.path,file});
 }
 const rank=node=>node.kind==='folder'?node.rank:ranks?.get(node.path)??Infinity;
 function sorted(node,depth){
  for(const child of node.children)if(child.kind==='folder'){
   child.children=sorted(child,depth+1);child.rank=child.children.reduce((value,item)=>Math.min(value,rank(item)),Infinity);
  }
  return node.children.sort((a,b)=>{
   const left=rank(a),right=rank(b);
   return (left===right?0:left<right?-1:1)||(a.kind===b.kind?0:a.kind==='folder'?-1:1)||a.name.localeCompare(b.name);
  }).map(child=>({...child,depth}));
 }
 return sorted(root,0);
}
export function flattenFileTree(nodes){return nodes.flatMap(node=>node.kind==='folder'?flattenFileTree(node.children):[node.file]);}
export function fileType(path){
 const name=path.split('/').at(-1).toLowerCase();
 if(name.endsWith('.cs'))return {type:'csharp',label:'C#',glyph:'C#'};
 if(/\.(csproj|fsproj|vbproj|sln|slnx|props|targets)$/.test(name))return {type:'project',label:'Project',glyph:'◇'};
 if(/\.(json|jsonc|ya?ml|toml|ini|config)$/.test(name)||name==='.editorconfig')return {type:'config',label:'Configuration',glyph:'{}'};
 if(/\.(xml|resx|xaml|svg)$/.test(name))return {type:'xml',label:'XML',glyph:'<>'};
 if(/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(name))return {type:'script',label:'JavaScript / TypeScript',glyph:'JS'};
 if(/\.(css|scss|sass|less)$/.test(name))return {type:'style',label:'Stylesheet',glyph:'#'};
 if(/\.(md|mdx|txt|rst)$/.test(name))return {type:'document',label:'Document',glyph:'≡'};
 if(/\.(png|jpe?g|gif|webp|ico|bmp)$/.test(name))return {type:'image',label:'Image',glyph:'▧'};
 if(/\.(ps1|sh|bat|cmd)$/.test(name))return {type:'shell',label:'Shell script',glyph:'>_'};
 if(name.endsWith('.sql'))return {type:'database',label:'SQL',glyph:'DB'};
 if(/\.(razor|cshtml|html?)$/.test(name))return {type:'markup',label:'Markup',glyph:'<>'};
 return {type:'file',label:'File',glyph:''};
}
export function icon(name){
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.classList.add('icon');
 const paths={folder:'M3 6h6l2 2h10v11H3Z',folderOpen:'M3 19V6h6l2 2h10v3M3 19l3-8h16l-3 8Z',chevron:'m9 5 7 7-7 7',refresh:'M20 7v5h-5M20 12a8 8 0 1 0-2 6',search:'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6',filter:'M3 5h18l-7 8v6l-4 2v-8Z',dependencies:'M9 3h6v6H9ZM3 15h6v6H3Zm12 0h6v6h-6ZM12 9v3M6 15v-3h12v3',check:'m5 12 4 4L19 6',close:'m6 6 12 12M18 6 6 18',previous:'m15 5-7 7 7 7',next:'m9 5 7 7-7 7',diagnostics:'M9 3h6v4H9ZM5 9h14v12H5ZM9 13h6M9 17h3',collapse:'m5 9 7-6 7 6M5 21l7-6 7 6',file:'M5 3h9l5 5v13H5ZM14 3v5h5'};
 const path=document.createElementNS(ns,'path');path.setAttribute('d',paths[name]||paths.file);path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.6');path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');svg.append(path);return svg;
}
export function fileIcon(path){
 const type=fileType(path),svg=icon('file');svg.classList.add('file-icon',`file-icon-${type.type}`);svg.dataset.fileType=type.type;
 if(type.glyph){const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('x','12');text.setAttribute('y','17');text.setAttribute('text-anchor','middle');text.setAttribute('fill','currentColor');text.setAttribute('font-size',type.glyph.length>1?'7':'10');text.setAttribute('font-weight','700');text.textContent=type.glyph;svg.append(text);}
 return svg;
}
