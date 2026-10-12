import test from 'node:test';
import assert from 'node:assert/strict';
import { deadCodeDiagnostics, diagnosticMarkers } from '../ui/diagnostics.mjs';
import { Roslyn } from '../roslyn.mjs';
const markerApi = { MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 }, MarkerTag: { Unnecessary: 1 } };
const item = (code, severity = 4) => ({ code, severity, message: 'Diagnostic', tags: [1], range: { start: { line: 1, character: 3 }, end: { line: 1, character: 7 } } });
test('dead-code classification only recognizes compiler/analyzer diagnostic IDs', () => {
    assert.deepEqual(deadCodeDiagnostics([item('IDE0035'), item('IDE0051'), item('CS0162'), item('IDE0044'), { ...item('unknown'), message: 'dead code' }]).map(value => value.code), ['IDE0035', 'IDE0051', 'CS0162']);
});
test('Monaco markers preserve hint, information, warning, error, codes and unnecessary tags', () => {
    const markers = diagnosticMarkers(markerApi, [item('CS1002', 1), item('CS0162', 2), item('IDE0035', 3), item('IDE0051'), { message: 'No range' }]);
    assert.deepEqual(markers.map(value => value.severity), [8, 4, 2, 1]);
    assert.equal(markers[3].code, 'IDE0051'); assert.deepEqual(markers[3].tags, [1]);
    assert.equal(markers[0].startLineNumber, 2); assert.equal(markers[0].startColumn, 4); assert.equal(markers[0].endColumn, 8);
});
test('Roslyn diagnostics expose single-file scope and dead-code findings without hiding files', async () => {
    const client = new Roslyn('fixture'); client.open = async () => 'file:///fixture.cs'; client.request = async () => ({ kind: 'full', items: [item('IDE0051'), item('IDE0044')] });
    const result = await client.diagnostics({}, {});
    assert.equal(result.diagnostics.length, 2); assert.equal(result.deadCode.length, 1); assert.equal(result.analysisScope, 'single-file'); assert.equal(result.semanticWorkspace, false);
});
test('real local Roslyn verifies syntax, unreachable code and unused private members', { skip: !process.env.REVIEW_ROSLYN, timeout: 90000 }, async () => {
    const result = await new Roslyn(process.env.REVIEW_ROSLYN).probe();
    assert.equal(result.initialized, true); assert.equal(result.syntaxDiagnosticsVerified, true); assert.equal(result.deadCodeDiagnosticsVerified, true);
    assert.ok(result.deadCodeCodes.includes('IDE0035')); assert.ok(result.deadCodeCodes.includes('IDE0051')); assert.equal(result.semanticWorkspace, false);
});
