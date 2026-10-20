# Browser Roslyn feasibility probe

This standalone probe exercises browser-local compiler diagnostics; it is not the extension's review UI or its semantic-equivalence test suite. It requires Node.js 22+ and Windows with Microsoft Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. The browser path is hard-coded in `test.mjs`.

From the repository root:

```powershell
npm ci --prefix browser-roslyn
npm run test:browser-roslyn
```

The probe starts an ephemeral loopback server, launches headless Edge, initializes WasmSharp 0.10.2 in a dedicated worker and requests diagnostics without executing the C# fixtures. All non-loopback network requests are blocked and asserted absent. No native .NET SDK is required.

The test asserts `CS1525` syntax errors and `CS0162` unreachable-code warnings. It records whether the unused-private-member fixture emits `IDE0051`; the compiler-only probe does not include desktop IDE analyzers or solution context. Successful results are written to the ignored `browser-roslyn/results.json`.

Native browser ESM needs two packaging adaptations to the upstream npm package: extensionless module imports must resolve to `.js`, and bundler-style binary asset imports in `dotnet.js` must become same-origin URLs rather than JavaScript module imports. Comlink is served from its local dependency instead of the package's unpkg URL. The production Azure-tab build applies these adaptations to copied vendor assets and retains licenses.

The loopback probe does not require cross-origin isolation or SharedArrayBuffer. It does not verify a deployed Azure organization's iframe, CSP, Permissions Policy or installed extension version; those require checks against the actual installation. The extension has a separate opt-in CDN test described in its [README](../azure-tab/README.md#validation-and-third-party-components).
