import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../process.mjs';
import { GitReview, parseRemote, parseChanges } from '../git-review.mjs';
import { Store } from '../store.mjs';
import { ReviewService } from '../review-service.mjs';
import { buildThread, Azure } from '../azure.mjs';
import { startServer } from '../server.mjs';
const fixture = () => ({ key: 'org/repo/9', pr: { organization: 'org', project: 'project', repositoryId: 'repo', id: 9, status: 'active' }, iteration: { id: 4, commonRefCommit: { commitId: 'a'.repeat(40) } }, source: 'b'.repeat(40), base: 'a'.repeat(40), target: 'c'.repeat(40), files: [{ path: 'new.cs', oldPath: 'old.cs', fingerprint: 'abc', status: 'R100' }], threads: [], drafts: [] });
const draft = () => ({ id: 'draft-1', path: 'new.cs', side: 'left', startLine: 2, endLine: 3, endOffset: 6, content: 'Review', source: 'b'.repeat(40), base: 'a'.repeat(40), iteration: 4, status: 'draft' });
const changes = [{ item: { path: '/new.cs' }, originalPath: '/old.cs', changeTrackingId: 17 }];
const publish = async (service, key) => service.publish({ key, planToken: (await service.preparePublish({ key })).planToken });
test('Azure remote identities support HTTPS and SSH', () => {
    assert.deepEqual(parseRemote('https://user@dev.azure.com/org/project/_git/repo'), { organization: 'org', project: 'project', repository: 'repo' });
    assert.deepEqual(parseRemote('git@ssh.dev.azure.com:v3/org/project/repo'), { organization: 'org', project: 'project', repository: 'repo' });
    assert.equal(parseRemote('https://example.com/repo.git'), null);
});
test('NUL diff parsing handles spaces, renames, additions and deletions', () => {
    assert.deepEqual(parseChanges('R100\0old name.cs\0new name.cs\0A\0add.cs\0D\0delete.cs\0'), [{ status: 'R100', oldPath: 'old name.cs', path: 'new name.cs' }, { status: 'A', oldPath: 'add.cs', path: 'add.cs' }, { status: 'D', oldPath: 'delete.cs', path: 'delete.cs' }]);
});
test('merge-base diff excludes target-only commits and reads immutable blobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-git-'));
    try {
        await git(root, ['init', '-q', '-b', 'main']); await git(root, ['config', 'user.name', 'Canvas Test']); await git(root, ['config', 'user.email', 'test@example.invalid']);
        await writeFile(join(root, 'old name.cs'), 'base\n'); await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'base']); const base = (await git(root, ['rev-parse', 'HEAD'])).trim();
        await git(root, ['checkout', '-qb', 'source']); await git(root, ['mv', 'old name.cs', 'new name.cs']); await writeFile(join(root, 'new.cs'), 'source\n'); await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'source']); const source = (await git(root, ['rev-parse', 'HEAD'])).trim();
        await git(root, ['checkout', '-q', 'main']); await writeFile(join(root, 'target-only.cs'), 'target\n'); await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'target']); const target = (await git(root, ['rev-parse', 'HEAD'])).trim();
        const client = new GitReview([root]); const review = { ...await client.compare({ path: root }, source, target), worktree: { path: root } };
        assert.equal(review.base, base); assert.equal(review.files.length, 2); assert.equal(review.files.some(file => file.path === 'target-only.cs'), false);
        const rename = review.files.find(file => file.path === 'new name.cs'); assert.equal(rename.status, 'R100');
        await writeFile(join(root, 'new name.cs'), 'uncommitted edit'); const content = await client.file(review, 'new name.cs'); assert.equal(content.original, 'base\n'); assert.equal(content.modified, 'base\n');
        assert.equal((await client.file(review, 'new.cs')).original, '');
        await assert.rejects(client.file(review, '../private'), /not part/);
        await assert.rejects(client.compare({ path: root }, 'd'.repeat(40), target), /missing locally/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('progress is durable and concurrent updates are serialized', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-store-'));
    try { const store = new Store(root); await Promise.all(Array.from({ length: 30 }, () => store.update('key', value => ({ count: (value.count || 0) + 1 })))); assert.equal((await new Store(root).read('key')).count, 30); }
    finally { await rm(root, { recursive: true, force: true }); }
});
test('inline thread uses tracking ID, correct side, and same-iteration common base', () => {
    const payload = buildThread(fixture(), draft(), changes);
    assert.deepEqual(payload.pullRequestThreadContext, { changeTrackingId: 17, iterationContext: { firstComparingIteration: 4, secondComparingIteration: 4 } });
    assert.equal(payload.threadContext.filePath, '/new.cs'); assert.equal(payload.threadContext.leftFileStart.line, 2); assert.equal(payload.threadContext.rightFileStart, undefined);
    assert.throws(() => buildThread(fixture(), { ...draft(), iteration: 3 }, changes), /older PR iteration/);
    assert.throws(() => buildThread(fixture(), draft(), []), /tracking ID/);
});
test('write actions block stale iterations and duplicate uncertain publishing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-publish-'));
    try {
        const review = fixture();         const service = new ReviewService(root, { organization: 'org', writeVerification: { organization: 'org', verified: true }, writeEnabled: true }, null); service.reviews.set(review.key, review);
        await service.store.update(`review:${review.key}`, () => ({ viewed: {}, drafts: [draft()] }));
        let posts = 0; service.client = () => ({ details: async () => ({ ...review, iteration: { ...review.iteration, id: 5 } }), changes: async () => changes, createThread: async () => { posts++; } });
        await assert.rejects(service.publish({ key: review.key }), /changed or closed/); assert.equal(posts, 0);
        service.client = () => ({ details: async () => review, changes: async () => changes, createThread: async () => { posts++; throw new Error('Network outcome unknown'); } });
        await assert.rejects(publish(service, review.key), /unknown/); await assert.rejects(publish(service, review.key), /uncertain outcome/); assert.equal(posts, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('successful publishing validates server context and persists completed draft removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-publish-'));
    try {
        const review = fixture();         const service = new ReviewService(root, { organization: 'org', writeVerification: { organization: 'org', verified: true }, writeEnabled: true }, null); service.reviews.set(review.key, review);
        await service.store.update(`review:${review.key}`, () => ({ viewed: {}, drafts: [draft()] }));
        service.client = () => ({ details: async () => review, changes: async () => changes, createThread: async (_, body) => ({ ...body, id: 123 }) });
        assert.deepEqual(await publish(service, review.key), { published: [123], drafts: [] });
        assert.deepEqual((await new Store(root).read(`review:${review.key}`)).drafts, []);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('separate canvas sessions cannot publish the same draft twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-concurrent-publish-'));
    try {
        const review = fixture(); let posts = 0;
        const defaults = { organization: 'org', writeVerification: { organization: 'org', verified: true }, writeEnabled: true };
        const services = [new ReviewService(root, defaults, null), new ReviewService(root, defaults, null)];
        await services[0].store.update(`review:${review.key}`, () => ({ viewed: {}, drafts: [draft()] }));
        for (const service of services) {
            service.reviews.set(review.key, structuredClone(review));
            service.client = () => ({ details: async () => review, changes: async () => changes, createThread: async (_, body) => { posts++; await new Promise(resolve => setTimeout(resolve, 50)); return { ...body, id: 42 }; } });
        }
        const planToken = (await services[0].preparePublish({ key: review.key })).planToken;
        const results = await Promise.allSettled(services.map(service => service.publish({ key: review.key, planToken })));
        assert.equal(posts, 1); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('REST create-thread URL targets target repository and 7.1 API', async () => {
    let observed;
    const client = new Azure('org', async (url, options) => { observed = { url: String(url), options }; return new Response(JSON.stringify({ id: 42 }), { headers: { 'Content-Type': 'application/json' } }); });
    client.authenticate = async () => 'fixture-token';
    await client.createThread(fixture().pr, buildThread(fixture(), draft(), changes));
    assert.match(observed.url, /org\/project\/_apis\/git\/repositories\/repo\/pullRequests\/9\/threads\?api-version=7.1$/);
    assert.equal(observed.options.method, 'POST'); assert.equal(JSON.parse(observed.options.body).pullRequestThreadContext.changeTrackingId, 17);
});
test('HTTP server requires capability path, rejects foreign origin and binds loopback', async () => {
    const server = await startServer({ config: async () => ({ organization: 'org' }) });
    try {
        assert.equal(server.server.address().address, '127.0.0.1');
        assert.equal((await fetch(new URL('api/config', server.url))).status, 200);
        assert.equal((await fetch(new URL('api/config', server.url), { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
        assert.equal((await fetch(new URL('api/config', server.url), { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
        assert.equal((await fetch(new URL('/api/config', server.url))).status, 404);
        assert.equal((await fetch(server.url)).status, 200);
    } finally { await server.close(); }
});
