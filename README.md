# Azure DevOps Filtered Review

A private Azure DevOps extension that adds a **Filtered Review** pull-request tab beside Azure's native **Files** tab. This repository is focused on the Azure DevOps extension; the former Copilot canvas runtime is no longer included or packaged.

## Features

- Read-only Monaco diffs of immutable merge-base and source commits, with side-by-side and inline layouts.
- Configurable ignore filters for generated code, designers, migrations, resources, formatting, and conservative rename propagation.
- Browser Roslyn verification; unresolved or unsupported changes remain visible.
- Dependency diagrams for changed manifests and explicit C# imports.
- Durable browser-local file and folder review progress.
- Inline comment drafts with explicit publication, snapshot validation, cross-tab locking, and uncertain-write recovery.

The extension does not replace Azure's Files tab, synchronize native reviewed state, or invoke an AI agent. Ordinary browsing, filtering, progress, and diagrams do not write to Azure. Comment publication is explicit and requires `vso.code_write`.

See [extension documentation](azure-tab/README.md) for installation, filter semantics, limitations, comment recovery, and published versions.

## Develop and package

Requires Node.js 22+. From the repository root:

```powershell
npm ci
npm ci --prefix azure-tab
npm test
npm run build
npm run package
```

`npm test` runs the shared analysis/companion tests and the extension suite. Browser tests use Microsoft Edge; set `REVIEW_BROWSER` to another Chromium executable if needed. Tests use local fixtures and mocked comment writes, not unsolicited Azure comments. Native companion tests require the .NET 10 SDK and Git; unavailable prerequisites can cause tests to skip.

`npm run package` builds the self-contained VSIX under `azure-tab\artifacts`. The source manifest is `azure-tab\vss-extension.json`; `vss-extension.package.json` is generated and must not be edited. Bundled assets include their license notices. Keep the extension private; uploading, organization sharing, and installation are separate manual operations described in the extension documentation.

## Repository layout

| Path | Purpose |
| --- | --- |
| `azure-tab/` | Azure DevOps SDK integration, review UI, browser workers, manifest, build, and extension tests |
| `analysis.mjs`, `generated-code.mjs` | Shared conservative change classification and generated-code helpers |
| `ui/` | Dependency-diagram and path-change helpers used by the extension |
| `tests/` | Shared analysis tests, optional compiler tests, and browser-test fixtures |
| `companion/` | Optional trusted local compiler verification for the Azure tab |
| `browser-roslyn/` | Standalone browser Roslyn feasibility probe |

The [optional compiler companion](companion/README.md) supplements browser verification using explicitly trusted complete compiler profiles. It never executes PR build logic and is not required to use or package the extension.

The standalone [browser Roslyn probe](browser-roslyn/README.md) has its own dependencies:

```powershell
npm ci --prefix browser-roslyn
npm run test:browser-roslyn
```

## CI and releases

CI validates shared logic, the native companion, the Azure DevOps extension, and the browser Roslyn probe, then builds and packages one VSIX with SHA-256 checksums. CD runs the same validation on `main` and publishes the VSIX and checksums to a versioned GitHub Release. No Copilot canvas archive is produced. These workflows do not publish to the Marketplace or install the extension in an organization.
