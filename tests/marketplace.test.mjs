import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

const script = resolve(import.meta.dirname, '../.github/scripts/Publish-Marketplace.ps1');

async function publish(options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'review-marketplace-'));
  try {
    await mkdir(resolve(directory, 'fixture'));
    await writeFile(resolve(directory, 'fixture/extension.vsixmanifest'), `<?xml version="1.0"?>
<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata><Identity Id="${options.id ?? 'azure-filtered-review'}" Publisher="${options.publisher ?? 'VaclavBerny'}" Version="${options.version ?? '0.2.5'}"/><GalleryFlags>${options.public ? 'Public' : ''}</GalleryFlags></Metadata>
</PackageManifest>`);
    const runner = resolve(directory, 'run.ps1');
    await writeFile(runner, `param($PublishScript, $Directory)
$ErrorActionPreference = 'Stop'
$packages = New-Item -ItemType Directory (Join-Path $Directory 'packages')
$vsix = Join-Path $packages.FullName 'extension.vsix'
[IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $Directory 'fixture'), $vsix)
$hash = (Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash.ToLower()
if ($env:MOCK_BAD_CHECKSUM -eq 'true') { $hash = '0' * 64 }
"$hash  extension.vsix" | Set-Content (Join-Path $packages.FullName 'SHA256SUMS.txt') -Encoding ascii
if ($env:MOCK_EXTRA_PACKAGE -eq 'true') { Copy-Item -LiteralPath $vsix -Destination (Join-Path $packages.FullName 'other.vsix') }
function node {
  $command = $args[2]
  ConvertTo-Json -InputObject @($args) -Compress | Add-Content (Join-Path $Directory 'calls.jsonl')
  $global:LASTEXITCODE = 0
  if ($env:MOCK_FAIL -eq $command) { $global:LASTEXITCODE = 1; return }
  switch ($command) {
    show { @{flags = [int]$env:MOCK_FLAGS; versions = @(@{version = $env:MOCK_EXISTING_VERSION})} | ConvertTo-Json -Depth 5 -Compress }
    publish { '{"published":true}' }
    isvalid {
      $statuses = $env:MOCK_VALIDATION -split ','
      $index = [Math]::Min($script:validationCalls, $statuses.Count - 1)
      $script:validationCalls++
      if ($statuses[$index] -eq 'malformed') { return 'not-json' }
      @{status = $statuses[$index]; message = 'test validation result'} | ConvertTo-Json -Compress
    }
    default { throw "Unexpected TFX command $command" }
  }
}
$script:validationCalls = 0
function Start-Sleep { param($Seconds) Add-Content (Join-Path $Directory 'sleeps.txt') $Seconds }
& $PublishScript -PackageDirectory $packages.FullName -Version '0.2.5' -VerifyOnly:($env:MOCK_VERIFY_ONLY -eq 'true') -ValidationTimeoutSeconds ([int]$env:MOCK_VALIDATION_TIMEOUT)
`);
    let error;
    let output = '';
    try {
      output = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', runner, script, directory], {
        encoding: 'utf8',
        env: {...process.env,
          VS_MARKETPLACE_TOKEN: options.missingToken ? '' : 'test-token',
          MOCK_EXISTING_VERSION: options.existingVersion ?? '0.1.13',
          MOCK_FLAGS: String(options.flags ?? 0),
          MOCK_VALIDATION: options.validation ?? 'success',
          MOCK_VALIDATION_TIMEOUT: String(options.validationTimeout ?? 0),
          MOCK_FAIL: options.fail ?? '',
          MOCK_BAD_CHECKSUM: String(options.badChecksum ?? false),
          MOCK_EXTRA_PACKAGE: String(options.extraPackage ?? false),
          MOCK_VERIFY_ONLY: String(options.verifyOnly ?? false)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (failure) {
      error = failure;
      output = failure.stdout + failure.stderr;
    }
    const calls = await readFile(resolve(directory, 'calls.jsonl'), 'utf8').catch(failure => {
      if (failure.code === 'ENOENT') return '';
      throw failure;
    });
    const sleeps = await readFile(resolve(directory, 'sleeps.txt'), 'utf8').catch(failure => {
      if (failure.code === 'ENOENT') return '';
      throw failure;
    });
    return {error, output, sleeps: sleeps.trim() ? sleeps.trim().split(/\r?\n/).map(Number) : [], calls: calls.trim() ? calls.trim().split(/\r?\n/).map(line => JSON.parse(line)) : []};
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('Marketplace publishes the exact verified VSIX and waits for successful validation without installing or sharing', async () => {
  const result = await publish();
  assert.equal(result.error, undefined, result.output);
  assert.deepEqual(result.calls.map(args => args[2]), ['show', 'publish', 'isvalid']);
  const packagePath = result.calls[0][result.calls[0].indexOf('--vsix') + 1];
  for (const args of result.calls) {
    assert.equal(args[args.indexOf('--vsix') + 1], packagePath);
    assert.ok(args.includes('--no-prompt'));
    for (const flag of ['--share-with', '--rev-version', '--bypass-validation', '--bypass-scope-check']) assert.ok(!args.includes(flag), flag);
    assert.equal(args.includes('--no-wait-validation'), args[2] === 'publish');
  }
  const validation = result.calls.at(-1);
  assert.equal(validation[validation.indexOf('--version') + 1], '0.2.5');
});

test('Marketplace rerun validates an existing version without uploading it again', async () => {
  const result = await publish({existingVersion: '0.2.5'});
  assert.equal(result.error, undefined, result.output);
  assert.deepEqual(result.calls.map(args => args[2]), ['show', 'isvalid']);
});

for (const existingVersion of ['0.1.13', '0.2.5']) {
  test(`Marketplace waits for the exact version to validate without reuploading (existing ${existingVersion})`, async () => {
    const result = await publish({existingVersion, validation: 'pending,pending,success', validationTimeout: 900});
    assert.equal(result.error, undefined, result.output);
    assert.deepEqual(result.calls.map(args => args[2]), existingVersion === '0.2.5' ? ['show', 'isvalid', 'isvalid', 'isvalid'] : ['show', 'publish', 'isvalid', 'isvalid', 'isvalid']);
    assert.deepEqual(result.sleeps, [15, 15]);
    for (const args of result.calls.filter(args => args[2] === 'isvalid')) assert.equal(args[args.indexOf('--version') + 1], '0.2.5');
    assert.match(result.output, /Marketplace version 0\.2\.5 is validated/);
  });
}

test('Marketplace pending timeout fails with a same-version recovery instruction', async () => {
  const result = await publish({existingVersion: '0.2.5', validation: 'pending'});
  assert.ok(result.error);
  assert.match(result.output, /still pending validation after 0 seconds/);
  assert.match(result.output, /without uploading it again/);
  assert.doesNotMatch(result.output, /is validated/);
  assert.deepEqual(result.calls.map(args => args[2]), ['show', 'isvalid']);
  assert.deepEqual(result.sleeps, []);
});

test('CI can verify the private versioned package without credentials or publishing', async () => {
  const result = await publish({verifyOnly: true, missingToken: true});
  assert.equal(result.error, undefined, result.output);
  assert.deepEqual(result.calls, []);
});

for (const [name, options, message] of [
  ['missing credential', {missingToken: true}, /VS_MARKETPLACE_TOKEN/],
  ['tampered package', {badChecksum: true}, /checksum does not match/],
  ['public package', {public: true}, /must remain private/],
  ['wrong version', {version: '0.2.4'}, /version does not match/],
  ['wrong publisher', {publisher: 'OtherPublisher'}, /Unexpected VSIX publisher/],
  ['wrong extension', {id: 'other-extension'}, /Unexpected VSIX publisher/],
  ['ambiguous packages', {extraPackage: true}, /Expected one Azure DevOps VSIX/]
]) {
  test(`Marketplace rejects ${name} before any remote call`, async () => {
    const result = await publish(options);
    assert.ok(result.error);
    assert.match(result.output, message);
    assert.deepEqual(result.calls, []);
  });
}

for (const [name, options, commands] of [
  ['query failure', {fail: 'show'}, ['show']],
  ['public Marketplace listing', {flags: 256}, ['show']],
  ['publication failure', {fail: 'publish'}, ['show', 'publish']],
  ['validation query failure', {fail: 'isvalid'}, ['show', 'publish', 'isvalid']],
  ['pending validation with exit code zero', {validation: 'pending'}, ['show', 'publish', 'isvalid']],
  ['failed validation with exit code zero', {validation: 'error'}, ['show', 'publish', 'isvalid']],
  ['pending existing version', {existingVersion: '0.2.5', validation: 'pending'}, ['show', 'isvalid']],
  ['rejection after pending validation', {validation: 'pending,error', validationTimeout: 900}, ['show', 'publish', 'isvalid', 'isvalid']],
  ['malformed validation response', {validation: 'malformed'}, ['show', 'publish', 'isvalid']],
  ['unknown validation response', {validation: 'unknown'}, ['show', 'publish', 'isvalid']]
]) {
  test(`Marketplace does not report success for ${name}`, async () => {
    const result = await publish(options);
    assert.ok(result.error, result.output);
    assert.doesNotMatch(result.output, /is validated/);
    assert.deepEqual(result.calls.map(args => args[2]), commands);
  });
}
