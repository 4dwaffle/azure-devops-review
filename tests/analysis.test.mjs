import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange, normalizeFilters, ignoredReasons, detectRenames, dependencyDelta, parseDependencies, analyzeReview } from '../analysis.mjs';
const file = (path, original, modified, extra = {}) => ({ path, oldPath: path, original, modified, status: 'M', ...extra });
test('formatting classification preserves lexical boundaries and unsupported syntax', () => {
    assert.equal(classifyChange('A.cs', 'class A{int x=1;}', 'class A { int x = 1; }').formattingOnly, true);
    assert.equal(classifyChange('A.json', '{"a":1}', '{\n "a": 1\n}').formattingOnly, true);
    for (const [left, right] of [['int x=1;', 'intx=1;'], ['x++;', 'x+ +;'], ['"a b"', '"ab"'], ['"x"u8', '"x" u8'], ['// x\nint a;', '//x\nint a;'], ['$"{a}"', '$"{ a }"'], ['#if X\nint x;\n#endif', '#if X\n int x;\n#endif'], ['"""a b"""', '"""ab"""']]) assert.equal(classifyChange('A.cs', left, right).formattingOnly, false, left);
    assert.equal(classifyChange('A.json', '{a:1}', '{ a:1 }').formattingOnly, false);
});
test('using filters distinguish directives from executable using declarations', () => {
    for (const directive of ['using System;', 'global using System.Text;', 'using static System.Math;', 'using X = System.Text.StringBuilder;', 'using global::System;']) assert.equal(classifyChange('A.cs', `${directive}\nclass A {}`, 'class A {}').usingsOnly, true, directive);
    assert.equal(classifyChange('A.cs', 'namespace N { using System; class A {} }', 'namespace N { class A {} }').usingsOnly, true);
    for (const [left, right] of [['class A { void M(){ using X; } }', 'class A { void M(){} }'], ['using var stream = Open();', ''], ['using System; class A { int x; }', 'class A { string x; }'], ['using /* important */ System; class A {}', 'class A {}']]) assert.equal(classifyChange('A.cs', left, right).usingsOnly, false);
});
test('persistent filters default to rename suppression and support safe relative globs', () => {
    const filters = normalizeFilters({ resources: true, designers: false, patterns: ['**/*.Designer.cs', '**/*.Designer.cs'] });
    assert.equal(filters.renames, true); assert.equal(filters.patterns.length, 1);
    assert.deepEqual(ignoredReasons({ path: 'Locale/A.resx' }, filters), ['resource file']);
    assert.deepEqual(ignoredReasons({ path: 'Code/A.Designer.cs' }, filters), ['pattern: **/*.Designer.cs']);
    assert.throws(() => normalizeFilters({ patterns: ['C:\\bad'] }));
    assert.deepEqual(ignoredReasons({ path: 'A.cs' }, filters, { renameOnly: true }), ['detected type-rename references only']);
});
test('200 type-rename-only reference edits hide without hiding declaring or mixed files', () => {
    const declaration = file('NewName.cs', 'namespace N; class OldName {}', 'namespace N; class NewName {}');
    const references = Array.from({ length: 200 }, (_, i) => file(`Reference${i}.cs`, `namespace N; class Use${i} { OldName x; }`, `namespace N; class Use${i} { NewName x; }`));
    const mixed = [file('Mixed.cs', 'OldName x=Get(1);', 'NewName x=Get(2);'), file('String.cs', 'OldName x; string s="OldName";', 'NewName x; string s="NewName";'), file('Comment.cs', '// OldName\nOldName x;', '// NewName\nNewName x;')];
    const result = detectRenames([declaration, ...references, ...mixed]);
    assert.deepEqual(result.pairs.map(pair => [pair.from, pair.to]), [['OldName', 'NewName']]);
    assert.equal(result.classifications.filter(value => value.renameOnly).length, 200);
    assert.equal(result.classifications.find(value => value.path === declaration.path).renameOnly, false);
    for (const value of mixed) assert.equal(result.classifications.find(result => result.path === value.path).renameOnly, false);
});
test('ambiguous namespaces and mappings stay visible; pure moves require mode-safe identity', () => {
    const result = detectRenames([file('A.cs', 'namespace N; class Old {}', 'namespace N; class New {}'), file('B.cs', 'namespace M; class Old {}', 'namespace M; class Other {}'), file('Ref.cs', 'Old x;', 'New x;')]);
    assert.equal(result.pairs.length, 0); assert.equal(result.classifications.at(-1).renameOnly, false);
    const collision = detectRenames([file('A.cs', 'namespace N; class Old {}', 'namespace N; class New {}'), file('B.cs', 'namespace M; class Old { int x; }', 'namespace M; class Old { int y; }')]);
    assert.equal(collision.pairs.length, 0);
    assert.equal(detectRenames([file('A.cs', 'class A {}', 'class A {}', { status: 'R100', blobUnchanged: false })]).classifications[0].renameOnly, false);
    assert.equal(detectRenames([file('A.cs', 'class A {}', 'class A {}', { status: 'R100', blobUnchanged: true })]).classifications[0].renameOnly, true);
});
test('namespace propagation is a separate opt-in exact-text filter including moved declarations', () => {
    const origin = file('New/Entity.cs', 'namespace Old.Data; public class Entity {}', 'namespace New.Data; public class Entity {}', {status:'R',oldPath:'Old/Entity.cs'});
    const reference = file('Reference.cs', 'using Old.Data; class R { Old.Data.Entity value; }', 'using New.Data; class R { New.Data.Entity value; }');
    const rejected = [
        file('Mixed.cs', 'using Old.Data; class X { int x=1; }', 'using New.Data; class X { int x=2; }'),
        file('Literal.cs', 'using Old.Data; class X { string s="Old.Data"; }', 'using New.Data; class X { string s="New.Data"; }'),
        file('Comment.cs', '// Old.Data\nusing Old.Data; class X {}', '// New.Data\nusing New.Data; class X {}'),
        file('Whitespace.cs', 'using Old.Data; class X {}', 'using New.Data;  class X {}'),
        file('Boundary.cs', 'using Old.DataExtra; class X {}', 'using New.DataExtra; class X {}'),
        file('Directive.cs', '#if X\nusing Old.Data;\n#endif', '#if X\nusing New.Data;\n#endif'),
        {...reference,path:'Mode.cs',modeChanged:true}, {...reference,path:'Error.cs',error:'Incomplete read'}
    ];
    const result = detectRenames([origin,reference,...rejected]);
    const classes = new Map(result.classifications.map(value => [value.path,value]));
    assert.equal(classes.get(origin.path).namespaceTextOnly,true);
    assert.equal(classes.get(origin.path).renameOnly,false,'Existing declaration visibility is unchanged');
    assert.equal(classes.get(reference.path).namespaceTextOnly,true);
    const normal = normalizeFilters({renames:false}), enabled = normalizeFilters({renames:false,namespaceRenames:true});
    assert.equal(normal.namespaceRenames,false); assert.equal(normalizeFilters({namespaceRenames:'true'}).namespaceRenames,false);
    assert.deepEqual(ignoredReasons(origin,normal,classes.get(origin.path)),[]);
    assert.deepEqual(ignoredReasons(origin,enabled,classes.get(origin.path)),['namespace rename propagation (text-only; not compiler-verified)']);
    for (const f of rejected) { assert.notEqual(classes.get(f.path)?.namespaceTextOnly,true,f.path); assert.deepEqual(ignoredReasons(f,enabled,classes.get(f.path)),[],f.path); }
    const ambiguous = detectRenames([origin,file('Other.cs','namespace Old.Data; class Other {}','namespace Other.Data; class Other {}'),reference]);
    assert.ok(ambiguous.classifications.every(value => !value.namespaceTextOnly));
});
test('dependency diagrams capture packages, projects, metadata, conditions and central versions', () => {
    const before = '<Project><ItemGroup Condition="$(TargetFramework)==net8.0"><PackageReference Include="A" Version="1" PrivateAssets="all"/><ProjectReference Include="..\\Core\\Core.csproj"/></ItemGroup></Project>';
    const after = before.replace('Version="1"', 'Version="2"').replace('PrivateAssets="all"', 'PrivateAssets="none"');
    const graph = dependencyDelta([file('App/App.csproj', before, after)]);
    assert.equal(graph.changes, 1); assert.equal(graph.edges.find(edge => edge.name === 'A').status, 'modified');
    assert.equal(graph.edges.find(edge => edge.name === 'A').before.version, '1'); assert.equal(graph.edges.find(edge => edge.name === 'A').after.metadata.PrivateAssets, 'none');
    assert.equal(graph.edges.find(edge => edge.kind === 'project').to, 'file:Core/Core.csproj'); assert.match(graph.edges[0].condition, /net8.0/);
    assert.equal(parseDependencies('Directory.Packages.props', '<Project><ItemGroup><PackageVersion Include="A" Version="3"/></ItemGroup></Project>')[0].version, '3');
    assert.equal(parseDependencies('A.csproj', '<Project><ItemGroup><PackageReference Include="A" Version="1" VersionOverride="4"/></ItemGroup></Project>')[0].version, '4');
    assert.equal(parseDependencies('packages.config', '<packages><package id="A" version="1"/></packages>')[0].name, 'A');
});
test('npm and NuGet locks, added/removed dependencies and invalid manifests remain explicit', () => {
    const graph = dependencyDelta([file('package.json', '{"dependencies":{"A":"1","B":"1"}}', '{"dependencies":{"A":"2","C":"1"}}')]);
    assert.deepEqual(graph.edges.map(edge => edge.status).sort(), ['added', 'modified', 'removed']);
    assert.equal(parseDependencies('package-lock.json', '{"packages":{"node_modules/a":{"version":"1"}}}')[0].version, '1');
    assert.equal(parseDependencies('packages.lock.json', '{"dependencies":{"net8.0":{"A":{"type":"Direct","resolved":"2"}}}}')[0].scope, 'net8.0/Direct');
    assert.throws(() => parseDependencies('A.csproj', '<!DOCTYPE Project SYSTEM "file:///secret"><Project/>'), /DTD/);
    assert.equal(dependencyDelta([file('A.csproj', '', '<Project>')]).warnings.length, 1);
});
test('Namespace relocation proposals preserve declarations, literals, comments, mixed edits and ambiguity', () => {
    const origin = file('Entity.cs', 'namespace Old.Data; class Entity {}', 'namespace New.Data; class Entity {}');
    const reference = file('Reference.cs', 'using Old.Data; class R { Old.Data.Entity value; }', 'using New.Data; class R { New.Data.Entity value; }');
    const result = detectRenames([origin, reference, file('Literal.cs', 'using Old.Data; class X { string s="Old.Data"; }', 'using New.Data; class X { string s="New.Data"; }'), file('Mixed.cs', 'using Old.Data; class X { int x=1; }', 'using New.Data; class X { int x=2; }')]);
    assert.deepEqual(result.pairs.map(pair => [pair.kind, pair.from, pair.to]), [['namespace','Old.Data','New.Data']]);
    assert.equal(result.classifications.find(value => value.path === 'Entity.cs').renameOnly, false);
    assert.equal(result.classifications.find(value => value.path === 'Reference.cs').namespaceRenameOnly, true);
    for (const path of ['Literal.cs','Mixed.cs']) assert.equal(result.classifications.find(value => value.path === path).renameOnly, false);
    const moved = detectRenames([file('Old/Entity.cs', origin.original, '', {status:'D'}), file('New/Entity.cs','',origin.modified,{status:'A'}),reference]);
    assert.equal(moved.classifications.find(value => value.path === 'Reference.cs').namespaceRenameOnly, true);
    const ambiguous = detectRenames([origin,file('Other.cs', 'namespace Old.Data; class Other {}', 'namespace Other.Data; class Other {}'),reference]);
    assert.equal(ambiguous.pairs.length,0);
});
test('Source dependency diagrams include explicit imports without inventing bindings or literal dependencies', () => {
    const result = dependencyDelta([file('A.cs','using Old.Data; using System; class A {}','using New.Data; using System; class A { string s="using Fake.Data;"; }')]);
    assert.equal(result.manifests,0); assert.equal(result.sourceFiles,1); assert.equal(result.changes,2);
    assert.deepEqual(result.edges.map(value=>[value.name,value.status]),[['Old.Data','removed'],['System','unchanged'],['New.Data','added']]);
    assert.equal(result.edges[0].kind,'csharp-import'); assert.match(result.edges[0].scope,/syntax only/);
    assert.equal(dependencyDelta([file('A.cs','using Old;\n#if X\n#endif','using New;\n#if X\n#endif')]).warnings.length,1);
});
test('analysis reads immutable blobs with bounded concurrency and keeps dependencies independent of filters', async () => {
    const files = [file('A.cs', 'class Old {}', 'class New {}'), file('Ref.cs', 'Old x;', 'New x;'), file('package.json', '{}', '{"dependencies":{"A":"1"}}'), file('Moved.txt', 'x', 'x', { status: 'R100', blobUnchanged: true })];
    let active = 0, maximum = 0;
    const result = await analyzeReview({ files }, async path => { maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return files.find(file => file.path === path); }, true);
    assert.ok(maximum <= 4); assert.equal(result.dependencies.changes, 1); assert.equal(result.renames.semanticVerification, false);
    assert.equal(result.classifications.find(file => file.path === 'Ref.cs').renameOnly, true); assert.equal(result.classifications.find(file => file.path === 'Moved.txt').renameOnly, true);
});
