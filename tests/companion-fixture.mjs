import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {loadProfile,startCompanion} from '../companion/serve.mjs';
const root=resolve(import.meta.dirname,'..');
export const nativeAvailable=(()=>{try{return /^10\./m.test(execFileSync('dotnet',['--list-sdks'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));}catch{return false;}})();
export const hash=text=>createHash('sha256').update(text).digest('hex');
export const options={languageVersion:'14.0',documentationMode:'Parse',symbols:[],outputKind:'DynamicallyLinkedLibrary',optimizationLevel:'Debug',nullableContextOptions:'Disable',allowUnsafe:false,checkOverflow:false,platform:'AnyCpu',usings:[],warningLevel:4,metadataImportOptions:'Public'};
export async function fixture({large=false}={}){
 execFileSync('dotnet',['build','ReviewCompiler.csproj','--nologo','-v:q'],{cwd:resolve(root,'companion'),stdio:'pipe'});
 const directory=await mkdtemp(resolve(tmpdir(),'filtered-review-compiler-'));const git=(...args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const files=[{path:'Origin.cs',original:'public class Old {}',modified:'public class New {}'},{path:'Reference.cs',original:'public class Consumer { public Old Value; public Helper Support; }',modified:'public class Consumer { public New Value; public Helper Support; }'},{path:'Caller.cs',original:'using System.Runtime.CompilerServices; public class Caller { static string C(object value, [CallerArgumentExpression("value")] string text="")=>text; public string M()=>C(new Old()); }',modified:'using System.Runtime.CompilerServices; public class Caller { static string C(object value, [CallerArgumentExpression("value")] string text="")=>text; public string M()=>C(new New()); }'},{path:'Mixed.cs',original:'public class Mixed { public Old Value; public int Number=1; }',modified:'public class Mixed { public New Value; public int Number=2; }'},{path:'Moved.cs',oldPath:'Move.cs',original:'using System.Runtime.CompilerServices; public class Move { static string C(object value, [CallerFilePath] string path="")=>path; public string M()=>C(new Old()); }',modified:'using System.Runtime.CompilerServices; public class Move { static string C(object value, [CallerFilePath] string path="")=>path; public string M()=>C(new New()); }'}];
 if(large)for(let i=0;i<251;i++)files.push({path:`Extra${i}.cs`,original:`public class Extra${i} { public Old Value; }`,modified:`public class Extra${i} { public New Value; }`});
 for(const file of files){file.original='namespace Fixture; '+file.original;file.modified='namespace Fixture; '+file.modified;file.status=file.oldPath?'R':'M';file.fingerprint=hash(file.modified);await writeFile(resolve(directory,file.oldPath||file.path),file.original);}
 await writeFile(resolve(directory,'Helper.cs'),'namespace Fixture; public class Helper {}');
 git('init','--quiet');git('config','user.email','fixture@example.invalid');git('config','user.name','Compiler fixture');git('add','.');git('commit','--quiet','-m','Before fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>');const base=git('rev-parse','HEAD');
 for(const file of files){if(file.oldPath)await rm(resolve(directory,file.oldPath));await writeFile(resolve(directory,file.path),file.modified);}
 git('add','.');git('commit','--quiet','-m','After fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>');const source=git('rev-parse','HEAD');
 const dotnetRoot=dirname(process.platform==='win32'?execFileSync('where.exe',['dotnet'],{encoding:'utf8'}).trim().split(/\r?\n/)[0]:execFileSync('realpath',[execFileSync('which',['dotnet'],{encoding:'utf8'}).trim()],{encoding:'utf8'}).trim());
 const packs=resolve(dotnetRoot,'packs','Microsoft.NETCore.App.Ref');const version=(await readdir(packs)).filter(version=>version.startsWith('10.0.')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
 if(!version)throw new Error('Native fixture requires the .NET 10 reference pack');
 const refs=resolve(packs,version,'ref','net10.0');const references=await Promise.all(['System.Runtime.dll','System.Runtime.CompilerServices.VisualC.dll'].map(async name=>{const path=resolve(refs,name);return {path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')};}));
 const project=before=>({id:'fixture',assemblyName:'Fixture',complete:true,sources:[...files.map(file=>({path:before?file.oldPath||file.path:file.path,compilerPath:before?file.oldPath||file.path:file.path})),{path:'Helper.cs',compilerPath:'Helper.cs'}],references:structuredClone(references),projectReferences:[],options:structuredClone(options)});
 const profile={version:1,repositoryRoot:directory,repositoryId:'fixture-repository',base,source,allowedOrigins:['http://127.0.0.1:1'],before:[project(true)],after:[project(false)]};const filename=resolve(directory,'compiler.local.json');
 return {directory,filename,files,profile,base,source,async start(origin='http://127.0.0.1:1'){profile.allowedOrigins=[origin];await writeFile(filename,JSON.stringify(profile));return startCompanion({profile:await loadProfile(filename)});},request(){return {version:1,repositoryId:profile.repositoryId,base,source,files:files.map(file=>({path:file.path,oldPath:file.oldPath||file.path,originalHash:hash(file.original),modifiedHash:hash(file.modified)}))};},close:()=>rm(directory,{recursive:true,force:true})};
}
