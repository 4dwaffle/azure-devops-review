import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFilters, ignoredReasons, normalizeFilters } from '../analysis.mjs';

test('test projects are opt-in, including for older saved preferences', () => {
    assert.equal(defaultFilters.testProjects, false);
    for (const value of [{}, { generated: false }, { testProjects: false }, { testProjects: 'true' }]) {
        const filters = normalizeFilters(value);
        assert.equal(filters.testProjects, false);
        assert.deepEqual(ignoredReasons({ path: 'src/Verification/Check.cs', testProject: true }, filters), []);
    }
    const filters = normalizeFilters({ testProjects: true });
    for (const path of ['App.Tests/Test.cs', 'src/App.IntegrationTests/Fixtures/data.json', 'src/Tests.App/Tests.App.csproj']) {
        for (const status of ['A', 'M', 'D']) assert.deepEqual(ignoredReasons({ path, status, testProject: true }, filters), ['test project']);
    }
    for (const path of ['src/App/Tests.cs', 'src/App/Tests.csproj', 'src/App.Tests/Test.cs']) assert.deepEqual(ignoredReasons({ path }, filters), []);
    assert.deepEqual(ignoredReasons({ path: 'src/Verification/Check.cs', testProject: true }, filters), ['test project']);
    assert.deepEqual(normalizeFilters(JSON.parse(JSON.stringify(filters))), filters);
});

test('test project filter retains mode changes, read failures and unconfirmed membership', () => {
    const filters = normalizeFilters({ testProjects: true });
    for (const file of [
        { path: 'src/App.Tests/Test.cs', modeChanged: true, testProject: true },
        { path: 'src/App.Tests/Test.cs', error: 'Read failed', testProject: true },
        { path: 'src/App.Tests/New.cs', oldPath: 'src/App/Old.cs', status: 'R90' },
        { path: 'src/App/New.cs', oldPath: 'src/App.Tests/Old.cs', status: 'R90' }
    ]) assert.deepEqual(ignoredReasons(file, filters), []);
    assert.deepEqual(ignoredReasons({ path: 'src/App.Tests/New.cs', oldPath: 'src/Tests.App/Old.cs', status: 'R90', testProject: true }, filters), ['test project']);
});

test('regex ignores match all files in folders containing Tests without matching filenames', () => {
    const pattern = 'regex:(^|/)[^/]*Tests[^/]*/';
    const filters = normalizeFilters({ patterns: [pattern], designers: false, migrations: false });
    for (const path of ['App.Tests/Test.cs', 'src/App.Tests/Fixtures/data.json', 'src/Tests.App/Tests.App.csproj', 'tests/App.IntegrationTests/Fixture.cs', 'src/App.Tests.Helpers/Nested/Asset.png', 'src/App/UnitTests/data.json']) {
        for (const status of ['A', 'M', 'D']) assert.deepEqual(ignoredReasons({ path, status }, filters), [`pattern: ${pattern}`], `${status} ${path}`);
    }
    for (const path of ['src/App/Tests.cs', 'src/App/Tests.csproj', 'src/App.tests/Test.cs']) assert.deepEqual(ignoredReasons({ path }, filters), [], path);
    assert.deepEqual(normalizeFilters(JSON.parse(JSON.stringify(filters))), filters);
});

test('regex ignores support escapes, anchors and alternation alongside existing globs', () => {
    const pattern = String.raw`regex:^src/(App\.Tests|Tests\.App)/.*\.(cs|json)$`;
    const filters = normalizeFilters({ patterns: [pattern, '**/*.resx', pattern], designers: false });
    assert.deepEqual(filters.patterns, [pattern, '**/*.resx']);
    for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual(ignoredReasons({ path: 'src/App.Tests/Nested/Test.cs' }, filters), [`pattern: ${pattern}`]);
    assert.deepEqual(ignoredReasons({ path: 'src/AppXTests/Test.cs' }, filters), []);
    assert.deepEqual(ignoredReasons({ path: 'other/src/App.Tests/Test.cs' }, filters), []);
    assert.deepEqual(ignoredReasons({ path: 'src/App.Tests/Test.xml' }, filters), []);
    assert.deepEqual(ignoredReasons({ path: 'Locale/App.resx' }, filters), ['pattern: **/*.resx']);
    assert.deepEqual(ignoredReasons({ path: 'src/App.Tests/Test.cs' }, normalizeFilters({ patterns: [] })), []);
});

