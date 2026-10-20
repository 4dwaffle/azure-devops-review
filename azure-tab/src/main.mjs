import {connect,loadPullRequest} from './azure.mjs';
// Start SDK/auth and acquisition while the editor module is downloading and
// evaluating. Consume this first immutable snapshot once; refresh still reads
// the current PR and performs the normal snapshot checks.
try {
 const session=connect().then(connection=>({connection,initial:connection.pullRequestId?
  loadPullRequest(connection,connection.pullRequestId).then(value=>({value}),error=>({error})):null}));
 const [{start},{connection,initial}]=await Promise.all([import('./app.mjs'),session]);
 let first=initial;
 await start(connection,async(context,id)=>{
  const pending=first;first=null;
  if(pending&&id===connection.pullRequestId){const result=await pending;if(result.error)throw result.error;return result.value;}
  return loadPullRequest(context,id);
 });
}catch(error){document.getElementById('notice').textContent=String(error.message||error);}
