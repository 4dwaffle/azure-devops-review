# Azure DevOps Filtered Review

A privately distributed Azure DevOps extension that adds a **Filtered Review** pull-request tab beside Azure's native **Files** tab. The GitHub repository is public; the extension manifest has `public: false`. The former GitHub Copilot Canvas runtime has been removed and is no longer packaged.

## Features

- Read-only Monaco diffs of immutable merge-base and source commits, with side-by-side and inline layouts.
- Configurable ignores for generated code, designers, migrations, resources, custom path globs, file moves, and project-reference path renames.
- Optional JSON formatting-only and namespace-propagation text filters. C# formatting, using-directive, and reference edits stay visible unless an explicit ignore policy matches the file.
- Dependency diagrams for changed manifests and explicit C# imports.
- Durable browser-local file and folder review progress.
- Inline comment drafts with explicit publication, snapshot validation, cross-tab locking, and uncertain-write recovery.

The extension does not replace Azure's Files tab, synchronize native reviewed state, or invoke an AI agent. Ordinary browsing, filtering, progress, and diagrams do not write to Azure. Comment publication is explicit and requires `vso.code_write`.

See [extension documentation](azure-tab/README.md) for installation, filter semantics, limitations, and comment recovery. Download CI-produced packages from [GitHub Releases](https://github.com/4dwaffle/azure-devops-review/releases).

## Develop and package

Requires Node.js 22+ (CI uses Node.js 24). From the repository root:

```powershell
npm ci
npm ci --prefix azure-tab
npm test
npm run build
npm run package
```

`npm test` runs the shared analysis tests and the extension suite. Browser tests require Windows with Microsoft Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. Browser launch paths are hard-coded in the tests; `REVIEW_BROWSER` does not override them. Tests use local fixtures and mocked comment writes. No .NET SDK is required.

`npm run build` bundles the tab and browser workers; `npm run package` rebuilds them and creates a self-contained VSIX under `azure-tab\artifacts`. Packaging needs Node.js and the root/extension dependencies, without Edge. The source manifest is `azure-tab\vss-extension.json`; `vss-extension.package.json` is generated and must not be edited. Bundled assets include their license notices. Uploading, organization sharing, and installation are separate manual operations described in the extension documentation.

## Repository layout

| Path | Purpose |
| --- | --- |
| `azure-tab/` | Azure DevOps SDK integration, review UI, browser workers, manifest, build, and extension tests |
| `analysis.mjs`, `generated-code.mjs` | Shared conservative change classification and generated-code helpers |
| `ui/` | Dependency-diagram and path-change helpers used by the extension |
| `tests/` | Shared analysis tests and browser-test fixtures |

## CI and releases

[CI](.github/workflows/ci.yml) runs for pull requests to `main`, merge groups, and manual dispatch. It tests shared logic and the extension, then uploads one VSIX and `SHA256SUMS.txt` as the `release-packages` workflow artifact.

[CD](.github/workflows/cd.yml) runs on pushes to `main`, reuses CI with an allocated release version, and publishes the validated VSIX and checksums to a versioned GitHub Release. Local packaging uses the source manifest's version; CD overrides the generated package manifest's version. GitHub release versions and manually uploaded Marketplace versions can therefore differ. Check the [workflow runs](https://github.com/4dwaffle/azure-devops-review/actions) for validation and publication status.

The workflows do not publish to the Marketplace or install the extension in an organization. No Copilot Canvas archive is produced.
