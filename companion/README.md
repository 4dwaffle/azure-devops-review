# Experimental local compiler companion

The optional companion verifies repeated C# reference renames using **explicitly trusted, complete before/after compiler profiles**, including unchanged sources and project-specific metadata references. It supplements the **Filtered Review Azure tab**, not the desktop canvas or a Roslyn language server. Browser verification remains the default. No inference is involved.

## Start and connect

Requires Node.js 22+, Git, and a stable .NET 10 SDK. From the extension root:

```powershell
Push-Location companion
dotnet build ReviewCompiler.csproj --nologo -v:q
Pop-Location
node companion\serve.mjs companion\profiles\my-pr.json
```

Prepare the trusted profile described below first. The profile directory is ignored by Git; never commit machine-specific paths, generated sources, references or private PR snapshots. Build **this trusted companion project only**. Do not build an untrusted PR or evaluate its project files to discover configuration.

Copy the printed private `http://127.0.0.1:<port>/<capability>/verify` URL into **Filtered Review → Ignore filters → Local compiler companion → Apply**. A snapshot mismatch keeps candidates visible. Clear the field and Apply to disable it. The browser remembers the URL locally; treat it as a capability secret, do not share it or include it in screenshots. Restarting the companion creates a new URL. Stop it with Ctrl+C; there is no installed background service.

Allow your browser's ordinary local-network permission if you deliberately want this connection. Never disable browser security or bypass a warning. A real Edge test verifies HTTPS access from a synthetic gallery-origin document and a cross-origin Azure-like parent iframe, with and without an explicit iframe allow attribute after permission is granted. Permission denial keeps all unverified candidates visible. This does **not** prove the signed-in, deployed Azure host's CSP, Permissions Policy or enterprise policies permit access; a host restriction cannot be fixed by the companion.

## Trusted profile contract

Profiles are JSON with **exactly** these top-level fields:

| Field | Required value |
| --- | --- |
| `version` | `1` |
| `repositoryRoot` | Local Git repository path; relative paths resolve against the profile directory |
| `repositoryId` | Azure repository ID matching the tab's immutable snapshot |
| `base` | Full lowercase 40-character merge-base commit SHA, not the moving target branch tip |
| `source` | Full lowercase 40-character PR source commit SHA |
| `allowedOrigins` | Explicit list of permitted origins, e.g. the exact gallery CDN iframe origin; no paths or wildcards |
| `before`, `after` | Complete project/target arrays for those commits; IDs must agree across snapshots |

Each project/target has this shape (illustrative paths and hashes must be replaced):

```json
{
  "id": "app-net10-debug",
  "assemblyName": "Example.App",
  "complete": true,
  "sources": [
    { "path": "src/Example.cs", "compilerPath": "C:\\trusted-build\\src\\Example.cs" },
    { "path": "obj/Example.GlobalUsings.g.cs", "compilerPath": "C:\\trusted-build\\obj\\Example.GlobalUsings.g.cs", "generatedText": "global using System;" }
  ],
  "references": [
    { "path": "C:\\trusted-reference-pack\\System.Runtime.dll", "sha256": "REPLACE_WITH_64_HEX_DIGITS" }
  ],
  "projectReferences": [],
  "options": {
    "languageVersion": "14.0",
    "documentationMode": "Parse",
    "symbols": ["DEBUG", "TRACE"],
    "outputKind": "DynamicallyLinkedLibrary",
    "optimizationLevel": "Debug",
    "nullableContextOptions": "Enable",
    "allowUnsafe": false,
    "checkOverflow": false,
    "platform": "AnyCpu",
    "usings": [],
    "warningLevel": 4,
    "metadataImportOptions": "Public"
  }
}
```

- `complete: true` is **your explicit attestation**, not automatic project discovery or proof that omitted sources/options do not matter. Include every source, generated output, metadata reference and owning target needed for the actual compilation. Use a separate stable project ID for each target/configuration; every declared owner must verify a candidate. Project references are IDs within the same snapshot. Missing or cyclic graphs are rejected.
- Ordinary sources are read from immutable Git blobs using `path`, never the working directory. Git-relative paths use `/` and cannot contain traversal. `compilerPath` is the exact effective compiler source path and is separate from Git identity: it affects observable `CallerFilePath`. Do not guess it from a renamed Git path. Supply exact trusted generated output through `generatedText`; generators are never executed.
- Metadata reference paths resolve against the profile directory. Pin every file's SHA-256, obtainable with `Get-FileHash -Algorithm SHA256`. Bytes are verified for each compilation and used only as Roslyn metadata, not loaded as executable assemblies.
- All listed compiler options are required, must match between before/after projects, and use case-sensitive .NET enum names. Unknown fields, missing inputs and changed switches are rejected rather than silently defaulted. A trusted profile must accurately match the companion's installed Roslyn compiler version and supported configuration.
- Unsupported configurations include signing, reference aliases/embed-interop settings, custom resolvers/path maps not representable by the exact effective source paths, script submissions, additional compiler switches and analyzer/generator execution. Do not attest completeness for these cases. Non-C# projects are not compiled. No MSBuild imports, tasks, property functions or PR-controlled commands are evaluated.

The worker validates both full declared graphs before checking candidates. Project dependencies are emitted only to memory for metadata references; emitted PR assemblies are never invoked. Verification checks mapped and unchanged bindings and implicit caller arguments, **not whole-program behavioral equivalence**. Rename declarations, changed `nameof`, ambiguous/dynamic bindings, changed caller defaults and mixed edits remain visible. Reflection and the renamed type's own behavior still require review.

## Transport and fallback

The server binds only `127.0.0.1` on an ephemeral port, uses a fresh 256-bit capability route, checks Host and allowlisted browser origins, and accepts no cookies or credentials. The browser sends repository/commit identities, Git paths and content hashes—not source text, local paths or compiler references. Proof must match both content hashes and the current lexical rename candidate. Duplicate/stale/unsupported results are rejected.

Browser and native verification run concurrently. An unconfigured URL performs no request. Busy, stopped, inaccessible, invalid or stale companions leave browser verification active and unknown changes visible. The server accepts one verification at a time, limits request bodies to 2 MiB and native payload/output to 64 MiB, and stops a compiler process after 30 seconds. Profiles allow up to 300 projects per snapshot, 10,000 sources per project and 20,000 total source entries across snapshots; bounded references and process limits may reject large contexts conservatively.

## Validation status

Tests use temporary immutable Git repositories and trusted synthetic sources, not private application code. Native tests cover a 256-file PR beyond the browser binding limit, unchanged supporting sources, pinned references, project graphs, multiple owners, exact compiler paths and incomplete configuration. Real Edge verifies **252 safe references ignored / 4 origin, caller-info and mixed-edit files visible**, plus stale/unreachable endpoints and explicit disabling. .NET-dependent tests skip when no stable .NET 10 SDK is installed; browser client unit tests remain runnable.

**PR 2620 has not been verified with the companion.** No trusted complete profile for that real PR has been prepared. Its previously reported cached namespace-filter benchmark is separate text-only filtering, not native compiler evidence.
