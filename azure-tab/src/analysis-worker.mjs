import {classifyChange,detectRenames,dependencyDelta} from '../../analysis.mjs';
import {generatedFilename,generatedHeader} from '../../generated-code.mjs';
self.onmessage=({data})=>{
 try {
  const {files,configurations}=data;
  const renamed=detectRenames(files.filter(file=>!file.error));const changes=new Map(renamed.classifications.map(value=>[value.path,value]));
  const configUnknown=configurations.some(config=>config.error||/generated_code\s*=/i.test(config.contents));
  const classifications=files.map(file=>({path:file.path,...(!file.error&&!file.binary?classifyChange(file.path,file.original,file.modified):{}),...changes.get(file.path),generated:!configUnknown&&!file.error&&(file.status==='D'?generatedFilename(file.path)||generatedHeader(file.path,file.original):generatedFilename(file.path)||generatedHeader(file.path,file.modified))&&(file.status==='A'||generatedFilename(file.oldPath||file.path)||generatedHeader(file.oldPath||file.path,file.original)),generatedReason:'filename/header convention',renameOnly:!file.modeChanged&&(changes.get(file.path)?.renameOnly||file.status==='R100'&&file.original===file.modified)}));
  const dependencies=dependencyDelta(files.map(file=>file.error?{...file,binary:true,reason:file.error}:file));
  const byPath=new Map(files.map(file=>[file.path,file]));
  const conservative=classifications.map(value=>/\.cs$/i.test(value.path)?{...value,formattingOnly:false,usingsOnly:false,renameOnly:!!value.fileRenameOnly&&!byPath.get(value.path)?.modeChanged,reviewReason:value.fileRenameOnly?'':'C# formatting, using and reference changes remain visible.'}:value);
  const namespaceRenames=renamed.pairs.filter(pair=>pair.kind==='namespace');
  postMessage({classifications:conservative,dependencies,configUnknown,namespaceRenames});
 }catch(error){postMessage({error:String(error)});}
};
