import test from 'node:test';
import assert from 'node:assert/strict';
import { ignoredReasons, normalizeFilters } from '../analysis.mjs';
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
