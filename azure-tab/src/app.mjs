import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import {defaultFilters,normalizeFilters,ignoredReasons} from '../../analysis.mjs';
import {renderDependencyDiagrams} from '../../ui/dependencies.mjs';
import {Progress,totals} from './review.mjs';
import {pathChange} from '../../ui/path-changes.mjs';
import {companionUrl} from './companion.mjs';
import {buildFileTree,icon,fileIcon} from './file-tree.mjs';
import {initializeSidebar} from './sidebar.mjs';
import {createCommentDraft,publishComment,reconcileComment,restoreCommentDraft,validatePosition} from './comments.mjs';
const $=id=>document.getElementById(id);
globalThis.MonacoEnvironment={getWorker:()=>new Worker(new URL('./editor.worker.js',import.meta.url),{type:'module'})};
export async function start(connection,loadReview){
 let filterWarning='';
 function readFilters(){
  let saved;
  try{saved=JSON.parse(localStorage.getItem('azure-filtered-review:filters')||JSON.stringify(defaultFilters));return normalizeFilters(saved);}
  catch(error){filterWarning='Saved custom ignore patterns disabled: '+(error.message||error);try{return normalizeFilters({...saved,patterns:[]});}catch{return normalizeFilters();}}
 }
 let analysisTimeout,review,progress,active,editor,models=[],classification=new Map(),graph,analysisWorker,generation=0,filters=readFilters();
 let compilerUrl='';try{compilerUrl=companionUrl(localStorage.getItem('azure-filtered-review:compiler-url')||'');}catch{}
 $('compiler-url').value=compilerUrl;
 const collapsed=new Set(),paneActions=[];
 initializeSidebar(document.querySelector('main'),$('sidebar-resizer'),localStorage);
 let sideBySide=localStorage.getItem('azure-filtered-review:diff-layout')!=='inline';
 $('diff-layout').value=sideBySide?'side-by-side':'inline';
 $('diff-layout').onchange=()=>{sideBySide=$('diff-layout').value==='side-by-side';editor?.updateOptions({renderSideBySide:sideBySide});try{localStorage.setItem('azure-filtered-review:diff-layout',sideBySide?'side-by-side':'inline');}catch{}};
 for(const element of document.querySelectorAll('[data-icon]'))element.prepend(icon(element.dataset.icon));
 const notice=text=>$('notice').textContent=text;
 const safe=handler=>async(...args)=>{try {await handler(...args);}catch(error){notice(String(error.message||error));}};
 $('apply-compiler').onclick=safe(async()=>{const value=companionUrl($('compiler-url').value);if(value)localStorage.setItem('azure-filtered-review:compiler-url',value);else localStorage.removeItem('azure-filtered-review:compiler-url');compilerUrl=value;$('compiler-url').value=value;if(review)await load(review.pr.pullRequestId);else notice(value?'Local compiler configured. Open a matching PR snapshot to verify.':'Local compiler disabled. Browser-only verification remains active.');});
 let draft,draftKey,draftError,lastSide='right',publishing=false;
 const saveDraft=value=>{
  const stored=restoreCommentDraft(localStorage.getItem(draftKey));
  if(stored&&stored.id!==value.id&&stored.state!=='published'||stored&&stored.id===value.id&&value.state==='draft'&&stored.state!=='draft'&&!publishing)throw new Error('This draft was changed or submitted in another tab. Reload before continuing.');
  localStorage.setItem(draftKey,JSON.stringify(value));draft=value;
 };
 const locked=async handler=>{if(!navigator.locks)throw new Error('Comment drafts require browser Web Locks for cross-tab safety.');return navigator.locks.request(draftKey,handler);};
 function savedDraft(){const stored=restoreCommentDraft(localStorage.getItem(draftKey));if(!stored||stored.id!==draft?.id||stored.state!==draft.state)throw new Error('This draft changed in another tab. Reload before continuing.');return stored;}
 function renderComposer(){
  $('comment-composer').hidden=!draft;
  if(!draft)return;
  const stale=!review||draft.source!==review.source||draft.target!==review.target||draft.base!==review.base||draft.iteration!==review.latestIteration;
  $('comment-range').textContent=`${draft.path} · ${draft.side==='left'?'Original':'Modified'} · lines ${draft.startLine}–${draft.endLine}`;
  $('comment-text').value=draft.content;$('comment-text').disabled=publishing||draft.state!=='draft';
  $('publish-comment').disabled=publishing||stale||draft.state!=='draft'||!navigator.locks;
  $('cancel-comment').disabled=publishing||['publishing','uncertain'].includes(draft.state);
  for(const id of ['reconcile-comment','archive-comment']){$(id).hidden=draft.state!=='uncertain';$(id).disabled=publishing||!navigator.locks;}
  $('comment-status').textContent=publishing?'Publishing…':stale?'Older snapshot: reload and re-review this range.':draft.state==='published'?`Published as thread ${draft.threadId}.`:['publishing','uncertain'].includes(draft.state)?'Outcome uncertain. Check native Files; retries are blocked.':!navigator.locks?'Publishing requires browser Web Locks to prevent duplicate submissions.':'Draft saved locally. Publishing adds an Azure PR thread.';
 }
 async function compose(side=lastSide){
  if(draftError)throw new Error(draftError);
  if(publishing)throw new Error('Wait for the current comment publication.');
  if(draft&&draft.state!=='published')throw new Error('Publish or discard the existing draft first; uncertain writes must be checked in native Files.');
  const pane=side==='left'?editor.getOriginalEditor():editor.getModifiedEditor();
  const value=createCommentDraft(review,active,side,pane.getModel(),pane.getSelection());await locked(()=>saveDraft(value));renderComposer();$('comment-text').focus();
 }
 $('add-comment').onclick=safe(()=>compose());
 $('comment-text').oninput=safe(async()=>{if(draft?.state==='draft'&&!publishing){const value={...draft,content:$('comment-text').value};await locked(()=>saveDraft(value));}});
 window.addEventListener('storage',event=>{if(event.key===draftKey&&!publishing){try{draft=restoreCommentDraft(event.newValue);draftError=null;}catch(error){draftError=error.message;notice(draftError);}renderComposer();}});
 $('cancel-comment').onclick=safe(()=>locked(()=>{const stored=savedDraft();if(publishing||['publishing','uncertain'].includes(stored.state))throw new Error('Check the uncertain write in native Files before continuing.');localStorage.removeItem(draftKey);draft=null;renderComposer();}));
 $('reconcile-comment').onclick=safe(async()=>{if(publishing)return;publishing=true;renderComposer();try{await locked(async()=>{draft=savedDraft();const thread=await reconcileComment(connection,draft,saveDraft);if(!review.threads.some(value=>value.id===thread.id))review.threads.push(thread);if(active)open(active);notice('Matching published thread found. No comment was posted again.');});}finally{publishing=false;renderComposer();}});
 $('archive-comment').onclick=safe(async()=>{if(publishing||!confirm('Have you checked the native Files tab for this comment? Archiving does not cancel a request or prove it failed. Do not post a duplicate. The uncertain draft is retained locally.'))return;await locked(()=>{const stored=savedDraft();if(stored.state!=='uncertain')throw new Error('Only uncertain drafts can be archived here.');const key=draftKey+':history',history=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(history))throw new Error('Invalid archive; the draft has been preserved.');if(!history.some(value=>value.id===stored.id))history.push(stored);localStorage.setItem(key,JSON.stringify(history));localStorage.removeItem(draftKey);draft=null;renderComposer();notice('Uncertain draft archived locally. Nothing was retried.');});});
 $('comment-composer').onsubmit=event=>{event.preventDefault();safe(async()=>{
  if(publishing||!navigator.locks)return;publishing=true;renderComposer();
  try {await navigator.locks.request(draftKey,async()=>{
   const saved=JSON.parse(localStorage.getItem(draftKey)||'null');if(!saved||saved.id!==draft?.id||saved.state!=='draft')throw new Error('This draft was changed or submitted in another tab. Reload before continuing.');
   draft=saved;const thread=await publishComment(connection,review,draft,saveDraft);review.threads.push(thread);if(active)open(active);notice('Comment published to the verified current PR iteration.');
  });}finally{publishing=false;renderComposer();}
 })();};
 function reasons(file){return file.error||file.modeChanged?[]:ignoredReasons(file,filters,classification.get(file.path));}
 function visible(){const query=$('search').value.toLowerCase();return review?.files.filter(file=>(filters.showIgnored||!reasons(file).length)&&[file.path,file.oldPath].some(path=>path?.toLowerCase().includes(query)))||[];}
 function persistFilters(){localStorage.setItem('azure-filtered-review:filters',JSON.stringify(filters));render();}
 function render(){
  if(!review)return;const candidates=review.files.filter(file=>classification.get(file.path)?.namespaceTextOnly&&!file.error&&!file.binary&&!file.modeChanged).length;$('namespace-hint').hidden=filters.namespaceRenames||!candidates;$('namespace-hint-text').textContent=`${candidates} namespace-only candidates remain visible. Text-only filtering is off; this is not compiler proof.`;const counts=totals(review.files,reasons,progress);$('progress').textContent=`${counts.viewed} / ${counts.total}${counts.ignored?` · ${counts.ignored} ignored`:''}`;
  const listed=visible(),listedPaths=new Set(listed.map(file=>file.path));
  $('listed-count').textContent=listed.length;$('review-meter').max=Math.max(1,counts.total);$('review-meter').value=counts.viewed;
  const focused=document.activeElement?.closest('[data-focus]')?.dataset.focus,scroll=$('files').scrollTop;
  const rows=document.createDocumentFragment();
  function append(nodes){for(const node of nodes){
   if(node.kind==='folder'){
    const expanded=!!$('search').value||!collapsed.has(node.path),heading=document.createElement('div');heading.className='folder-heading';heading.style.setProperty('--depth',node.depth);heading.dataset.path=node.path;
    const descendants=review.files.filter(file=>file.path.startsWith(`${node.path}/`)&&!reasons(file).length),reviewedCount=descendants.filter(file=>progress.viewed(file)).length;
    const reviewed=document.createElement('input');reviewed.type='checkbox';reviewed.className='reviewed-checkbox folder-reviewed';reviewed.dataset.focus=`folder-reviewed:${node.path}`;reviewed.checked=descendants.length>0&&reviewedCount===descendants.length;reviewed.indeterminate=reviewedCount>0&&reviewedCount<descendants.length;reviewed.disabled=!descendants.length||descendants.some(file=>!file.fingerprint);reviewed.setAttribute('aria-label',`Reviewed folder ${node.path}`);reviewed.title='Mark all non-ignored files in this folder reviewed, including collapsed and search-hidden files';reviewed.onchange=safe(()=>{try{progress.mark(descendants,reviewed.checked);}finally{render();}});heading.append(reviewed);
    const toggle=document.createElement('button');toggle.className='folder-toggle';toggle.dataset.focus=`folder-toggle:${node.path}`;toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-label',`${expanded?'Collapse':'Expand'} folder ${node.path}`);toggle.title=node.path;toggle.onclick=()=>{expanded?collapsed.add(node.path):collapsed.delete(node.path);render();};const chevron=icon('chevron');chevron.classList.add('chevron');const folder=icon(expanded?'folderOpen':'folder');folder.classList.add('folder-icon');const name=document.createElement('span');name.className='folder-name';name.textContent=node.name;const count=document.createElement('span');count.className='folder-count';count.textContent=node.files.length;toggle.append(chevron,folder,name,count);heading.append(toggle);rows.append(heading);if(expanded)append(node.children);
   }else{
    const file=node.file,row=document.createElement('div');row.className=`file-row${file.path===active?.path?' active':''}${reasons(file).length?' ignored':''}`;row.style.setProperty('--depth',node.depth);row.dataset.path=file.path;
    const button=document.createElement('button');button.dataset.focus=`file-open:${file.path}`;button.setAttribute('aria-label',`Open ${file.path}${progress.viewed(file)?', viewed':''}`);button.setAttribute('aria-current',String(file.path===active?.path));const name=document.createElement('span');name.className='file-name';name.textContent=node.name;button.append(fileIcon(file.path),name);button.title=[pathChange(file)?.paths||file.path,...reasons(file),classification.get(file.path)?.semanticReason,file.error||''].filter(Boolean).join('\n');button.onclick=safe(()=>open(file));
    const reviewed=document.createElement('input');reviewed.type='checkbox';reviewed.className='reviewed-checkbox';reviewed.dataset.focus=`file-reviewed:${file.path}`;reviewed.checked=progress.viewed(file);reviewed.disabled=!file.fingerprint;reviewed.setAttribute('aria-label',`Reviewed ${file.path}`);reviewed.title='Mark this file reviewed (saved locally)';reviewed.onchange=safe(()=>{try{progress.mark([file],reviewed.checked);}finally{render();}});row.append(reviewed,button);
    const status=document.createElement('small');const change=pathChange(file);status.textContent=file.error?'!':change?.label||file.status;status.dataset.status=file.error?'error':file.status;status.title=file.error||(change?`${change.label}: ${change.paths}${file.blobUnchanged?' · identical contents':' · inspect content changes'}`:`Change: ${file.status}`);row.append(status);rows.append(row);
   }
  }}
  append(buildFileTree(listed));if(!listed.length){const empty=document.createElement('p');empty.className='tree-empty';empty.textContent='No files match your search and review filters.';rows.append(empty);}$('files').replaceChildren(rows);$('files').scrollTop=scroll;
  if(focused){const element=[...$('files').querySelectorAll('[data-focus]')].find(element=>element.dataset.focus===focused);element?.focus({preventScroll:true});}
  if(active&&!listedPaths.has(active.path)){if(listed.length)open(listed[0]);else clearEditor();}
  $('viewed').checked=active?progress.viewed(active):false;
 }
 function clearEditor(){for(const action of paneActions.splice(0))action.dispose();editor?.setModel(null);for(const model of models){model.dispose();}models=[];active=null;$('current-icon').replaceChildren();$('current-file').textContent='Choose a file';$('viewed').disabled=true;$('add-comment').disabled=true;$('threads').replaceChildren();}
 function theme(){const style=getComputedStyle(document.body);const rgb=style.backgroundColor.match(/\d+/g)?.slice(0,3).map(Number)||[255,255,255];const background='#'+rgb.map(value=>value.toString(16).padStart(2,'0')).join('');const dark=rgb.reduce((sum,value)=>sum+value,0)<384;monaco.editor.defineTheme('azure-review',{base:dark?'vs-dark':'vs',inherit:true,rules:[],colors:{'editor.background':background,'editorGutter.background':background,'diffEditor.unchangedRegionBackground':background}});monaco.editor.setTheme('azure-review');}
 window.addEventListener('themeApplied',theme);
 function open(file){clearEditor();active=file;const parts=file.path.split('/');for(let i=1;i<parts.length;i++)collapsed.delete(parts.slice(0,i).join('/'));$('current-icon').replaceChildren(fileIcon(file.path));$('current-file').textContent=pathChange(file)?.paths||file.path;$('viewed').disabled=!file.fingerprint;$('viewed').checked=progress.viewed(file);
  if(!editor){theme();editor=monaco.editor.createDiffEditor($('editor'),{readOnly:true,originalEditable:false,automaticLayout:true,renderSideBySide:sideBySide,useInlineViewWhenSpaceIsLimited:false,minimap:{enabled:false},scrollBeyondLastLine:false,find:{seedSearchStringFromSelection:'always',autoFindInSelection:'never'}});new MutationObserver(theme).observe(document.documentElement,{attributes:true,attributeFilter:['style','class']});}
  const language=file.path.endsWith('.cs')?'csharp':/\.(json|jsonc)$/.test(file.path)?'json':/\.(csproj|props|targets|xml|resx)$/.test(file.path)?'xml':undefined;
  const before=file.error?file.error:file.binary?'Binary or non-regular Git object — use Azure native Files to inspect.':file.original;const after=file.error?file.error:file.binary?'Binary or non-regular Git object — use Azure native Files to inspect.':file.modified;
  models=[monaco.editor.createModel(before,language),monaco.editor.createModel(after,language)];editor.setModel({original:models[0],modified:models[1]});
  $('add-comment').disabled=!!draftError||!review.latestIteration||!file.fingerprint||!!file.error||file.binary;
  for(const [side,pane] of [['left',editor.getOriginalEditor()],['right',editor.getModifiedEditor()]]){
   paneActions.push(pane.onDidFocusEditorWidget(()=>lastSide=side));
   paneActions.push(pane.onMouseDown(()=>lastSide=side));
   paneActions.push(pane.addAction({id:`azure-review-comment-${side}`,label:'Add review comment on selected lines',contextMenuGroupId:'navigation',contextMenuOrder:1.5,keybindings:[monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyM],run:safe(()=>compose(side))}));
  }
  const navigateDiff=direction=>{const lines=(editor.getLineChanges()||[]).map(change=>Math.max(1,change.modifiedStartLineNumber));const modified=editor.getModifiedEditor(),line=modified.getPosition()?.lineNumber||0;const next=direction>0?lines.find(value=>value>line)??lines[0]:lines.toReversed().find(value=>value<line)??lines.at(-1);if(next){modified.setPosition({lineNumber:next,column:1});modified.revealLineInCenter(next);}};$('previous-diff').onclick=()=>navigateDiff(-1);$('next-diff').onclick=()=>navigateDiff(1);
  $('threads').replaceChildren();
  for(const thread of review.threads.filter(thread=>!thread.isDeleted&&(!thread.threadContext?.filePath||[file.path,file.oldPath].includes(thread.threadContext.filePath.replace(/^\//,''))))){
   const comments=(thread.comments||[]).filter(comment=>!comment.isDeleted&&!['3','system'].includes(String(comment.commentType).toLowerCase()));
   if(!comments.length)continue;
   const article=document.createElement('article'),coordinates=thread.pullRequestThreadContext?.iterationContext;
   article.title=coordinates?.secondComparingIteration===review.latestIteration?'Current source/target iteration':'Historical or unverified iteration';
   const side=thread.threadContext?.rightFileStart?'right':'left',position=thread.threadContext?.[`${side}FileStart`];
   if(position){const range=document.createElement('button');range.className='thread-range';range.textContent=`${side==='right'?'Modified':'Original'} line ${position.line}`;let valid=false;try{validatePosition(models[side==='left'?0:1],{startLine:position.line,endLine:position.line,startOffset:position.offset,endOffset:position.offset});valid=true;}catch{}range.disabled=!valid||coordinates?.firstComparingIteration!==review.latestIteration||coordinates?.secondComparingIteration!==review.latestIteration;range.onclick=()=>{const pane=side==='left'?editor.getOriginalEditor():editor.getModifiedEditor();pane.setPosition({lineNumber:position.line,column:position.offset+1});pane.revealLineInCenter(position.line);pane.focus();};article.append(range);}
   for(const comment of comments){const p=document.createElement('p');p.textContent=`${comment.author?.displayName||'Unknown'}: ${comment.content||''}`;article.append(p);}
   $('threads').append(article);
  }
  render();
 }
 for(const [key,label] of Object.entries({resources:'Resource files',formatting:'Formatting only',usings:'Using directives only',renames:'File moves and verified rename references',projectReferenceRenames:'Project-reference path renames',namespaceRenames:'Namespace rename propagation (text-only)',generated:'Generated code',designers:'Designer files',migrations:'Migrations',testProjects:'Test projects'})){const element=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=filters[key];checkbox.onchange=safe(()=>{filters={...filters,[key]:checkbox.checked};persistFilters();});element.append(checkbox,document.createTextNode(label));$('filter-options').append(element);}
 const namespaceRules=document.createElement('p');namespaceRules.id='namespace-rules';namespaceRules.textContent='Namespace propagation is opt-in text matching, not compiler proof. Review the namespace mapping and dependency diagrams; runtime bindings may change. Mixed edits, literals and comments remain visible.';$('filter-options').append(namespaceRules);
 $('patterns').value=filters.patterns.join('\n');$('show-ignored').checked=filters.showIgnored;$('show-ignored').onchange=safe(()=>{filters={...filters,showIgnored:$('show-ignored').checked};persistFilters();});$('apply-patterns').onclick=safe(()=>{filters=normalizeFilters({...filters,patterns:$('patterns').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)});filterWarning='';persistFilters();notice('Custom ignore patterns applied.');});$('search').oninput=render;
 $('namespace-hint-action').onclick=event=>{event.stopPropagation();$('filters').open=true;namespaceRules.scrollIntoView({block:'nearest'});};
 $('close-filters').onclick=()=>$('filters').open=false;
 document.addEventListener('click',event=>{if(!event.target.closest('#filters'))$('filters').open=false;});
 document.addEventListener('keydown',event=>{if(event.key==='Escape')$('filters').open=false;});
 $('collapse-folders').onclick=()=>{function collapse(nodes){for(const node of nodes)if(node.kind==='folder'){collapsed.add(node.path);collapse(node.children);}}collapse(buildFileTree(visible()));render();};
 $('viewed').onchange=safe(()=>{try{progress.mark([active],$('viewed').checked);}finally{render();}});
 const step=direction=>{const list=visible();if(list.length)open(list[(Math.max(0,list.indexOf(active))+direction+list.length)%list.length]);};$('previous').onclick=()=>step(-1);$('next').onclick=()=>step(1);
 document.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key.toLowerCase()==='p'){event.preventDefault();$('search').focus();return;}if(['INPUT','TEXTAREA'].includes(event.target.tagName)||event.target.closest('.monaco-editor'))return;if(event.key.toLowerCase()==='j')step(1);if(event.key.toLowerCase()==='k')step(-1);if(event.key.toLowerCase()==='v'&&active?.fingerprint){event.preventDefault();safe(()=>{progress.mark([active],!progress.viewed(active));render();})();}});
 $('dependencies').onclick=()=>{if(graph)renderDependencyDiagrams($('dependency-content'),graph,false,path=>{const file=review.files.find(file=>file.path===path);if(file){$('dependency-dialog').close();$('search').value='';if(reasons(file).length){filters={...filters,showIgnored:true};$('show-ignored').checked=true;persistFilters();}open(file);}});else $('dependency-content').textContent='Dependency analysis is still loading.';$('dependency-dialog').showModal();};$('close-dependencies').onclick=()=>$('dependency-dialog').close();
 async function load(id){if(publishing)throw new Error('Wait for the current comment publication before reloading.');const snapshot=++generation;clearTimeout(analysisTimeout);analysisWorker?.terminate();clearEditor();review=null;graph=null;classification.clear();$('listed-count').textContent='';$('review-meter').value=0;$('files').replaceChildren();$('progress').textContent='Loading…';notice('Loading immutable merge-base snapshot…');let loaded;try{loaded=await loadReview(connection,id);}catch(error){if(snapshot!==generation)return;throw error;}if(snapshot!==generation)return;review=loaded;draftKey=`azure-filtered-review:draft:${connection.organization}:${connection.user}:${review.repository}:${id}`;draft=null;draftError=null;try{draft=restoreCommentDraft(localStorage.getItem(draftKey));}catch(error){draftError=error.message;}renderComposer();progress=new Progress(localStorage,`azure-filtered-review:${connection.organization}:${connection.user}:${review.repository}:${id}`);$('reload').title=`Reload snapshot (merge-base ${review.base.slice(0,8)} → source ${review.source.slice(0,8)})`;render();if(visible().length)open(visible()[0]);notice(draftError||review.threadError||filterWarning||'Progress and drafts are local to this browser. Analyzing ignore candidates…');analysisWorker=new Worker(new URL('./analysis-worker.js',import.meta.url),{type:'module'});analysisWorker.onerror=()=>notice('Ignore analysis failed; files stay visible.');analysisWorker.onmessage=({data})=>{if(snapshot!==generation)return;if(!data.semanticPending)clearTimeout(analysisTimeout);if(data.error){notice(data.error);return;}classification=new Map(data.classifications.map(value=>[value.path,value]));graph=data.dependencies;namespaceRules.textContent='Text matching only, not compiler proof. Review namespace mappings and dependency diagrams; runtime bindings may change. '+(data.namespaceRenames?.length?'Detected: '+data.namespaceRenames.slice(0,16).map(pair=>`${pair.from} → ${pair.to}`).join('; '):'No unambiguous namespace mapping detected.')+` · ${data.classifications.filter(value=>value.namespaceTextOnly).length} namespace-only candidates. Mixed edits, literals and comments remain visible.`;render();notice([draftError,review.threadError,filterWarning,data.semanticPending?'Automatically verifying C# ignore candidates with browser-local Roslyn…':data.semanticSummary,data.configUnknown?'EditorConfig generated_code settings could not be resolved safely: generated candidates kept visible.':'',`${review.files.length} immutable changed files loaded. Local progress and drafts; publish comments explicitly.`].filter(Boolean).join('\n'));};analysisTimeout=setTimeout(()=>{if(snapshot===generation){analysisWorker.terminate();notice('Roslyn verification timed out; unverified changes stay visible.');}},60000);analysisWorker.postMessage({files:review.files,configurations:review.configurations,companionUrl:compilerUrl,snapshot:{repositoryId:review.repository,base:review.base,source:review.source}});}
 $('context').hidden=!!connection.pullRequestId;$('pr-id').value=connection.pullRequestId||'';$('context').onsubmit=event=>{event.preventDefault();const id=Number($('pr-id').value);if(Number.isSafeInteger(id)&&id>0)safe(()=>load(id))();};$('reload').onclick=safe(()=>load(connection.pullRequestId||Number($('pr-id').value)));if(connection.pullRequestId)await load(connection.pullRequestId);else notice('Enter the PR ID above; automatic PR context is not available in this host.');
 return {load};
}
