const deadCodeCodes = new Set(['CS0162', 'CS0169', 'CS0219', 'CS0414', 'IDE0035', 'IDE0051', 'IDE0052', 'IDE0059']);
export function deadCodeDiagnostics(items) { return items.filter(item => deadCodeCodes.has(String(item.code))); }
export function diagnosticMarkers(monaco, items) {
    const severities = { 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint };
    return items.filter(item => item.range?.start && item.range?.end).map(item => ({
        startLineNumber: item.range.start.line + 1, startColumn: item.range.start.character + 1,
        endLineNumber: item.range.end.line + 1, endColumn: item.range.end.character + 1,
        message: item.message, code: item.code == null ? undefined : String(item.code), source: item.source || 'Roslyn',
        severity: severities[item.severity] || monaco.MarkerSeverity.Info,
        tags: item.tags?.includes(1) ? [monaco.MarkerTag.Unnecessary] : []
    }));
}
