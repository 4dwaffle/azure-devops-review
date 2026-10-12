# Browser Roslyn verification

Run `npm ci` then `npm test` on Windows with Microsoft Edge installed. The probe starts an ephemeral loopback server, launches actual headless Edge, initializes WasmSharp 0.10.2 in its real dedicated worker and requests diagnostics without executing the C# fixtures. All non-loopback network requests are blocked and asserted absent.

Verified `CS1525` syntax errors and `CS0162` unreachable-code warnings. The fixture for an unused private member does **not** emit `IDE0051`: this is compiler-only single-file analysis, not the desktop IDE analyzer integration or a solution-aware language server. Successful results are written to `results.json`.

Native browser ESM needs two packaging adaptations to the upstream npm package: extensionless module imports must resolve to `.js`, and bundler-style binary asset imports in `dotnet.js` must become same-origin URLs rather than JavaScript module imports. Comlink is served from its local dependency instead of the package's unpkg URL. The production Azure-tab build applies these adaptations to copied vendor assets and retains licenses.

No cross-origin isolation or SharedArrayBuffer configuration was needed for the verified worker. Azure organization's iframe/CSP policy still needs verification after installation.
