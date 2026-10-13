# Azure DevOps Review canvas

A user-scoped, local-first pull-request review surface for GitHub Copilot CLI's Canvas runtime. The UI and HTTP service handle ordinary browsing independently of the agent. Only the explicit **Ask Copilot** action submits a prompt.

## Installation and connection

This extension is installed under `%USERPROFILE%\.copilot\extensions\azure-devops-review` (or `$COPILOT_HOME\extensions\azure-devops-review`). It is available across repositories on this machine. It does not modify the repository or register an external web service.

An experimental [local compiler companion](companion/README.md) is available for the separate **Filtered Review Azure tab**. It uses explicitly trusted complete compiler profiles and immutable Git sources, never executes PR build logic, and keeps browser-only verification as the fallback. It is not automatically connected to this canvas.

Prerequisites: the Copilot Canvas extension runtime, Node.js, Git, and an authenticated Azure CLI account with access to the Azure DevOps organization. Authentication uses `az account get-access-token` for resource `499b84ac-1321-427f-aa17-267ca6975798`. Access tokens remain in provider memory and are never sent to the browser or written to review state. If the Azure CLI executable is not discoverable, set `AZURE_CLI_PATH` to its absolute executable path before starting Copilot.

Dependencies are pinned in `package-lock.json`. For reinstalling, run `npm ci` in the extension directory, then reload extensions. The Copilot SDK is provided by the runtime; do not install a separate SDK dependency.

Open **Azure DevOps Review**. In Settings, enter the organization slug and absolute local checkout roots, one per line. A root may be an individual checkout or a folder whose immediate children are checkouts. Linked Git worktrees are discovered through `git worktree list`. Discovery does not recursively scan the whole machine.

## Reviewing

- Active PRs are listed across organization repositories visible to your account, with filters for title, repository, author, and PR number. Listing failures are reported per repository.
- Click a PR and use its changed-file tree. The canvas prefers a matching source branch, then a worktree at the source SHA, then a configured checkout.
- The comparison is **Git merge-base(target, source) → source**, not a two-dot target diff. Files are read from immutable Git objects, never from uncommitted working files.
- Git-detected path changes distinguish **Renamed**, **Moved**, and **Moved + renamed**. Row tooltips and the selected-file toolbar show the original → destination path; search matches either path. Content edits remain in the diff, and mode changes cannot be hidden as pure file moves.
- Missing commits are reported. **Fetch refs** requires confirmation and downloads only the PR refs; no automatic clone, fetch, branch switch, or checkout is performed.
- Mark files viewed directly with the **Reviewed** checkbox on the left of each file row. There is no file multiselect; opening a file does not mark it viewed. Progress survives closing the panel, extension reloads and app restarts. Failed saves restore the persisted checkbox state. A file is automatically unviewed when its blob identities, paths, or modes change. No supported public integration with Azure's built-in Files reviewed state was found; these stores remain independent.
- Existing Azure threads and local drafts appear in the discussion panel. Historical or unverified coordinates are not decorated onto current code.
- Select a range in either diff pane to draft an inline comment or ask Copilot for read-only analysis. Copilot also supports the entire current file. Reviewed checkboxes track progress, not Copilot file selections. Drafting remains local. Ask Copilot is the only interaction that invokes agent inference; normal file navigation and progress updates do not.

Two Monaco models are kept alive, disposing the previous pair on navigation. Saved file view states are bounded to 100. Binary and >8 MB files are not rendered but can be marked viewed; Gitlinks show their subproject commit SHA. Fork PRs and ambiguous multiple merge bases are not supported for local comparison.

### Pull request views

The PR dropdown offers **Active**, **My drafts**, **I'm a reviewer (active)**, **Completed**, **Abandoned** and **All** across accessible repositories. Personal views resolve the Azure DevOps authenticated identity (not display-name matching), then use the documented `searchCriteria.creatorId`/`searchCriteria.reviewerId` queries. My drafts includes only active PRs authored by you with `isDraft = true`; reviewer results retain all active PRs returned by Azure DevOps's reviewer query, including drafts. Pagination uses the raw page length before draft filtering. Identity failures do not silently fall back to everybody's PRs. These operations are read-only and inference-free.

