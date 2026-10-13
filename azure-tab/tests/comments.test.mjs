import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commentPosition,createCommentDraft,prepareComment,publishComment,reconcileComment} from '../src/comments.mjs';
const model={getLineCount:()=>3,getLineLength:line=>[4,6,0][line-1],getLineMaxColumn:line=>[5,7,1][line-1]};
function fixture(){
 const file={path:'New.cs',oldPath:'Old.cs',status:'R',original:'aaaa\nbbbbbb\n',modified:'aaaa\nbbbbbb\n',fingerprint:'hash'};
 const review={pr:{pullRequestId:7},repository:'r',source:'s',target:'t',base:'b',latestIteration:3,files:[file]};
 const pr={status:1,repository:{id:'r'},lastMergeSourceCommit:{commitId:'s'},lastMergeTargetCommit:{commitId:'t'}};
 const calls=[];const client={getPullRequestById:async()=>structuredClone(pr),getPullRequestIterations:async()=>[{id:3,sourceRefCommit:{commitId:'s'},targetRefCommit:{commitId:'t'},commonRefCommit:{commitId:'b'}}],getPullRequestIterationChanges:async(...args)=>{calls.push(['changes',args]);return {changeEntries:[{item:{path:'/New.cs'},originalPath:'/Old.cs',changeTrackingId:12}]};},createThread:async(body,...args)=>{calls.push(['post',body,args]);return {...body,id:101};}};
 const draft=createCommentDraft(review,file,'right',model,{startLineNumber:1,startColumn:2,endLineNumber:2,endColumn:1});draft.content='A real draft, not an automatic test comment';
 return {review,pr,client,calls,draft,connection:{client,project:'p'}};
}
test('Monaco coordinates: whole line, inclusive offsets, multiline boundary and bounds',()=>{
 assert.deepEqual(commentPosition(model,{startLineNumber:1,startColumn:3,endLineNumber:1,endColumn:3}),{startLine:1,endLine:1,startOffset:0,endOffset:3});
 assert.deepEqual(commentPosition(model,{startLineNumber:1,startColumn:2,endLineNumber:2,endColumn:1}),{startLine:1,endLine:1,startOffset:1,endOffset:3});
 assert.throws(()=>commentPosition(model,{startLineNumber:1,startColumn:9,endLineNumber:2,endColumn:8}),/outside/);
});
test('Preflight pages current common-base iteration and serializes tracking and range',async()=>{
 const f=fixture();f.client.getPullRequestIterationChanges=async(...args)=>{f.calls.push(args);return args[5]===0?{changeEntries:[{item:{path:'/Other.cs'},changeTrackingId:1}],nextSkip:2000}:{changeEntries:[{item:{path:'/New.cs'},originalPath:'/Old.cs',changeTrackingId:12}]};};
 const body=await prepareComment(f.connection,f.review,f.draft);
 assert.deepEqual(f.calls.map(args=>[args[2],args[4],args[5],args[6]]),[[3,2000,0,0],[3,2000,2000,0]]);
 assert.deepEqual(body.threadContext,{filePath:'/New.cs',rightFileStart:{line:1,offset:1},rightFileEnd:{line:1,offset:3}});
 assert.deepEqual(body.pullRequestThreadContext,{changeTrackingId:12,iterationContext:{firstComparingIteration:3,secondComparingIteration:3}});
 assert.equal(f.calls.filter(call=>call[0]==='post').length,0);
});
test('Stale, completed, mismatched base, missing tracking, unsafe rename and range never post',async()=>{
 for(const mutate of [f=>f.pr.lastMergeSourceCommit.commitId='new',f=>f.pr.status=3,f=>f.draft.source='old',f=>f.draft.endLine=9,f=>f.draft.content=' ',f=>f.client.getPullRequestIterations=async()=>[{id:4}],f=>f.client.getPullRequestIterations=async()=>[{id:3,sourceRefCommit:{commitId:'s'},targetRefCommit:{commitId:'t'},commonRefCommit:{commitId:'wrong'}}],f=>f.client.getPullRequestIterationChanges=async()=>({changeEntries:[]}),f=>f.client.getPullRequestIterationChanges=async()=>({changeEntries:[{item:{path:'/New.cs'},originalPath:'/Different.cs',changeTrackingId:12}]})]){
  const f=fixture();mutate(f);await assert.rejects(publishComment(f.connection,f.review,f.draft,()=>{}));assert.equal(f.calls.filter(call=>call[0]==='post').length,0);
 }
});
test('Publish once, durable uncertain result blocks retry; permission refusal remains editable',async()=>{
 let f=fixture(),states=[];const thread=await publishComment(f.connection,f.review,f.draft,d=>states.push(d.state));assert.equal(thread.id,101);assert.deepEqual(states,['publishing','published']);await assert.rejects(publishComment(f.connection,f.review,f.draft,()=>{}),/submitted/);assert.equal(f.calls.filter(call=>call[0]==='post').length,1);
 f=fixture();f.client.createThread=async()=>{throw new Error('network interruption');};await assert.rejects(publishComment(f.connection,f.review,f.draft,()=>{}),/uncertain/);assert.equal(f.draft.state,'uncertain');await assert.rejects(publishComment(f.connection,f.review,f.draft,()=>{}),/uncertain/);
 f=fixture();f.client.createThread=async()=>{throw {status:403,message:'Permission denied'};};await assert.rejects(publishComment(f.connection,f.review,f.draft,()=>{}),/Permission denied/);assert.equal(f.draft.state,'draft');
});
test('Unexpected successful response is uncertain, not silently retried',async()=>{
 const f=fixture();f.client.createThread=async body=>({...body,id:101,threadContext:{...body.threadContext,rightFileStart:{line:2,offset:0}}});await assert.rejects(publishComment(f.connection,f.review,f.draft,()=>{}),/uncertain/);assert.equal(f.draft.state,'uncertain');
});
test('Uncertain recovery requires exactly one matching root comment by the signed-in author',async()=>{
 for(const scenario of ['valid','other-author','reply','deleted','wrong-range','multiple','no-user','missing-author','none']){
  const f=fixture(),body=await prepareComment(f.connection,f.review,f.draft);f.draft.state='uncertain';f.draft.submittedBody=body;f.connection.user=scenario==='no-user'?undefined:'current-user';
  const thread={...structuredClone(body),id:101,comments:body.comments.map(comment=>({...comment,author:scenario==='missing-author'?undefined:{id:scenario==='other-author'?'someone-else':'current-user'}}))};
  if(scenario==='reply')thread.comments[0].parentCommentId=1;
  if(scenario==='deleted')thread.comments[0].isDeleted=true;
  if(scenario==='wrong-range')thread.threadContext.rightFileStart.offset++;
  f.client.getThreads=async()=>scenario==='none'?[]:scenario==='multiple'?[thread,{...thread,id:102}]:[thread];let saves=0;
  if(scenario==='valid'){assert.equal((await reconcileComment(f.connection,f.draft,()=>saves++)).id,101);assert.equal(f.draft.state,'published');assert.equal(saves,1);}
  else {await assert.rejects(reconcileComment(f.connection,f.draft,()=>saves++));assert.equal(f.draft.state,'uncertain');assert.equal(saves,0);}
  assert.equal(f.calls.filter(call=>call[0]==='post').length,0);
 }
});
