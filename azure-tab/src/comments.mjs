export function commentPosition(model, selection) {
 if(!model||!selection)throw new Error('Select a line or code range in the diff first.');
 let {startLineNumber:startLine,startColumn,endLineNumber:endLine,endColumn}=selection;
 if(startLine===endLine&&startColumn===endColumn){startColumn=1;endColumn=model.getLineMaxColumn(endLine);}
 else if(endColumn===1&&endLine>startLine){endLine--;endColumn=model.getLineMaxColumn(endLine);}
 const position={startLine,endLine,startOffset:startColumn-1,endOffset:Math.max(0,endColumn-2)};
 validatePosition(model,position);return position;
}
export function validatePosition(model,position) {
 const {startLine,endLine,startOffset,endOffset}=position;
 if(![startLine,endLine,startOffset,endOffset].every(Number.isSafeInteger)||startLine<1||endLine<startLine||endLine>model.getLineCount()||startOffset<0||endOffset<0||startOffset>Math.max(0,model.getLineLength(startLine)-1)||endOffset>Math.max(0,model.getLineLength(endLine)-1)||(startLine===endLine&&endOffset<startOffset))throw new Error('The comment range is outside this immutable file snapshot.');
}
export function createCommentDraft(review,file,side,model,selection) {
 if(!review.latestIteration||file.error||file.binary||!file.fingerprint)throw new Error('Comments require a verified text file in the current PR iteration.');
 if(!['left','right'].includes(side)||side==='left'&&file.status==='A'||side==='right'&&file.status==='D')throw new Error('This side of the file does not exist in this snapshot.');
 return {version:1,id:crypto.randomUUID(),repository:review.repository,prId:review.pr.pullRequestId,source:review.source,target:review.target,base:review.base,iteration:review.latestIteration,path:file.path,oldPath:file.oldPath,fingerprint:file.fingerprint,side,...commentPosition(model,selection),content:'',state:'draft'};
}
function activeStatus(status){return status===1||String(status).toLowerCase()==='active';}
export async function prepareComment(connection,review,draft) {
 const {client,project}=connection;
 if(!draft||draft.repository!==review.repository||draft.prId!==review.pr.pullRequestId||draft.source!==review.source||draft.target!==review.target||draft.base!==review.base||draft.iteration!==review.latestIteration)throw new Error('This draft belongs to an older snapshot. Reload and re-review the range before commenting.');
 if(typeof draft.content!=='string'||!draft.content.trim()||draft.content.length>10000)throw new Error('Enter a comment of 1–10,000 characters.');
 const file=review.files.find(file=>file.path===draft.path);
 if(!file||file.fingerprint!==draft.fingerprint||file.binary||file.error)throw new Error('The draft file is no longer verified.');
 if(!['left','right'].includes(draft.side)||draft.side==='left'&&file.status==='A'||draft.side==='right'&&file.status==='D')throw new Error('Invalid comment side.');
 const text=draft.side==='left'?file.original:file.modified,lines=text.split(/\r\n|\r|\n/);
 validatePosition({getLineCount:()=>lines.length,getLineLength:line=>lines[line-1]?.length},draft);
 const pr=await client.getPullRequestById(draft.prId,project);
 if(pr.repository?.id!==review.repository||!activeStatus(pr.status)||pr.lastMergeSourceCommit?.commitId!==review.source||pr.lastMergeTargetCommit?.commitId!==review.target)throw new Error('The PR changed or is no longer active. Reload and re-review before publishing.');
 const iterations=await client.getPullRequestIterations(review.repository,draft.prId,project);
 const latest=[...iterations].sort((a,b)=>b.id-a.id)[0];
 if(latest?.id!==draft.iteration||latest.sourceRefCommit?.commitId!==review.source||latest.targetRefCommit?.commitId!==review.target||latest.commonRefCommit?.commitId!==review.base)throw new Error('The current iteration does not match the reviewed merge-base snapshot. Reload before publishing.');
 let skip=0,changes=[];
 do {
  const page=await client.getPullRequestIterationChanges(review.repository,draft.prId,draft.iteration,project,2000,skip,0);
  changes.push(...(page.changeEntries||[]));
  if(!page.nextSkip)break;
  if(!Number.isSafeInteger(page.nextSkip)||page.nextSkip<=skip)throw new Error('Invalid iteration change pagination.');
  skip=page.nextSkip;
 }while(true);
 const matches=changes.filter(change=>change.item?.path==='/'+draft.path);
 if(matches.length!==1||!Number.isSafeInteger(matches[0].changeTrackingId)||matches[0].changeTrackingId<1)throw new Error('No unique current-iteration change tracking ID for this file.');
 const change=matches[0];
 if(file.oldPath&&change.originalPath!=='/'+file.oldPath)throw new Error('Azure rename tracking does not match this reviewed file.');
 const side=draft.side;
 const body={comments:[{parentCommentId:0,content:draft.content,commentType:1}],status:1,threadContext:{filePath:change.item.path,[`${side}FileStart`]:{line:draft.startLine,offset:draft.startOffset},[`${side}FileEnd`]:{line:draft.endLine,offset:draft.endOffset}},pullRequestThreadContext:{changeTrackingId:change.changeTrackingId,iterationContext:{firstComparingIteration:draft.iteration,secondComparingIteration:draft.iteration}}};
 // Repeat the cheap live guard immediately before returning the body for the single write.
 const current=await client.getPullRequestById(draft.prId,project);
 if(!activeStatus(current.status)||current.lastMergeSourceCommit?.commitId!==review.source||current.lastMergeTargetCommit?.commitId!==review.target)throw new Error('The PR changed during comment preflight. Reload before publishing.');
 return body;
}
export function restoreCommentDraft(value) {
 if(value===null)return null;
 const draft=JSON.parse(value);
 if(!draft||draft.version!==1||typeof draft.id!=='string'||typeof draft.path!=='string'||typeof draft.content!=='string'||!['draft','publishing','published','uncertain'].includes(draft.state))throw new Error('The saved draft is invalid. It has been preserved; review remains available, but commenting is blocked.');
 if(draft.state==='publishing')draft.state='uncertain';
 return draft;
}
export function matchesPublishedThread(thread,body) {
 if(!Number.isSafeInteger(thread?.id)||thread.id<1||thread.isDeleted||!body)return false;
 const actual=thread.threadContext,expected=body.threadContext,side=expected?.rightFileStart?'right':'left';
 const same=(a,b)=>!!b&&a?.line===b.line&&a?.offset===b.offset;
 return actual?.filePath===expected?.filePath&&same(actual?.[`${side}FileStart`],expected?.[`${side}FileStart`])&&same(actual?.[`${side}FileEnd`],expected?.[`${side}FileEnd`])&&thread.pullRequestThreadContext?.changeTrackingId===body.pullRequestThreadContext?.changeTrackingId&&thread.pullRequestThreadContext?.iterationContext?.firstComparingIteration===body.pullRequestThreadContext?.iterationContext?.firstComparingIteration&&thread.pullRequestThreadContext?.iterationContext?.secondComparingIteration===body.pullRequestThreadContext?.iterationContext?.secondComparingIteration&&thread.comments?.some(comment=>comment.content===body.comments?.[0]?.content&&!comment.isDeleted);
}
export async function reconcileComment(connection,draft,save) {
 if(draft.state!=='uncertain'||!draft.submittedBody)throw new Error('No saved publication payload is available. Check native Files manually.');
 const threads=await connection.client.getThreads(draft.repository,draft.prId,connection.project,draft.iteration,draft.iteration);
 const matches=threads.filter(thread=>matchesPublishedThread(thread,draft.submittedBody));
 if(matches.length!==1)throw new Error(matches.length?'Multiple matching threads found. Check native Files manually.':'No matching published thread found. The result remains uncertain; do not retry without checking native Files.');
 draft.state='published';draft.threadId=matches[0].id;save(draft);return matches[0];
}
export async function publishComment(connection,review,draft,save) {
 if(draft.state!=='draft')throw new Error('This draft was submitted or its write outcome is uncertain. Check native Files before creating another comment.');
 const body=await prepareComment(connection,review,draft);
 draft.submittedBody=body;draft.state='publishing';save(draft);
 try {
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Publication response timed out')),30000);});
  let thread;
  try {thread=await Promise.race([connection.client.createThread(body,review.repository,draft.prId,connection.project),timeout]);}finally{clearTimeout(timer);}
  if(!matchesPublishedThread(thread,body))throw new Error('Azure returned an unexpected write result.');
  draft.state='published';draft.threadId=thread.id;save(draft);return thread;
 }catch(error){
  const status=Number(error.status??error.statusCode);
  draft.state=[400,401,403,404,409,422].includes(status)?'draft':'uncertain';save(draft);
  throw new Error(draft.state==='uncertain'?'Comment outcome is uncertain; automatic retry is blocked. Check the native Files tab before creating another comment.':String(error.message||error));
 }
}