### Review filters and dependency diagrams

The editor, gutters, minimap and widgets follow the app's semantic theme tokens, including live light/dark changes. There is no separate editor backdrop or whole-line added/deleted fill; inline diff text highlighting remains available.

**Review progress:** click the left-side Reviewed checkbox to mark or unmark a file independently of navigation. Folder checkboxes mark or unmark every non-ignored descendant, including collapsed and search-hidden files. A mixed checkbox means only some descendants are reviewed. Ignored files remain untouched even when shown; folders with missing file fingerprints cannot be marked. Folder updates are saved atomically and failed writes restore the persisted state without expanding the folder. Search and Show ignored do not change reviewable totals; ignored files retain their progress. Normal navigation/progress actions do not invoke inference or write to Azure. Copilot remains available for the current file or selected code range. Only draft PRs display a Draft badge.

**Designer files** (`*.Designer.*`) and files under **Migrations** directory segments (including migration designers and model snapshots) are independently ignored by default, case-insensitively. These path-based preferences apply immediately without Roslyn or generated-code analysis, even when `.editorconfig` marks a designer file handwritten. Disable either option in **Review filters**, or use **Show ignored files** to inspect hidden changes. File-mode changes and renames crossing either category remain visible. Custom migration folder names can use additional ignore globs.

**Review filters** persists user preferences across panels and restarts. Options cover resource files (`.resx`, `.resources`, `.xlf`/`.xliff`, `.po`/`.pot`, resource wrappers), formatting-only C#/valid JSON, C# using-directive-only changes, detected type-/namespace-rename-only references, generated code, and additional Git-relative globs such as `**/*.Designer.cs`. Previous/next navigation respects these filters. **Show ignored files** reveals the files with their reasons; ignoring never marks a file viewed or deletes drafts/progress.

