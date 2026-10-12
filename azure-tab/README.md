# Azure DevOps Filtered Review

Private, read-only Azure DevOps extension adding a **Filtered Review** pull-request tab beside the native **Files** tab. This does not replace or modify Azure's built-in Files component.

## Build and install

Requires Node.js 22+.

```powershell
npm ci
npm test
npm run package
```

The package appears under `artifacts`. `build.mjs` generates `vss-extension.package.json` from the source manifest, enumerating assets with explicit WASM MIME types; do not edit the generated manifest. License texts for bundled npm packages and shipped .NET/Roslyn/Humanizer assemblies are retained under `dist/licenses`. The manifest uses the Marketplace publisher `VaclavBerny`. For another publisher, change the ID in `vss-extension.json`, then rebuild. Keep `public: false`; upload the VSIX privately to that publisher, share it with your organization, and install it through Organization settings → Extensions. No upload, sharing or organization installation is performed by these scripts. The only requested Azure scope is read-only `vso.code`.

Current PR discovery first checks SDK configuration, then the documented host navigation route's `pullRequestId`. If that host does not expose the ID, an explicit PR-ID form is shown. The private extension is installed in `Copeland-MikAssembly`. Version 0.1.1 fixes commit descriptors that previously omitted source/target versions from the SDK's serialized diff request, producing an empty default-commit comparison. Live read-only API checks on PR 2619 confirm that explicit immutable commit versions return changes. Host PR-context shape and organization iframe/CSP behavior still require live UI verification. A successful mocked browser test or VSIX build is not proof of live Azure UI behavior.

## Review

- Immutable source and target commits from PR metadata; `diffCommonCommit: true`, paginated diff results and an explicit merge base. Files are loaded from the merge-base and source commits, never moving branch refs.
- Monaco read-only diffs with a **View** selector for side-by-side or inline layout, remembered across files and reloads. Drag the file-tree divider to resize the sidebar, or focus it and use arrow keys (Shift for larger steps), Home/End; double-click resets. Width is remembered and clamped to the available viewport. Reviewed counts and the progress meter appear at the left of the toolbar. Original rename paths and Git blob identities/modes come from immutable metadata. Binary, symlink and non-regular Git objects direct you to native Files. Failed reads remain visible and cannot be silently marked viewed.
- The compact toolbar avoids repeating Azure’s PR title. **Ignore filters** opens a popover. Resource files, formatting-only, using-directive-only, repeated rename references, generated code, designers, migrations and custom globs are configurable. **Show ignored** does not change progress totals.
- The file tree uses nested indentation, collapsible directory icons and file-type icons. Folder selection includes matching descendants; search reveals collapsed matches.
- Counts are `reviewed non-ignored / non-ignored · ignored`. Search also does not change these totals. Select individual files or folders, **Select all**, then mark the selection reviewed/unreviewed in one atomic browser-storage write, without a 20-file limit.
- Browser-local progress is scoped to organization, user, repository and PR. Contents, rename paths and Git modes invalidate reviewed fingerprints; unrelated PR updates do not erase unchanged files. Clearing site storage removes progress. This is not synchronized with Azure's native viewed state or the Copilot canvas's local progress.
- **Dependencies** displays declared dependency changes independently of ignore filters. This is not a full code call graph or transitive dependency graph.
- Existing file and general review comments are displayed as plain text. Azure system activity (such as branch updates) is hidden; human replies in mixed threads remain visible. Iteration context is available on hover rather than repeated headings. Comment publication is deliberately absent.
- The embedded tab does not duplicate Azure’s PR title or state badges.
- Shortcuts: `Ctrl+P` search, `J`/`K` next/previous file, `V` toggle viewed. Editor input keeps Monaco's own key handling. Next/previous diff buttons navigate changed hunks.

## Automatic browser Roslyn verification

There is no diagnostics button. Lexical analysis proposes C# formatting, using-directive and repeated-rename candidates; a dedicated worker automatically initializes pinned WasmSharp 0.10.2 and the packaged .NET/Roslyn runtime only when candidates exist. While verification is pending, files remain visible and navigation stays responsive. There is no inference or external code transport.

The trusted shipped C# analyzer receives all PR text as base64-encoded data. Only that analyzer is executed; PR code is parsed, bound and emitted in memory, never loaded or invoked.

- Formatting/using-only candidates are compiled as libraries with packaged references. All emitted assembly bytes must match except the random module GUID and PE timestamp. IL, metadata, attributes and caller-info constants remain part of the comparison.
- Repeated type-rename candidates require both changed-file snapshots to compile and each changed identifier to bind to the mapped old/new type. Unchanged name/type bindings must also agree under that mapping. Declaration origins remain visible. This is reference-binding verification, not a claim that the renamed type itself preserves behavior.
- Syntax errors, preprocessor directives, missing references, ambiguous/shadowed renames and observable nameof rename changes are not verified. Unknown files stay visible. Worker/runtime failures, a 60-second timeout, more than 250 C# files, or over 4 million source characters also keep candidates visible.

**Scope limitation:** this is a changed-file snapshot with packaged framework references, not the repository’s complete project compilation. Unchanged source files, project-specific references, build options, source generators and IDE analyzers are not loaded. Successful verification describes this browser compilation context, not a proof of whole-solution behavior or unused/dead-code detection. Explicit resource/generated/designer/migration/custom-glob ignores remain user policy, not semantic proof. Mode changes always remain visible.

Assemblies, runtime, Comlink and Monaco workers are packaged locally. The organization's iframe/CSP must allow same-origin module workers and WASM. No SharedArrayBuffer or cross-origin isolation is required by the tested runtime. The desktop language-server executable is not used in the iframe.

## Conservative classification

Generated filename/header conventions are recognized. Relevant ancestor `.editorconfig` and root `.globalconfig` files are fetched from both immutable commits. If any explicit `generated_code` setting or uncertain configuration read is encountered, generated candidates stay visible with a warning rather than attempting incomplete EditorConfig semantics. This is more conservative than the desktop canvas's complete EditorConfig support. Designer/migration filters remain separately user-controlled.

This browser-only extension has no local Git/worktree access, Copilot CLI bridge, automatic inference, comment writes or remote progress synchronization. Those remain in the existing local canvas. Ordinary file navigation, filtering, progress and dependency diagrams require no agent inference.

## Validation and third-party components

`npm test` exercises pure pagination/progress logic and a real headless Microsoft Edge browser (`C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe`). Browser tests use a mocked read-only Azure client and real Monaco, analysis workers and packaged Roslyn assets. Diff requests additionally pass through the installed `GitRestClient` serializer, asserting actual version query parameters rather than only mock argument shapes. Regression tests cover Azure’s string-valued change enums, nested tree navigation, header-free layout, automatic Roslyn filtering, missing references, changed bindings, caller line numbers, directives, shadowed renames, safe PR-data encoding and runtime/size-limit fallback. No tests post Azure comments or publish/install the extension.

Uses Microsoft's MIT-licensed Azure DevOps extension SDK/API and Monaco, and Apache-2.0-licensed WasmSharp with .NET/Roslyn components. Bundled legal comments are retained; shipped vendor runtime files retain their original headers. See `dist/licenses` for included license notices.
