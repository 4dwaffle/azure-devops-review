import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewOrderPaths,reviewOrderEntries,resolveReviewOrder} from '../src/review-order.mjs';
import {description,paths,files} from './review-order.fixture.mjs';

test('Supplied PR description orders six named files across folders, leaving prose resources unexpanded',()=>{
 const result=resolveReviewOrder(files,description);
 assert.deepEqual(result.files.map(file=>file.path),paths);
 assert.equal(result.matched,6);assert.deepEqual(result.unmatched,[]);
 assert.notEqual(files[0].path,paths[0],'Does not mutate the Azure file list');
});
test('ReviewOrder accepts lists, multiple code spans, link labels and slash normalization',()=>{
 assert.deepEqual(reviewOrderPaths('## ReviewOrder ##\r\n1) `/src/A.cs`, `./src/B.cs` — see `Ignored.cs`\r\n- [src/C.cs](https://example.com)\r\n* src\\D.cs - notes\r\n+ `path with spaces/E.cs`'),['src/A.cs','src/B.cs','src/C.cs','src/D.cs','path with spaces/E.cs']);
});
test('Only named sections contribute paths; fenced examples and later sections do not',()=>{
 const text='1. `Before.cs`\n```md\n## Review order\n1. `Example.cs`\n```\n## Review order\n1. `Real.cs`\n### Details\n2. `Also.cs`\n~~~\n1. `Code.cs`\n~~~\n## Tests\n1. `Tests.cs`';
 assert.deepEqual(reviewOrderPaths(text),['Real.cs','Also.cs']);
 for(const empty of [undefined,null,'','## Review notes\n1. `A.cs`'])assert.deepEqual(reviewOrderPaths(empty),[]);
});
test('Unknown and ambiguous paths preserve every file and cannot guess a duplicate basename',()=>{
 const input=[{path:'a/README.md'},{path:'b/README.md'},{path:'A.cs'},{path:'a.cs'}];
 const result=resolveReviewOrder(input,'## Review order\n1. `README.md`\n2. `Missing.cs`\n3. `a.cs`\n4. `*.cs`\n5. `https://example.com/A.cs`');
 assert.equal(result.matched,1);assert.equal(result.files[0].path,'a.cs');assert.deepEqual(result.unmatched,['README.md','Missing.cs']);
 assert.equal(new Set(result.files).size,input.length);
});
test('Unique short paths and old rename paths resolve once; exact current paths take precedence',()=>{
 const moved={path:'new/A.cs',oldPath:'old/A.cs'},other={path:'other.cs'};
 const result=resolveReviewOrder([other,moved],'## Review order\n1. `/old/A.cs`\n2. `new/A.cs`\n3. `A.cs`\n4. `A.cs`');
 assert.deepEqual(result.files,[moved,other]);assert.equal(result.matched,1);
 const exact={path:'old/A.cs'};
 assert.equal(resolveReviewOrder([moved,exact],'## Review order\n1. `old/A.cs`').files[0],exact);
});

test('Absent, empty and unusable review orders preserve all changed files',()=>{
 const input=[{path:'z/Last.cs'},{path:'a/First.cs'},{path:'Root.md'}];
 const normal=[...input].sort((a,b)=>a.path.localeCompare(b.path));
 for(const description of [undefined,null,'','Ordinary PR description.','## Review order','## Review order\n1. Explain the changes.','## Review order\n1. `Removed.cs`']){
  const result=resolveReviewOrder(input,description);
  assert.equal(result.matched,0);assert.deepEqual(result.files,normal);
 }
 assert.deepEqual(resolveReviewOrder([],undefined).files,[]);
});

test('Partial review orders append every unlisted file alphabetically, including when references have disappeared',()=>{
 const input=[{path:'z/Last.cs'},{path:'a/First.cs'},{path:'Root.md'},{path:'Middle.cs'}];
 const result=resolveReviewOrder(input,'## Review order\n1. `z/Last.cs`\n2. `Deleted.cs`\n3. `Middle.cs`\n4. `z/Last.cs`');
 assert.deepEqual(result.files,[input[0],input[3],input[1],input[2]]);
 assert.equal(result.matched,2);assert.deepEqual(result.unmatched,['Deleted.cs']);
 assert.equal(new Set(result.files).size,input.length);
});

test('Notes belong to each preceding path and remain plain text; dashes inside code paths stay intact',()=>{
 const entries=reviewOrderEntries('## Review order\n1. `folder - name/A.cs` and [B.cs](https://example.com) — check `literal.cs` and <b>authorization</b>\n2. `C.cs` - cancellation — failure\n3. `D.cs`');
 assert.deepEqual(entries,[{path:'folder - name/A.cs',note:'check `literal.cs` and <b>authorization</b>'},{path:'B.cs',note:'check `literal.cs` and <b>authorization</b>'},{path:'C.cs',note:'cancellation — failure'},{path:'D.cs',note:''}]);
 const result=resolveReviewOrder([{path:'new/B.cs',oldPath:'old/B.cs'}],'## Review order\n1. `old/B.cs` — first note\n2. `new/B.cs` — second note\n3. `Missing.cs` — unavailable');
 assert.deepEqual([...result.notes],[['new/B.cs','first note']]);assert.deepEqual([...result.ranks],[['new/B.cs',0]]);
});