test('invalid regexes and malformed patterns are rejected before filters are applied', () => {
    assert.throws(() => normalizeFilters({ patterns: ['regex:['] }), /Invalid ignore regex/);
    assert.throws(() => normalizeFilters({ patterns: ['regex:'] }), /expression after regex:/);
    for (const patterns of [['regex:  '], ['regex:a\nb'], ['regex:a\0b'], ['regex:' + 'a'.repeat(195)], Array(51).fill('regex:Tests'), [42], 'regex:Tests', [String.raw`src\App\*`]]) assert.throws(() => normalizeFilters({ patterns }), Error);
    assert.deepEqual(normalizeFilters().patterns, []);
});

test('regex ignores retain moves across matching folder boundaries', () => {
    const pattern = 'regex:(^|/)[^/]*Tests[^/]*/', filters = normalizeFilters({ patterns: [pattern] });
    for (const [path, oldPath] of [['src/App.Tests/New.cs', 'src/App/Old.cs'], ['src/App/New.cs', 'src/App.Tests/Old.cs']]) assert.deepEqual(ignoredReasons({ path, oldPath, status: 'R90' }, filters), []);
    assert.deepEqual(ignoredReasons({ path: 'src/App.Tests/New.cs', oldPath: 'src/Tests.App/Old.cs', status: 'R90' }, filters), [`pattern: ${pattern}`]);
});
test('designer and migration filters default on for older preferences and work without analysis', () => {
    const filters = normalizeFilters({ generated: false, renames: false });
    assert.equal(filters.designers, true); assert.equal(filters.migrations, true);
    for (const path of ['Form.Designer.cs', 'src/Resources.DESIGNER.vb', 'Migrations/20261012_Update.cs', 'src/migrations/DbModelSnapshot.cs', 'Migrations/sql/001.sql']) assert.ok(ignoredReasons({ path }, filters).length, path);
    assert.deepEqual(ignoredReasons({ path: 'Migrations/Update.Designer.cs' }, filters), ['designer file', 'migration folder']);
    for (const path of ['Form.Designer', 'Designer/Form.cs', 'DesignerHelper.cs', 'MigrationRunner.cs', 'src/MigrationsHelper/X.cs', 'src/Models/DbModelSnapshot.cs']) assert.deepEqual(ignoredReasons({ path }, filters), [], path);
    const disabled = normalizeFilters({ designers: false, migrations: false, generated: false });
    assert.deepEqual(ignoredReasons({ path: 'Migrations/X.Designer.cs' }, disabled), []);
});
test('path filters retain category-crossing renames and file mode changes', () => {
    const filters = normalizeFilters();
    for (const file of [
        { path: 'Form.Designer.cs', oldPath: 'Form.cs', status: 'R90' },
        { path: 'Form.cs', oldPath: 'Form.Designer.cs', status: 'R90' },
        { path: 'Migrations/Update.cs', oldPath: 'Domain/Update.cs', status: 'R90' },
        { path: 'Domain/Update.cs', oldPath: 'Migrations/Update.cs', status: 'R90' },
        { path: 'Migrations/Update.Designer.cs', modeChanged: true }
    ]) assert.deepEqual(ignoredReasons(file, filters), [], JSON.stringify(file));
    for (const status of ['A', 'D', 'M']) assert.deepEqual(ignoredReasons({ path: 'Migrations/Update.cs', oldPath: 'Migrations/Update.cs', status }, filters), ['migration folder']);
    assert.deepEqual(ignoredReasons({ path: 'src/Migrations/New.cs', oldPath: 'Migrations/Old.cs', status: 'R90' }, filters), ['migration folder']);
});