Generated-code suppression is **on by default**, including for existing preferences. It uses the filename conventions verified in [Roslyn's generated-code utility](https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/SourceGeneration/GeneratedCodeUtilities.cs): `TemporaryGeneratedFile_` prefixes and `.designer`, `.generated`, `.g`, `.g.i` before the extension, case-insensitively. Leading regular C#/VB comments containing case-sensitive `<autogenerated` or `<auto-generated` are recognized within the first 65,536 characters; strings, documentation comments, later comments and member-level `[GeneratedCode]` attributes do not hide a file. Repository `.editorconfig` `generated_code = true/false` overrides are evaluated separately against merge-base and source snapshots, including nested configs, root boundaries, section globs and unset values. Existing files hide only when **both** versions are generated; additions/deletions use their existing side. Mode changes stay visible. Up to 200 configuration files per snapshot and 256 KB per file are read with bounded concurrency. Unreadable configurations or global analyzer configs with generated-code settings conservatively keep files visible. External/MSBuild-supplied analyzer configs, source-generator outputs absent from Git and header recognition through preprocessor directives are not evaluated. This is **local convention/configuration detection**, not a new LSP capability or semantic symbol analysis; the language server is not required.

Type-rename reference suppression is **on by default**; namespace text-only suppression is a separate **off-by-default** preference. Type mappings are inferred from corresponding class/record/struct/interface/enum declarations; namespace mappings require exact token-equivalent relocation with matching declarations. Conflicting namespace mappings and ambiguous deleted/added basename matches remain visible. Declaring files stay visible. Reference files hide only when their token differences consist entirely of those detected identifier substitutions. Mixed edits, changed comments/literals, ambiguous mappings, preprocessor/interpolated syntax and oversized files stay visible. Pure file moves require identical blob **and mode**. This is conservative **syntax-based detection, not Roslyn symbol-binding verification**; using changes also can change name resolution. Turn these options off when that distinction matters. Classification is limited to 200,000 characters per version and uses four concurrent immutable Git reads; unsupported files remain visible.

**Project-reference path renames** is a separate, default-on filter, including for older saved preferences. It remains enabled when C# rename, generated-code, formatting and using filters are disabled, and works with manifest-only analysis without loading C# sources. A unique project move/rename in the immutable diff must map each changed `ProjectReference Include` target, resolved relative to the old/new referring file. Everything outside the Include path must be byte-identical and valid XML. Changed conditions, metadata, packages, comments, unrelated paths, modes, read failures and ambiguous mappings stay visible. Dependency analysis remains independent.

**Namespace rename propagation (text-only)** is a separate, **off-by-default** policy in Review filters. It also covers namespace-only edits in renamed/moved declaration files. An unambiguous mapping must be inferred from matching declarations; both token comparison and exact source-text replacement must agree. Import-only changes can also use a validated leading using-directive header when the entire remaining body is byte-identical, including unchanged interpolated strings, directives or oversized bodies. This header-only match never claims a compiler-verified rename. Mixed edits, changed comments/literals, errors, mode changes and unsupported changes outside the header remain visible. Unchanged `#pragma warning` lines can be retained while validating all remaining tokens and exact namespace replacements; changed pragmas and conditional directives remain visible. This fallback is text-only and never enters compiler-verified rename filtering. Detected mappings are shown in the filter dialog. A visible candidate-count notice links to the filter when it is disabled; preferences are not enabled silently. This is not compiler verification: runtime binding, reflection, `nameof` and caller-information effects are not established. Review the origin and dependency diagrams before enabling it. Show ignored reveals every suppressed file; existing rename settings and review progress are unchanged.

**Dependency diagrams** automatically analyzes changed .NET project/props/targets manifests, `packages.config`, NuGet lockfiles, npm manifests and lockfiles, plus explicit C# using directives, independently of ignore preferences. The button shows the number of added/removed/modified declarations; affected manifest diffs also show a diagram link. C# import edges are syntax-only, not resolved type bindings. App-themed SVG graphs show packages/project references, versions, scopes and conditions, with before/after metadata in tooltips. Click the owner-file heading to open its immutable diff. Unchanged context is optional. Parsing errors and duplicate declarations produce manual-review warnings, not a claim of no changes. Diagrams are bounded to 50 connections per owner and 200 total, with at most 20 warnings displayed.

These graphs describe **manifest declarations and explicit imports in changed source files**, not a fully restored transitive graph. MSBuild conditions/property expressions are not evaluated, and dependencies changed indirectly through arbitrary build logic may require manual review. No restore, MSBuild execution, inference or remote write is triggered by filters or diagrams.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+P | Focus changed-file filter |
| Ctrl/Cmd+F (editor) | Search the current file in the focused diff pane; double-click a word first to prefill Find. Enter/Shift+Enter navigate matches; Escape closes Find. |
| Alt+Up / Alt+Down | Previous / next filtered file |
| F8 / Shift+F8 | Next / previous diff hunk |
| V (outside text inputs/editors) | Toggle file viewed |
| Ctrl/Cmd+M (either editor pane) | Draft comment on the selected code lines; also available via Add comment or the editor context menu |

## Publishing status and correctness

**Publishing is off by default and requires explicit Settings opt-in plus confirmation of each batch.** The REST contract is verified against Microsoft's [Create thread](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1) and [List threads](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list?view=azure-devops-rest-7.1) documentation, mock POST contract tests, and live read-only iteration/change-tracking calls. **No real comment POST has been tested and no test comments have been posted.** The UI exposes this limitation; this is not claimed as live write verification.

Use **Preview publish** for a read-only preflight, including the exact outgoing payloads. Publishing reruns the preflight and requires a matching digest of the confirmed drafts, preventing another session's newly added or changed comments from silently entering the batch. The implementation uses Azure DevOps REST API 7.1, the latest PR iteration, its `changeTrackingId`, the canonical current file path and the correct left/right range, with one-based lines and zero-based character offsets. Older whole-line drafts are normalized to this documented offset convention. Both comparing iteration IDs are the same current iteration, meaning common-base versus source. It rechecks active status, iteration, source, target and the Azure common commit against the local merge base immediately before publishing. Stale drafts are rejected.

Each outgoing draft is atomically claimed and durably marked `publishing` before POST. The response must preserve iteration IDs, tracking ID, file path and range. An uncertain or unexpected response blocks retries and draft deletion, preventing automatic duplicate comments. Verify the remote outcome before resolving such a draft; never blindly retry.

## Tested Canvas integrations

### Monaco

Monaco **0.52.2**, local AMD assets, and classic workers were tested with real Microsoft Edge against the loopback provider. Tests verify an actual worker response and a computed side-by-side diff, 70-file navigation, left/right selections, filtering, viewed progress, model disposal, app-token light/dark backgrounds, persistent ignore options, rename-only suppression, safe rendered dependency SVGs and exactly zero implicit inference calls. Monaco 0.55.1 was investigated but its changed worker packaging did not work with the classic-worker adapter; the extension intentionally uses the verified pinned version rather than synchronous fallback.

### Roslyn

A configured local `Microsoft.CodeAnalysis.LanguageServer.dll` can be launched using `dotnet` with stdio JSON-RPC. Set `roslynPath` in the persisted configuration to the installed DLL. The `probe_roslyn` canvas action launches a separate disposable fixture and verifies initialization plus an actual CS1002 syntax diagnostic, then stops the server and removes the fixture.

**Solution/project loading, semantic hover, definitions and project-wide diagnostics are not implemented or verified.** The UI calls this feature C# syntax diagnostics, not full IDE integration. Diagnostics for a PR file additionally require a clean tracked worktree at the exact source commit, avoiding analysis of another branch or uncommitted content. Roslyn and Monaco communicate through the local provider; there is no privileged iframe-to-host bridge.

## Persistence and local boundaries

Preferences and PR progress/drafts are stored as atomic JSON files under `artifacts`, keyed by organization/repository/PR rather than transient canvas instance IDs. Cross-process filesystem locks serialize writes from separate Copilot sessions; stale locks after abnormal termination expire after 60 seconds. Do not share this folder: it may contain private draft text and local paths. No Azure bearer token is persisted.

The HTTP server binds only to `127.0.0.1` on an OS-selected port. API paths require a random per-panel capability, reject foreign Origin/Host headers and cross-site fetches, and enforce request-size limits. Monaco assets are served locally. The browser does not need a cloud editor/CDN. Azure metadata still requires network access; the canvas is local-first, not a fully offline Azure client.

## Validation

Run `npm test` in this directory. `REVIEW_BROWSER` may specify an alternate Edge/Chromium executable for browser tests. Tests use disposable local Git repositories and mock publishing; they never post comments to a real PR. Runtime canvas actions: `diagnostics`, `probe_roslyn`, `list_pull_requests`, and `open_pull_request`.

## Upstream reuse and licenses

Microsoft's MIT-licensed [azure-devops-copilot-plugin](https://github.com/microsoft/azure-devops-copilot-plugin), pinned to revision `8f30ba3210758239be19e2143943e0830f07601a`, supplied the reusable PR normalization helpers in `reference/pull-request.mjs` and `reference/common.mjs`. `mapPullRequest` is imported directly, not just used as inspiration. Its original license is retained in `reference/LICENSE.txt`. The plugin's canvas approach informed the loopback architecture; this extension uses the current installed SDK canvas declarations and separately tested iteration-aware REST calls.

Monaco and Playwright dependencies retain their upstream licenses in their installed packages. No private repository code or credentials are included in upstream reference material.

### Dead-code diagnostics

Click **C# diagnostics + dead code** for the current C# file in a clean worktree at the reviewed source commit. The real local Roslyn server returns analyzer/compiler diagnostics, including unreachable code (IDE0035 / CS0162), unused private members (IDE0051 / IDE0052 / CS0169 / CS0414), unused locals (CS0219), and unnecessary assignments (IDE0059) when enabled by the server/configuration. Monaco preserves diagnostic severity, codes, and unnecessary-code tags; the status reports the dead-code finding count. The disposable runtime probe verifies IDE0035 and IDE0051 as well as syntax diagnostics.

This is explicitly **single-file analysis**, not a loaded solution-wide reference graph. Partial classes, project context, analyzer settings, reflection, and external consumers can limit conclusions. Public APIs are not classified as dead merely because no references are visible. Findings never automatically hide or mark files reviewed. Navigation remains inference-free, and analysis runs only when requested. Results arriving after navigation are discarded.
