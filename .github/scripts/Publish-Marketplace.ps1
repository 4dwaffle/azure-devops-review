[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $PackageDirectory,
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string] $Version,
    [switch] $VerifyOnly
)

$ErrorActionPreference = 'Stop'
$packages = @(Get-ChildItem -LiteralPath $PackageDirectory -Filter '*.vsix' -File)
if ($packages.Count -ne 1) { throw 'Expected one Azure DevOps VSIX.' }
$package = $packages[0]
$checksum = Get-Content -LiteralPath (Join-Path $PackageDirectory 'SHA256SUMS.txt')
$hash = (Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash
if (@($checksum).Count -ne 1 -or $checksum -cnotmatch ('^(?i:' + $hash + ')  ' + [regex]::Escape($package.Name) + '$')) {
    throw 'VSIX checksum does not match SHA256SUMS.txt.'
}

$archive = [IO.Compression.ZipFile]::OpenRead($package.FullName)
try {
    $entry = $archive.GetEntry('extension.vsixmanifest')
    if (!$entry) { throw 'VSIX manifest is missing.' }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { [xml] $manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $metadata = $manifest.PackageManifest.Metadata
    if ($metadata.Identity.Id -cne 'azure-filtered-review' -or $metadata.Identity.Publisher -cne 'VaclavBerny') {
        throw 'Unexpected VSIX publisher or extension ID.'
    }
    if ($metadata.Identity.Version -cne $Version) { throw 'VSIX version does not match the release version.' }
    if ([string] $metadata.GalleryFlags -match 'Public') { throw 'The Marketplace extension must remain private.' }
} finally { $archive.Dispose() }

Write-Host "Verified private VaclavBerny.azure-filtered-review $Version and its SHA256 checksum."
if ($VerifyOnly) { return }
if (!$env:VS_MARKETPLACE_TOKEN) {
    throw 'Set the VS_MARKETPLACE_TOKEN Actions secret with Marketplace publishing access to publisher VaclavBerny.'
}

$tfx = Join-Path $PSScriptRoot '../../azure-tab/node_modules/tfx-cli/_build/tfx-cli.js'
$auth = @('--auth-type', 'pat', '--token', $env:VS_MARKETPLACE_TOKEN, '--no-prompt', '--json')

# This extension already exists. Query failures must stop publication, including expired credentials.
$infoJson = & node $tfx extension show --vsix $package.FullName @auth
if ($LASTEXITCODE -ne 0) { throw 'Could not query the existing Marketplace extension.' }
$info = $infoJson | ConvertFrom-Json
if ($null -eq $info.flags -or !$info.versions) { throw 'Unexpected Marketplace extension response.' }
if (([int] $info.flags -band 256) -ne 0) { throw 'The existing Marketplace extension must remain private.' }

# A rerun keeps the same version. Do not try to upload an immutable version twice.
if (@($info.versions | Where-Object version -CEQ $Version).Count -eq 0) {
    & node $tfx extension publish --vsix $package.FullName @auth
    if ($LASTEXITCODE -ne 0) { throw 'Marketplace publication failed.' }
} else {
    Write-Host "Marketplace version $Version already exists; checking validation."
}

# isvalid can exit successfully with status pending/error, so inspect its JSON result.
$statusJson = & node $tfx extension isvalid --vsix $package.FullName --version $Version @auth
if ($LASTEXITCODE -ne 0) { throw 'Could not query Marketplace validation.' }
$status = $statusJson | ConvertFrom-Json
if ($status.status -cne 'success') { throw "Marketplace validation is $($status.status): $($status.message)" }
Write-Host "Marketplace version $Version is validated. No organization installation was requested."
