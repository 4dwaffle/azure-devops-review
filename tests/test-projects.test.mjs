import test from 'node:test';
import assert from 'node:assert/strict';
import { isTestProject, testProjectClassifier } from '../test-projects.mjs';

const testXml = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>';
const project = (path, contents = testXml) => ({ path, contents });
const classify = (base, source = base) => testProjectClassifier({ base, source, complete: true });

test('test project detection reads explicit metadata and test SDKs, never names', () => {
    for (const xml of [testXml, testXml.replace('true', ' TRUE '), '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0"/></ItemGroup></Project>', '<Project Sdk="MSTest.Sdk/3.9.0"/>', '<Project><Sdk Name="MSTest.Sdk" Version="3.9.0"/></Project>']) assert.equal(isTestProject(xml), true, xml);
    for (const xml of ['<Project/>', '<Project><PropertyGroup><AssemblyName>App.Tests</AssemblyName></PropertyGroup></Project>', '<Project><ItemGroup><PackageReference Include="xunit"/></ItemGroup></Project>', '<Project><!-- <IsTestProject>true</IsTestProject> --></Project>']) assert.equal(isTestProject(xml), false, xml);
});

test('uncertain declarations, overrides, imports and invalid XML keep projects visible', () => {
    for (const xml of [
        testXml.replace('true', '$(Tests)'),
        testXml.replace('<IsTestProject>', '<IsTestProject Condition="\'$(Config)\' == \'Debug\'">'),
        testXml.replace('<PropertyGroup>', '<PropertyGroup Condition="\'$(Config)\' == \'Debug\'">'),
        testXml.replace('</Project>', '<PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup></Project>'),
        testXml.replace('</Project>', '<Import Project="custom.targets"/></Project>'),
        testXml.replace('<PropertyGroup>', '<Target Name="X">').replace('</PropertyGroup>', '</Target>'),
        '<Project><ItemGroup Condition="\'$(Config)\' == \'Debug\'"><PackageReference Include="Microsoft.NET.Test.Sdk"/></ItemGroup></Project>',
        '<Project><IsTestProject>true</Project>', '<!DOCTYPE Project [<!ENTITY x "true">]><Project><IsTestProject>&x;</IsTestProject></Project>', undefined
    ]) assert.equal(isTestProject(xml), false, xml);
});

test('nearest actual csproj owns nested files; names and neighboring folders have no effect', () => {
    const entries = [project('src/Verification/Verification.csproj'), project('src/App.Tests/App.Tests.csproj', '<Project/>'), project('src/Verification/Production/Production.csproj', '<Project/>')];
    const confirmed = classify(entries);
    for (const path of ['src/Verification/Check.cs', 'src/Verification/Nested/data.json', 'src/Verification/Verification.csproj']) assert.equal(confirmed({ path, status: 'M' }), true, path);
    for (const path of ['src/App.Tests/Test.cs', 'src/Verification/Production/Check.cs', 'src/VerificationOther/Check.cs', 'Check.cs']) assert.equal(confirmed({ path, status: 'M' }), false, path);
    assert.equal(classify([project('Root.csproj')])({ path: 'Nested/Check.cs', status: 'M' }), true);
});

test('both immutable snapshots must confirm membership except the absent side of adds and deletes', () => {
    const before = [project('old/Verify.csproj')], after = [project('new/Verify.csproj')];
    assert.equal(classify(before, after)({ path: 'new/Check.cs', oldPath: 'old/Check.cs', status: 'R90' }), true);
    assert.equal(classify(before, after)({ path: 'new/Check.cs', oldPath: 'production/Check.cs', status: 'R90' }), false);
    assert.equal(classify(before, after)({ path: 'production/Check.cs', oldPath: 'old/Check.cs', status: 'R90' }), false);
    assert.equal(classify([], after)({ path: 'new/Check.cs', status: 'A' }), true);
    assert.equal(classify(before, [])({ path: 'old/Check.cs', status: 'D' }), true);
    assert.equal(classify(before, [project('old/Verify.csproj', '<Project/>')])({ path: 'old/Check.cs', status: 'M' }), false);
});

test('incomplete trees, failed reads, mixed ownership and mode changes never confirm a test file', () => {
    const entries = [project('src/Verify.csproj')], file = { path: 'src/Check.cs', status: 'M' };
    assert.equal(testProjectClassifier({ base: entries, source: entries, complete: false })(file), false);
    for (const extra of [{ path: 'src/Other.csproj', error: 'Unavailable' }, project('src/Other.csproj', '<Project/>')]) assert.equal(classify([...entries, extra])(file), false);
    assert.equal(classify(entries)({ ...file, error: 'Unavailable' }), false);
    assert.equal(classify(entries)({ ...file, modeChanged: true }), false);
    assert.equal(classify([...entries, project('src/Other.csproj')])(file), true);
});
