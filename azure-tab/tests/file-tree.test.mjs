import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFileTree,flattenFileTree} from '../src/file-tree.mjs';
import {resolveReviewOrder} from '../src/review-order.mjs';
import {description,files,treePaths} from './review-order.fixture.mjs';

test('PR order follows the exact sequence across folders before the remaining normal tree',()=>{
 const {ranks}=resolveReviewOrder(files,description),tree=buildFileTree(files,ranks);
 assert.deepEqual(flattenFileTree(tree).map(file=>file.path),treePaths);
 assert.deepEqual(tree.slice(0,6).map(node=>node.reviewRank),[0,1,2,3,4,5]);
 assert.ok(tree.slice(0,6).every(node=>node.kind==='file'&&node.depth===0));
 assert.deepEqual(tree.slice(6).map(node=>node.path),['src','Other.md']);
 const logic=tree[6].children[0];assert.equal(logic.path,'src/TouchlessMzdy.Logic');
 assert.deepEqual(logic.children.map(node=>node.name),['Resources']);
 assert.equal(logic.children[0].files.length,1);assert.equal(logic.children[0].children[0].depth,3);
 assert.equal(new Set(flattenFileTree(tree)).size,files.length);
});

test('Normal ordering and an empty ranking keep folders first and alphabetical; ranks put unlisted siblings last',()=>{
 const files=['Z.cs','Folder/Z.cs','Folder/A.cs','A.cs','Folder/Nested/B.cs'].map(path=>({path}));
 const normal=['Folder/Nested/B.cs','Folder/A.cs','Folder/Z.cs','A.cs','Z.cs'];
 for(const ranks of [undefined,new Map()])assert.deepEqual(flattenFileTree(buildFileTree(files,ranks)).map(file=>file.path),normal);
 assert.deepEqual(flattenFileTree(buildFileTree(files,new Map([['Z.cs',0],['Folder/Z.cs',1]]))).map(file=>file.path),['Z.cs','Folder/Z.cs','Folder/Nested/B.cs','Folder/A.cs','A.cs']);
 assert.deepEqual(buildFileTree([],new Map()),[]);
});

test('An unlisted sibling never interrupts review links that alternate between the same folders',()=>{
 const files=['Core/Models/Event.cs','Core/Models/Details.cs','Core/Recording/Service.cs','Core/Recording/Helper.cs','Adapter/Publish.cs','Core/Models/Scope.cs'].map(path=>({path}));
 const description='## Review order\n1. [Event.cs](https://example.com?path=%2FCore%2FModels%2FEvent.cs)\n2. [Service.cs](https://example.com?path=%2FCore%2FRecording%2FService.cs)\n3. `Adapter/Publish.cs`\n4. `Core/Models/Scope.cs`';
 const {ranks,matched,unmatched}=resolveReviewOrder(files,description);
 assert.equal(matched,4);assert.deepEqual(unmatched,[]);
 assert.deepEqual(flattenFileTree(buildFileTree(files,ranks)),[files[0],files[2],files[4],files[5],files[1],files[3]]);
 // Search or ignored-file filtering preserves the relative sequence and original rank.
 const filtered=buildFileTree(files.filter(file=>![files[0],files[4]].includes(file)),ranks);
 assert.deepEqual(flattenFileTree(filtered),[files[2],files[5],files[1],files[3]]);
 assert.deepEqual(filtered.slice(0,2).map(node=>node.reviewRank),[1,3]);
});
