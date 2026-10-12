import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git } from '../process.mjs';
import { GitReview, parseWorktrees } from '../git-review.mjs';
import { ReviewService } from '../review-service.mjs';
import { Store } from '../store.mjs';
import { run } from '../process.mjs';

const temporary = prefix => mkdtemp(join(tmpdir(), prefix));
async function initialize(root) {
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['config', 'user.name', 'Canvas Test']);
    await git(root, ['config', 'user.email', 'test@example.invalid']);
    await writeFile(join(root, 'tracked.cs'), 'base\n');
    await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'base']);
    return (await git(root, ['rev-parse', 'HEAD'])).trim();
}
test('Git forward-slash worktree paths normalize and exclusions apply before selection', async () => {
    const root = await temporary('canvas-worktrees-');
    try {
        const head = await initialize(root), excluded = join(root, 'excluded');
        await git(root, ['remote', 'add', 'origin', 'https://dev.azure.com/org/project/_git/repo']);
        await git(root, ['worktree', 'add', '-q', '-b', 'source', excluded]);
        const parsed = parseWorktrees(`worktree ${excluded.replaceAll('\\', '/')}\0HEAD ${head}\0branch refs/heads/source\0\0`);
        assert.equal(parsed[0].path, resolve(excluded));
        const client = new GitReview([root], [excluded.toUpperCase()]);
        await client.discover();
        assert.deepEqual(client.worktrees.map(tree => tree.path), [resolve(root)]);
        const selected = await client.resolve({ organization: 'org', project: 'project', repository: 'repo', sourceRefName: 'refs/heads/source', source: head });
        assert.equal(selected.path, resolve(root));
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
test('separate processes do not lose concurrent persistent progress', async () => {
    const root = await temporary('canvas-multiprocess-');
    try {
        const script = `import { Store } from ${JSON.stringify(new URL('../store.mjs', import.meta.url).href)}; const store = new Store(process.argv[1]); for (let i = 0; i < 20; i++) await store.update('progress', value => ({ count: (value.count || 0) + 1 }));`;
        await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ['--input-type=module', '-e', script, root])));
        assert.equal((await new Store(root).read('progress')).count, 60);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('viewed progress survives reopening and invalidates only changed content', async () => {
    const root = await temporary('canvas-viewed-');
    try {
        const pr = { organization: 'org', project: 'project', repositoryId: 'repo', id: 7 };
        let fingerprint = 'first';
        const service = new ReviewService(root, { organization: 'org' }, null);
        service.client = () => ({ details: async () => ({ pr, raw: {}, iteration: { id: 1 }, source: 'source', target: 'target', threads: [] }) });
        service.gitClient = async () => ({ resolve: async () => ({ path: root }), compare: async () => ({ base: 'base', files: [{ path: 'tracked.cs', fingerprint }] }) });
        const first = await service.open(pr);
        await service.viewed({ key: first.key, path: 'tracked.cs', viewed: true });
        assert.equal((await service.open(pr)).files[0].viewed, true);
        fingerprint = 'second';
        assert.equal((await service.open(pr)).files[0].viewed, false);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('publishing requires explicit opt-in and never claims live write verification', async () => {
    const root = await temporary('canvas-write-gate-');
    try {
        const service = new ReviewService(root, { organization: 'org', roots: [root], writeEnabled: false }, null);
        await assert.rejects(service.publish({ key: 'org/repo/1' }), /Publishing is disabled/);
        const config = await service.configure({ organization: 'org', roots: [root], writeEnabled: true, writeVerification: { verified: true, organization: 'org' } });
        assert.equal(config.writeEnabled, true); assert.equal(config.writeContractVerified, true); assert.equal(config.liveWriteVerification, false); assert.equal(config.writeVerification, undefined);
        service.publishing.add('org/repo/1');
        await assert.rejects(service.draft({ key: 'org/repo/1' }), /publishing to finish/);
        await assert.rejects(service.removeDraft({ key: 'org/repo/1' }), /publishing to finish/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('Copilot receives ranges, complete files and bounded multi-file selections only on request', async () => {
    const root = await temporary('canvas-copilot-');
    try {
        const prompts = [], service = new ReviewService(root, {}, async prompt => prompts.push(prompt));
        const review = { key: 'org/repo/1', pr: { id: 1, repository: 'repo' }, source: 'source', worktree: { path: root } };
        service.reviews.set(review.key, review);
        service.file = async (_, path) => ({ original: 'base one\nbase two', modified: path === 'large.cs' ? 'x'.repeat(60001) : 'source one\nsource two', binary: false });
        await service.copilot({ key: review.key, path: 'first.cs', side: 'left', startLine: 2, endLine: 2 });
        assert.match(prompts[0], /base two/); assert.doesNotMatch(prompts[0], /base one/);
        await service.copilot({ key: review.key, path: 'first.cs', side: 'right' });
        assert.match(prompts[1], /source one\nsource two/);
        await service.copilot({ key: review.key, paths: ['first.cs', 'second.cs'] });
        assert.match(prompts[2], /File: first.cs/); assert.match(prompts[2], /File: second.cs/);
        await assert.rejects(service.copilot({ key: review.key, paths: [] }), /1–20/);
        await assert.rejects(service.copilot({ key: review.key, paths: ['large.cs'] }), /60 KB/);
        assert.equal(prompts.length, 3);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('deleted and binary files use immutable Git blobs without reading working files', async () => {
    const root = await temporary('canvas-files-');
    try {
        const base = await initialize(root);
        await git(root, ['rm', '-q', 'tracked.cs']);
        await writeFile(join(root, 'binary.bin'), Buffer.from([65, 0, 66]));
        await writeFile(join(root, 'large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
        await git(root, ['add', '.']);
        await git(root, ['update-index', '--add', '--cacheinfo', `160000,${base},dependency`]);
        await git(root, ['commit', '-qm', 'delete, binary, large file and gitlink']);
        const source = (await git(root, ['rev-parse', 'HEAD'])).trim(), client = new GitReview([root]);
        const review = { ...await client.compare({ path: root }, source, base), worktree: { path: root } };
        const deleted = await client.file(review, 'tracked.cs');
        assert.equal(deleted.original, 'base\n'); assert.equal(deleted.modified, '');
        assert.equal((await client.file(review, 'binary.bin')).binary, true);
        assert.match((await client.file(review, 'large.txt')).reason, /8 MB/);
        assert.equal((await client.file(review, 'dependency')).modified, `Subproject commit ${base}\n`);
    } finally { await rm(root, { recursive: true, force: true }); }
});
