import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathChange} from '../ui/path-changes.mjs';
test('Distinguishes filename renames, directory moves and their combination',()=>{
 for(const [oldPath,path,label] of [['Old.cs','New.cs','Renamed'],['before/C.cs','after/C.cs','Moved'],['before/Old.cs','after/New.cs','Moved + renamed'],['C.cs','folder/C.cs','Moved'],['Folder/C.cs','folder/C.cs','Moved'],['folder/c.cs','folder/C.cs','Renamed']]){
  assert.deepEqual(pathChange({status:'R100',oldPath,path}),{label,paths:`${oldPath} → ${path}`});
  assert.deepEqual(pathChange({status:'R087',oldPath,path}),{label,paths:`${oldPath} → ${path}`});
 }
 for(const file of [{status:'M',oldPath:'old',path:'new'},{status:'R100',path:'new'},{status:'R100',oldPath:'same',path:'same'}])assert.equal(pathChange(file),null);
});
