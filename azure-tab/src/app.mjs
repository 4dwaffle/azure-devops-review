import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import {defaultFilters,normalizeFilters,ignoredReasons} from '../../analysis.mjs';
import {renderDependencyDiagrams} from '../../ui/dependencies.mjs';
import {Progress,totals} from './review.mjs';
import {buildFileTree,icon,fileIcon} from './file-tree.mjs';
import {initializeSidebar} from './sidebar.mjs';
const $=id=>document.getElementById(id);
globalThis.MonacoEnvironment={getWorker:()=>new Worker(new URL('./editor.worker.js',import.meta.url),{type:'module'})};
export async function start(connection,loadReview){
 let analysisTimeout,review,progress,active,editor,models=[],classification=new Map(),graph,analysisWorker,generation=0,selection=new Set(),filters=normalizeFilters(JSON.parse(localStorage.getItem('azure-filtered-review:filters')||JSON.stringify(defaultFilters)));
 const collapsed=new Set();
 initializeSidebar(document.querySelector('main'),$('sidebar-resizer'),localStorage);
 let sideBySide=localStorage.getItem('azure-filtered-review:diff-layout')!=='inline';
 $('diff-layout').value=sideBySide?'side-by-side':'inline';
 $('diff-layout').onchange=()=>{sideBySide=$('diff-layout').value==='side-by-side';editor?.updateOptions({renderSideBySide:sideBySide});try{localStorage.setItem('azure-filtered-review:diff-layout',sideBySide?'side-by-side':'inline');}catch{}};
 for(const element of document.querySelectorAll('[data-icon]'))element.prepend(icon(element.dataset.icon));
 const notice=text=>$('notice').textContent=text;
 const safe=handler=>async(...args)=>{try {await handler(...args);}catch(error){notice(String(error.message||error));}};
 function reasons(file){return file.error||file.modeChanged?[]:ignoredReasons(file,filters,classification.get(file.path));}
 function visible(){const query=$('search').value.toLowerCase();return review?.files.filter(file=>(filters.showIgnored||!reasons(file).length)&&file.path.toLowerCase().includes(query))||[];}
 function persistFilters(){localStorage.setItem('azure-filtered-review:filters',JSON.stringify(filters));render();}
 function render(){
  if(!review)return;const counts=totals(review.files,reasons,progress);$('progress').textContent=`${counts.viewed} / ${counts.total}${counts.ignored?` · ${counts.ignored} ignored`:''}`;
  const listed=visible(),listedPaths=new Set(listed.map(file=>file.path));selection=new Set([...selection].filter(path=>listedPaths.has(path)));$('selected').textContent=`${selection.size} selected`;
  $('bulk-actions').hidden=!selection.size;$('listed-count').textContent=listed.length;$('review-meter').max=Math.max(1,counts.total);$('review-meter').value=counts.viewed;
  const focused=document.activeElement?.closest('[data-focus]')?.dataset.focus,scroll=$('files').scrollTop;
  const rows=document.createDocumentFragment();
  function append(nodes){for(const node of nodes){
   if(node.kind==='folder'){
    const expanded=!!$('search').value||!collapsed.has(node.path),heading=document.createElement('div');heading.className='folder-heading';heading.style.setProperty('--depth',node.depth);heading.dataset.path=node.path;
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.focus=`folder-select:${node.path}`;checkbox.setAttribute('aria-label',`Select folder ${node.path}`);checkbox.checked=node.files.every(file=>selection.has(file.path));checkbox.indeterminate=!checkbox.checked&&node.files.some(file=>selection.has(file.path));checkbox.onchange=()=>{for(const file of node.files)checkbox.checked?selection.add(file.path):selection.delete(file.path);render();};
    const toggle=document.createElement('button');toggle.className='folder-toggle';toggle.dataset.focus=`folder-toggle:${node.path}`;toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-label',`${expanded?'Collapse':'Expand'} folder ${node.path}`);toggle.title=node.path;toggle.onclick=()=>{expanded?collapsed.add(node.path):collapsed.delete(node.path);render();};const chevron=icon('chevron');chevron.classList.add('chevron');const folder=icon(expanded?'folderOpen':'folder');folder.classList.add('folder-icon');const name=document.createElement('span');name.className='folder-name';name.textContent=node.name;const count=document.createElement('span');count.className='folder-count';count.textContent=node.files.length;toggle.append(chevron,folder,name,count);heading.append(checkbox,toggle);rows.append(heading);if(expanded)append(node.children);
   }else{
    const file=node.file,row=document.createElement('div');row.className=`file-row${file.path===active?.path?' active':''}${reasons(file).length?' ignored':''}`;row.style.setProperty('--depth',node.depth);row.dataset.path=file.path;
    const selected=document.createElement('input');selected.type='checkbox';selected.dataset.focus=`file-select:${file.path}`;selected.checked=selection.has(file.path);selected.setAttribute('aria-label',`Select ${file.path}`);selected.onchange=()=>{selected.checked?selection.add(file.path):selection.delete(file.path);render();};
    const button=document.createElement('button');button.dataset.focus=`file-open:${file.path}`;button.setAttribute('aria-label',`Open ${file.path}${progress.viewed(file)?', viewed':''}`);button.setAttribute('aria-current',String(file.path===active?.path));const name=document.createElement('span');name.className='file-name';name.textContent=node.name;button.append(fileIcon(file.path),name);button.title=[file.path,...reasons(file),classification.get(file.path)?.semanticReason,file.error||''].filter(Boolean).join('\n');button.onclick=safe(()=>open(file));
    if(progress.viewed(file)){const check=icon('check');check.classList.add('viewed-indicator');check.setAttribute('aria-label','Viewed');row.append(check);}
    const status=document.createElement('small');status.textContent=file.error?'!':file.status;status.dataset.status=file.error?'error':file.status;status.title=file.error||`Change: ${file.status}`;row.prepend(selected,button);row.append(status);rows.append(row);
   }
  }}
  append(buildFileTree(listed));if(!listed.length){const empty=document.createElement('p');empty.className='tree-empty';empty.textContent='No files match your search and review filters.';rows.append(empty);}$('files').replaceChildren(rows);$('files').scrollTop=scroll;
  if(focused){const element=[...$('files').querySelectorAll('[data-focus]')].find(element=>element.dataset.focus===focused);element?.focus({preventScroll:true});}
  if(active&&!listedPaths.has(active.path)){if(listed.length)open(listed[0]);else clearEditor();}
  $('viewed').checked=active?progress.viewed(active):false;
 }
 function clearEditor(){editor?.setModel(null);for(const model of models){model.dispose();}models=[];active=null;$('current-icon').replaceChildren();$('current-file').textContent='Choose a file';$('viewed').disabled=true;$('threads').replaceChildren();}
 function theme(){const style=getComputedStyle(document.body);const rgb=style.backgroundColor.match(/\d+/g)?.slice(0,3).map(Number)||[255,255,255];const background='#'+rgb.map(value=>value.toString(16).padStart(2,'0')).join('');const dark=rgb.reduce((sum,value)=>sum+value,0)<384;monaco.editor.defineTheme('azure-review',{base:dark?'vs-dark':'vs',inherit:true,rules:[],colors:{'editor.background':background,'editorGutter.background':background,'diffEditor.unchangedRegionBackground':background}});monaco.editor.setTheme('azure-review');}
 window.addEventListener('themeApplied',theme);
 function open(file){clearEditor();active=file;const parts=file.path.split('/');for(let i=1;i<parts.length;i++)collapsed.delete(parts.slice(0,i).join('/'));$('current-icon').replaceChildren(fileIcon(file.path));$('current-file').textContent=file.path;$('viewed').disabled=!file.fingerprint;$('viewed').checked=progress.viewed(file);
  if(!editor){theme();editor=monaco.editor.createDiffEditor($('editor'),{readOnly:true,originalEditable:false,automaticLayout:true,renderSideBySide:sideBySide,useInlineViewWhenSpaceIsLimited:false,minimap:{enabled:false},scrollBeyondLastLine:false});new MutationObserver(theme).observe(document.documentElement,{attributes:true,attributeFilter:['style','class']});}
  const language=file.path.endsWith('.cs')?'csharp':/\.(json|jsonc)$/.test(file.path)?'json':/\.(csproj|props|targets|xml|resx)$/.test(file.path)?'xml':undefined;
  const before=file.error?file.error:file.binary?'Binary or non-regular Git object — use Azure native Files to inspect.':file.original;const after=file.error?file.error:file.binary?'Binary or non-regular Git object — use Azure native Files to inspect.':file.modified;
  models=[monaco.editor.createModel(before,language),monaco.editor.createModel(after,language)];editor.setModel({original:models[0],modified:models[1]});
  const navigateDiff=direction=>{const lines=(editor.getLineChanges()||[]).map(change=>Math.max(1,change.modifiedStartLineNumber));const modified=editor.getModifiedEditor(),line=modified.getPosition()?.lineNumber||0;const next=direction>0?lines.find(value=>value>line)??lines[0]:lines.toReversed().find(value=>value<line)??lines.at(-1);if(next){modified.setPosition({lineNumber:next,column:1});modified.revealLineInCenter(next);}};$('previous-diff').onclick=()=>navigateDiff(-1);$('next-diff').onclick=()=>navigateDiff(1);
  $('threads').replaceChildren();
  for(const thread of review.threads.filter(thread=>!thread.isDeleted&&(!thread.threadContext?.filePath||thread.threadContext.filePath.replace(/^\//,'')===file.path))){
   const comments=(thread.comments||[]).filter(comment=>!comment.isDeleted&&!['3','system'].includes(String(comment.commentType).toLowerCase()));
   if(!comments.length)continue;
   const article=document.createElement('article'),coordinates=thread.pullRequestThreadContext?.iterationContext;
   article.title=coordinates?.secondComparingIteration===review.latestIteration?'Current source/target iteration':'Historical or unverified iteration';
   for(const comment of comments){const p=document.createElement('p');p.textContent=`${comment.author?.displayName||'Unknown'}: ${comment.content||''}`;article.append(p);}
   $('threads').append(article);
  }
  render();
 }
 for(const [key,label] of Object.entries({resources:'Resource files',formatting:'Formatting only',usings:'Using directives only',renames:'Repeated rename references',generated:'Generated code',designers:'Designer files',migrations:'Migrations'})){const element=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=filters[key];checkbox.onchange=safe(()=>{filters={...filters,[key]:checkbox.checked};persistFilters();});element.append(checkbox,document.createTextNode(label));$('filter-options').append(element);}
 $('patterns').value=filters.patterns.join('\n');$('show-ignored').checked=filters.showIgnored;$('show-ignored').onchange=safe(()=>{filters={...filters,showIgnored:$('show-ignored').checked};persistFilters();});$('apply-patterns').onclick=safe(()=>{filters=normalizeFilters({...filters,patterns:$('patterns').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)});persistFilters();});$('search').oninput=render;
 $('close-filters').onclick=()=>$('filters').open=false;
 document.addEventListener('click',event=>{if(!event.target.closest('#filters'))$('filters').open=false;});
 document.addEventListener('keydown',event=>{if(event.key==='Escape')$('filters').open=false;});
 $('collapse-folders').onclick=()=>{function collapse(nodes){for(const node of nodes)if(node.kind==='folder'){collapsed.add(node.path);collapse(node.children);}}collapse(buildFileTree(visible()));render();};
 $('select-visible').onclick=()=>{selection=new Set(visible().map(file=>file.path));render();};$('clear-selection').onclick=()=>{selection.clear();render();};const mark=value=>safe(()=>{progress.mark(review.files.filter(file=>selection.has(file.path)),value);render();});$('mark-reviewed').onclick=mark(true);$('mark-unreviewed').onclick=mark(false);$('viewed').onchange=safe(()=>{progress.mark([active],$('viewed').checked);render();});
 const step=direction=>{const list=visible();if(list.length)open(list[(Math.max(0,list.indexOf(active))+direction+list.length)%list.length]);};$('previous').onclick=()=>step(-1);$('next').onclick=()=>step(1);
 document.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key.toLowerCase()==='p'){event.preventDefault();$('search').focus();return;}if(['INPUT','TEXTAREA'].includes(event.target.tagName)||event.target.closest('.monaco-editor'))return;if(event.key.toLowerCase()==='j')step(1);if(event.key.toLowerCase()==='k')step(-1);if(event.key.toLowerCase()==='v'&&active?.fingerprint){event.preventDefault();safe(()=>{progress.mark([active],!progress.viewed(active));render();})();}});
 $('dependencies').onclick=()=>{if(graph)renderDependencyDiagrams($('dependency-content'),graph,false,path=>{const file=review.files.find(file=>file.path===path);if(file){$('dependency-dialog').close();$('search').value='';if(reasons(file).length){filters={...filters,showIgnored:true};$('show-ignored').checked=true;persistFilters();}open(file);}});else $('dependency-content').textContent='Dependency analysis is still loading.';$('dependency-dialog').showModal();};$('close-dependencies').onclick=()=>$('dependency-dialog').close();
 async function load(id){const snapshot=++generation;clearTimeout(analysisTimeout);analysisWorker?.terminate();clearEditor();review=null;graph=null;classification.clear();selection.clear();$('bulk-actions').hidden=true;$('listed-count').textContent='';$('review-meter').value=0;$('files').replaceChildren();$('progress').textContent='Loading…';notice('Loading immutable merge-base snapshot…');let loaded;try{loaded=await loadReview(connection,id);}catch(error){if(snapshot!==generation)return;throw error;}if(snapshot!==generation)return;review=loaded;progress=new Progress(localStorage,`azure-filtered-review:${connection.organization}:${connection.user}:${review.repository}:${id}`);$('reload').title=`Reload snapshot (merge-base ${review.base.slice(0,8)} → source ${review.source.slice(0,8)})`;render();if(visible().length)open(visible()[0]);notice(review.threadError||'Read-only Azure tab. Progress is local to this browser. Analyzing ignore candidates…');analysisWorker=new Worker(new URL('./analysis-worker.js',import.meta.url),{type:'module'});analysisWorker.onerror=()=>notice('Ignore analysis failed; files stay visible.');analysisWorker.onmessage=({data})=>{if(snapshot!==generation)return;if(!data.semanticPending)clearTimeout(analysisTimeout);if(data.error){notice(data.error);return;}classification=new Map(data.classifications.map(value=>[value.path,value]));graph=data.dependencies;render();notice([review.threadError,data.semanticPending?'Automatically verifying C# ignore candidates with browser-local Roslyn…':data.semanticSummary,data.configUnknown?'EditorConfig generated_code settings could not be resolved safely: generated candidates kept visible.':'',`${review.files.length} immutable changed files loaded. Local progress; Azure comments are read-only.`].filter(Boolean).join('\n'));};analysisTimeout=setTimeout(()=>{if(snapshot===generation){analysisWorker.terminate();notice('Roslyn verification timed out; unverified changes stay visible.');}},60000);analysisWorker.postMessage({files:review.files,configurations:review.configurations});}
 $('context').hidden=!!connection.pullRequestId;$('pr-id').value=connection.pullRequestId||'';$('context').onsubmit=event=>{event.preventDefault();const id=Number($('pr-id').value);if(Number.isSafeInteger(id)&&id>0)safe(()=>load(id))();};$('reload').onclick=safe(()=>load(connection.pullRequestId||Number($('pr-id').value)));if(connection.pullRequestId)await load(connection.pullRequestId);else notice('Enter the PR ID above; automatic PR context is not available in this host.');
 return {load};
}
