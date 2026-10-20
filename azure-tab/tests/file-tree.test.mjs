import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFileTree,flattenFileTree} from '../src/file-tree.mjs';
import {resolveReviewOrder} from '../src/review-order.mjs';
import {description,files,treePaths} from './review-order.fixture.mjs';

test('PR order reorders the existing tree, keeping folders intact and every file present once',()=>{
 const {ranks}=resolveReviewOrder(files,description),tree=buildFileTree(files,ranks);
 assert.deepEqual(flattenFileTree(tree).map(file=>file.path),treePaths);
 assert.deepEqual(tree.map(node=>node.path),['src','Other.md']);
 const logic=tree[0].children[0];assert.equal(logic.path,'src/TouchlessMzdy.Logic');
 assert.deepEqual(logic.children.map(node=>node.name),['PayrollWorkers','TouchlessMzdy.Logic.csproj','DataSeeding','Resources']);
 assert.equal(logic.children[0].files.length,3);assert.equal(logic.children[0].children[0].depth,3);
 assert.equal(new Set(flattenFileTree(tree)).size,files.length);
});

test('Normal ordering and an empty ranking keep folders first and alphabetical; ranks put unlisted siblings last',()=>{
 const files=['Z.cs','Folder/Z.cs','Folder/A.cs','A.cs','Folder/Nested/B.cs'].map(path=>({path}));
 const normal=['Folder/Nested/B.cs','Folder/A.cs','Folder/Z.cs','A.cs','Z.cs'];
 for(const ranks of [undefined,new Map()])assert.deepEqual(flattenFileTree(buildFileTree(files,ranks)).map(file=>file.path),normal);
 assert.deepEqual(flattenFileTree(buildFileTree(files,new Map([['Z.cs',0],['Folder/Z.cs',1]]))).map(file=>file.path),['Z.cs','Folder/Z.cs','Folder/Nested/B.cs','Folder/A.cs','A.cs']);
 assert.deepEqual(buildFileTree([],new Map()),[]);
});
