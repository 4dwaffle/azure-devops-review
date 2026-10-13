import * as SDK from 'azure-devops-extension-sdk';
import {getClient,CommonServiceIds} from 'azure-devops-extension-api';
import {GitRestClient} from 'azure-devops-extension-api/Git';
import {pagedDiff,changedFiles,inferExactRenames,mapBounded,fingerprint} from './review.mjs';
export function contextId(configuration={}) {
 const id=configuration.pullRequestId??configuration.pullRequest?.pullRequestId;
 return Number.isSafeInteger(Number(id))&&Number(id)>0?Number(id):null;
}
export async function connect() {
 SDK.init({loaded:false,applyTheme:true});await SDK.ready();
 const service=await SDK.getService(CommonServiceIds.ProjectPageService);const project=await service.getProject();
 if(!project)throw new Error('Open Filtered Review inside an Azure DevOps project.');
 const client=getClient(GitRestClient);let pullRequestId=contextId(SDK.getConfiguration());
  if(!pullRequestId){try {const navigation=await SDK.getService(CommonServiceIds.HostNavigationService);pullRequestId=contextId((await navigation.getPageRoute()).routeValues);}catch{/* Manual PR ID fallback remains available. */}}
  await SDK.notifyLoadSucceeded();
  return {client,project:project.id,user:SDK.getUser().id,organization:SDK.getHost().id,pullRequestId};
}
export async function loadPullRequest(connection,id) {
 const {client,project}=connection;const pr=await client.getPullRequestById(id,project);
 const repository=pr.repository?.id;
 const source=pr.lastMergeSourceCommit?.commitId,target=pr.lastMergeTargetCommit?.commitId;
 if(!repository||!source||!target)throw new Error('PR snapshot commits are not available yet. Retry after Azure has calculated the merge.');
 const {base,changes}=await pagedDiff((skip,top)=>client.getCommitDiffs(repository,project,true,top,skip,{version:target,versionType:2},{version:source,versionType:2}));
 let files=changedFiles(changes);
 const descriptor=version=>({version,versionType:2});
 const item=(path,version,content=true)=>client.getItem(repository,'/'+path,project,undefined,0,true,false,false,descriptor(version),content,false);
 const modes={};
 await Promise.all([base,source].map(async version=>{const commit=await client.getCommit(version,repository,project,0);const tree=await client.getTree(repository,commit.treeId,project,undefined,true);modes[version]=new Map(tree.treeEntries.map(entry=>[entry.relativePath.replace(/^\//,''),entry]));}));
 files=inferExactRenames(files,modes[base],modes[source]);
 let latestIteration=null,threads=[],threadError;
 try {const iterations=await client.getPullRequestIterations(repository,id,project);const latest=[...iterations].sort((a,b)=>b.id-a.id)[0];latestIteration=latest?.sourceRefCommit?.commitId===source&&latest?.targetRefCommit?.commitId===target?latest.id:null;threads=await client.getThreads(repository,id,project,latestIteration??undefined,latestIteration??undefined);}catch(error){threadError=`Comment threads unavailable: ${error.message||error}`;}
 await mapBounded(files,async file=>{
  const left=modes[base].get(file.oldPath||file.path),right=modes[source].get(file.path);
  file.beforeMode=left?.mode;file.afterMode=right?.mode;file.modeChanged=!!left&&!!right&&left.mode!==right.mode;
  if((file.status!=='A'&&!left)||(file.status!=='D'&&!right)){file.error='Git tree metadata is incomplete; native review required.';return;}
  file.binary=[left,right].some(entry=>entry&&entry.mode!=='100644'&&entry.mode!=='100755');
  if(file.status==='R'&&/^[a-f0-9]{40}$/i.test(left?.objectId||'')&&!/^0+$/.test(left.objectId)&&left.objectId===right?.objectId){file.status='R100';file.blobUnchanged=true;}
  try {
   const [before,after]=await Promise.all([file.status==='A'?null:item(file.oldPath||file.path,base),file.status==='D'?null:item(file.path,source)]);
   file.binary ||= !!before?.contentMetadata?.isBinary||!!after?.contentMetadata?.isBinary;
   if(!file.binary&&((before&&typeof before.content!=='string')||(after&&typeof after.content!=='string')))throw new Error('Azure did not return text content; this file must be reviewed in the native Files tab.');
   file.original=file.binary?'':before?.content||'';file.modified=file.binary?'':after?.content||'';
   if(file.binary){file.original=left?.objectId||'';file.modified=right?.objectId||'';}
   file.fingerprint=await fingerprint(file);
  }catch(error){file.error=String(error.message||error);file.original='';file.modified='';}
 });
 const configs=new Set(['.editorconfig','.globalconfig']);for(const file of files)for(const path of new Set([file.path,file.oldPath].filter(Boolean))){const parts=path.split('/');parts.pop();while(parts.length){configs.add(parts.join('/')+'/.editorconfig');parts.pop();}}
 const configurations=[];
 await mapBounded([...configs],async path=>{await Promise.all([base,source].map(async version=>{try {const config=await item(path,version);configurations.push({path,side:version===base?'base':'source',contents:config.content||''});}catch(error){if(error.status!==404&&error.statusCode!==404)configurations.push({path,error:String(error.message||error)});}}));});
 return {pr,repository,source,target,base,files,threads,latestIteration,threadError,configurations};
}
