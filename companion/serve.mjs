import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {detectRenames} from '../analysis.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const limit=64*1024*1024;
const sha=text=>createHash('sha256').update(text,'utf8').digest('hex');
function check(value,message='Invalid trusted compiler profile'){if(!value)throw new Error(message);}
function keys(value,required,optional=[]){check(value&&typeof value==='object'&&!Array.isArray(value));check(required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key)));}
function path(value){check(typeof value==='string'&&value.length>0&&value.length<4096&&!/[\\\x00-\x1f]/.test(value)&&!value.startsWith('/')&&!value.split('/').some(part=>part==='..'||part==='.'||!part));return value;}
function list(value){check(Array.isArray(value)&&value.length<=10000&&value.every(item=>typeof item==='string'));return value;}
function origin(value){const url=new URL(value);check(url.origin===value&&(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1'));return value;}
function run(program,args,input='',timeout=30000){return new Promise((done,fail)=>{
 const child=spawn(program,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let buffers=[],size=0,settled=false;
 const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?fail(error):done(value);};
 const timer=setTimeout(()=>{child.kill();finish(new Error('Trusted compiler process timed out'));},timeout);
 child.on('error',error=>finish(error));child.stdout.on('data',chunk=>{size+=chunk.length;if(size>limit){child.kill();finish(new Error('Compiler input/output limit exceeded'));}else buffers.push(chunk);});
 child.stderr.resume();child.stdin.on('error',()=>{});child.on('close',code=>{const output=Buffer.concat(buffers);if(code!==0&&program==='git')finish(new Error('Immutable Git source unavailable'));else finish(null,output);});child.stdin.end(input);
 });}

export async function loadProfile(filename){
 const profile=JSON.parse(await readFile(filename,'utf8'));keys(profile,['version','repositoryRoot','repositoryId','base','source','allowedOrigins','before','after']);
 check(profile.version===1&&typeof profile.repositoryId==='string'&&profile.repositoryId.length>0&&typeof profile.repositoryRoot==='string');
 check(/^[a-f0-9]{40}$/.test(profile.base)&&/^[a-f0-9]{40}$/.test(profile.source));
 check(Array.isArray(profile.allowedOrigins)&&profile.allowedOrigins.length>0&&profile.allowedOrigins.length<=20);profile.allowedOrigins.forEach(origin);
 const directory=dirname(resolve(filename));const root=resolve(directory,profile.repositoryRoot);
 const optionFields=['languageVersion','documentationMode','symbols','outputKind','optimizationLevel','nullableContextOptions','allowUnsafe','checkOverflow','platform','usings','warningLevel','metadataImportOptions'];
 const all=[];
 for(const [side,commit] of [['before',profile.base],['after',profile.source]]){
  check(Array.isArray(profile[side])&&profile[side].length>0&&profile[side].length<=300);
  const ids=new Set();
  for(const project of profile[side]){
   keys(project,['id','assemblyName','complete','sources','references','projectReferences','options']);
   check(typeof project.id==='string'&&project.id.length>0&&!ids.has(project.id)&&typeof project.assemblyName==='string'&&project.assemblyName.length>0&&project.complete===true);ids.add(project.id);
   keys(project.options,optionFields);const options=project.options;
   check(optionFields.filter(field=>!['symbols','usings','allowUnsafe','checkOverflow','warningLevel'].includes(field)).every(field=>typeof options[field]==='string'&&options[field].length>0));
   list(options.symbols);list(options.usings);check(typeof options.allowUnsafe==='boolean'&&typeof options.checkOverflow==='boolean'&&Number.isInteger(options.warningLevel)&&options.warningLevel>=0&&options.warningLevel<=9999);
   list(project.projectReferences);check(new Set(project.projectReferences).size===project.projectReferences.length);
   check(Array.isArray(project.references)&&project.references.length<=1000);
   for(const reference of project.references){keys(reference,['path','sha256']);check(typeof reference.path==='string'&&/^[a-f0-9]{64}$/i.test(reference.sha256));reference.path=resolve(directory,reference.path);}
   check(Array.isArray(project.sources)&&project.sources.length>0&&project.sources.length<=10000);const paths=new Set();
   for(const source of project.sources){keys(source,['path','compilerPath'],['generatedText']);path(source.path);check(typeof source.compilerPath==='string'&&source.compilerPath.length>0&&!/[\x00-\x1f]/.test(source.compilerPath));check(!paths.has(source.path));paths.add(source.path);if(Object.hasOwn(source,'generatedText'))check(typeof source.generatedText==='string');all.push({source,commit});}
  }
  check(profile[side].every(project=>project.projectReferences.every(id=>ids.has(id))));
 }
 check(profile.before.length===profile.after.length);
 for(const project of profile.before){const after=profile.after.find(other=>other.id===project.id);check(after&&optionFields.every(field=>JSON.stringify(project.options[field])===JSON.stringify(after.options[field])),'Compiler options changed; keep this snapshot visible');}
 check(all.length<=20000);
 const immutable=new Map();const requested=[...new Set(all.filter(({source})=>!Object.hasOwn(source,'generatedText')).map(({source,commit})=>`${commit}:${source.path}`))];
 if(requested.length){
  const bytes=await run('git',['-C',root,'cat-file','--batch'],requested.join('\n')+'\n');let offset=0;
  for(const name of requested){const newline=bytes.indexOf(10,offset);check(newline>=0,'Missing Git blob');const header=bytes.subarray(offset,newline).toString('ascii');const match=/^[a-f0-9]{40} blob (\d+)$/.exec(header);check(match,'Missing Git blob');const size=Number(match[1]);offset=newline+1;check(offset+size<bytes.length&&bytes[offset+size]===10);const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(offset,offset+size));immutable.set(name,text);offset+=size+1;}
  check(offset===bytes.length);
 }
 let total=0;
 for(const {source,commit} of all){source.text=Object.hasOwn(source,'generatedText')?source.generatedText:immutable.get(`${commit}:${source.path}`);delete source.generatedText;total+=Buffer.byteLength(source.text);check(total<=limit);}
 const maps={};
 for(const side of ['before','after']){maps[side]=new Map();for(const project of profile[side])for(const source of project.sources){const previous=maps[side].get(source.path);check(previous===undefined||previous===source.text,'Shared source inputs disagree');maps[side].set(source.path,source.text);}}
 return {profile,maps};
}

export async function startCompanion({profile:loaded,worker=resolve(here,'bin','Debug','net10.0','ReviewCompiler.dll'),port=0}){
 const {profile,maps}=loaded;const capability=randomBytes(32).toString('hex');const route=`/${capability}/verify`;let busy=false;
 const verify=async request=>{
  keys(request,['version','repositoryId','base','source','files']);check(request.version===1&&request.repositoryId===profile.repositoryId&&request.base===profile.base&&request.source===profile.source,'Snapshot does not match trusted profile');
  check(Array.isArray(request.files)&&request.files.length<=10000);const paths=new Set();const files=[];const identities=new Map();
  for(const file of request.files){keys(file,['path','oldPath','originalHash','modifiedHash']);path(file.path);path(file.oldPath);check(!paths.has(file.path)&&/^[a-f0-9]{64}$/.test(file.originalHash)&&/^[a-f0-9]{64}$/.test(file.modifiedHash));paths.add(file.path);
   if(!/\.cs$/i.test(file.path)||!maps.before.has(file.oldPath)||!maps.after.has(file.path))continue;
   const original=maps.before.get(file.oldPath),modified=maps.after.get(file.path);check(sha(original)===file.originalHash&&sha(modified)===file.modifiedHash,'File contents do not match trusted snapshot');
   files.push({path:file.path,oldPath:file.oldPath,original,modified});identities.set(file.path,file);
  }
  const renamed=detectRenames(files);const candidates=renamed.classifications.filter(file=>file.renameOnly&&!file.fileRenameOnly).map(file=>({path:file.path,oldPath:identities.get(file.path).oldPath}));
  if(!candidates.length)return {contextValid:true,results:[]};
  const pairs=renamed.pairs.map(pair=>({namespace:pair.namespace||'',from:pair.from,to:pair.to,kind:pair.kind||'type'}));
  const output=await run('dotnet',[worker],JSON.stringify({before:profile.before,after:profile.after,candidates,pairs}));const response=JSON.parse(output.toString('utf8'));
  check(typeof response.contextValid==='boolean'&&Array.isArray(response.results),'Invalid trusted compiler response');
  return {contextValid:response.contextValid,results:response.results.filter(value=>value.renameOnly===true&&value.semanticVerified===true&&identities.has(value.path)).map(value=>({...identities.get(value.path),renameOnly:true,semanticVerified:true,semanticReason:value.semanticReason}))};
 };
 const server=createServer(async(req,res)=>{
  const send=(status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  const expectedHost=`127.0.0.1:${server.address().port}`;if(req.headers.host!==expectedHost||req.url!==route){send(404,{error:'Not found'});return;}
  const allowed=req.headers.origin&&profile.allowedOrigins.includes(req.headers.origin);if(req.headers.origin&&!allowed){send(403,{error:'Origin not permitted'});return;}
  if(allowed){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Private-Network','true');}
  if(req.method==='OPTIONS'){res.statusCode=204;res.end();return;}
  if(req.method==='GET'){send(200,{version:1,repositoryId:profile.repositoryId,base:profile.base,source:profile.source});return;}
  if(req.method!=='POST'||req.headers['content-type']!=='application/json'){send(415,{error:'JSON POST required'});return;}
  if(busy){send(409,{error:'Local compiler busy; keep changes visible'});return;}
  busy=true;
  try{let size=0,buffers=[];for await(const chunk of req){size+=chunk.length;check(size<=2*1024*1024);buffers.push(chunk);}const result=await verify(JSON.parse(Buffer.concat(buffers).toString('utf8')));send(200,{version:1,repositoryId:profile.repositoryId,base:profile.base,source:profile.source,...result});}
  catch{send(422,{error:'Trusted compiler context or snapshot could not be verified; keep changes visible'});}
  finally{busy=false;}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise((done,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',done);});
 return {server,url:`http://127.0.0.1:${server.address().port}${route}`,close:()=>new Promise(done=>server.close(done))};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{check(process.argv.length===3,'Usage: node companion\\serve.mjs <trusted-profile.json>');const instance=await startCompanion({profile:await loadProfile(resolve(process.argv[2]))});process.stdout.write(`Local compiler capability URL (keep private):\n${instance.url}\n`);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>instance.server.close(()=>process.exit(0)));}
 catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
