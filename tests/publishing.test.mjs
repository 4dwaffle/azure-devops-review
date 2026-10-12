import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewService } from '../review-service.mjs';
import { Azure, buildThread } from '../azure.mjs';
import { startServer } from '../server.mjs';
const reviewFixture = () => ({ key: 'org/repo/9', pr: { organization: 'org', project: 'project', repositoryId: 'repo', id: 9, status: 'active' }, iteration: { id: 4, commonRefCommit: { commitId: 'a'.repeat(40) } }, source: 'b'.repeat(40), base: 'a'.repeat(40), target: 'c'.repeat(40), threads: [], drafts: [] });
const draftFixture = review => ({ id: 'draft-1', path: 'file.cs', side: 'right', startLine: 1, endLine: 1, startOffset: 2, endOffset: 4, positionVersion: 2, content: 'Review selection', source: review.source, base: review.base, iteration: review.iteration.id, status: 'draft' });
const changes = [{ item: { path: '/file.cs' }, changeTrackingId: 17 }];
async function fixture(directory, enabled = true) {
    const service = new ReviewService(directory, { organization: 'org', roots: [directory], writeEnabled: enabled }, null), review = reviewFixture();
    service.reviews.set(review.key, review);
    await service.store.update(`review:${review.key}`, () => ({ viewed: {}, drafts: [draftFixture(review)] }));
    return { service, review };
}
test('read-only HTTP preflight and confirmed POST exercise the documented REST contract end to end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-contract-')); let server;
    try {
        const { service, review } = await fixture(root, false); const requests = [];
        const azure = new Azure('org', async (url, options) => {
            requests.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
            return new Response(JSON.stringify({ ...JSON.parse(options.body), id: 42 }), { headers: { 'Content-Type': 'application/json' } });
        });
        azure.authenticate = async () => 'fixture-token'; azure.details = async () => review; azure.changes = async () => changes;
        service.client = () => azure; server = await startServer(service);
        const post = async (route, input) => { const response = await fetch(new URL(`api/${route}`, server.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); return { ok: response.ok, body: await response.json() }; };
        const preview = await post('publish/preview', { key: review.key }); assert.equal(preview.ok, true); assert.equal(requests.length, 0);
        assert.equal(preview.body.liveWriteVerification, false);
        assert.deepEqual(preview.body.payloads[0].body, { comments: [{ parentCommentId: 0, content: 'Review selection', commentType: 1 }], status: 1, threadContext: { filePath: '/file.cs', rightFileStart: { line: 1, offset: 2 }, rightFileEnd: { line: 1, offset: 4 } }, pullRequestThreadContext: { changeTrackingId: 17, iterationContext: { firstComparingIteration: 4, secondComparingIteration: 4 } } });
        assert.equal((await post('publish', { key: review.key, planToken: preview.body.planToken })).ok, false); assert.equal(requests.length, 0);
        await service.configure({ organization: 'org', roots: [root], writeEnabled: true });
        assert.equal((await post('publish', { key: review.key })).ok, false); assert.equal(requests.length, 0);
        const result = await post('publish', { key: review.key, planToken: preview.body.planToken }); assert.equal(result.ok, true); assert.deepEqual(result.body, { published: [42], drafts: [] });
        assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST'); assert.match(requests[0].url, /org\/project\/_apis\/git\/repositories\/repo\/pullRequests\/9\/threads\?api-version=7.1$/);
        assert.deepEqual(requests[0].body, preview.body.payloads[0].body);
    } finally { if (server) await server.close(); await rm(root, { recursive: true, force: true }); }
});
test('confirmed preview cannot publish new or changed drafts from another session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-preview-'));
    try {
        const { service, review } = await fixture(root); let posts = 0;
        service.client = () => ({ details: async () => review, changes: async () => changes, createThread: async () => { posts++; } });
        const preview = await service.preparePublish({ key: review.key });
        await service.store.update(`review:${review.key}`, state => { state.drafts[0].content = 'Changed after confirmation'; return state; });
        await assert.rejects(service.publish({ key: review.key, planToken: preview.planToken }), /preview is missing or changed/); assert.equal(posts, 0);
        const updated = await service.preparePublish({ key: review.key });
        await service.store.update(`review:${review.key}`, state => { state.drafts.push({ ...draftFixture(review), id: 'another-session' }); return state; });
        await assert.rejects(service.publish({ key: review.key, planToken: updated.planToken }), /preview is missing or changed/); assert.equal(posts, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('unexpected returned file, position or iteration remains uncertain and cannot be retried', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-response-'));
    try {
        const mutations = [body => { body.threadContext.filePath = '/wrong.cs'; }, body => { body.threadContext.rightFileStart.offset++; }, body => { body.threadContext.rightFileEnd.line++; }, body => { body.pullRequestThreadContext.iterationContext.firstComparingIteration--; }];
        for (const [index, mutate] of mutations.entries()) {
            const { service, review } = await fixture(join(root, String(index))); let posts = 0;
            service.client = () => ({ details: async () => review, changes: async () => changes, createThread: async (_, body) => { posts++; const response = structuredClone(body); mutate(response); return { ...response, id: 42 }; } });
            const preview = await service.preparePublish({ key: review.key });
            await assert.rejects(service.publish({ key: review.key, planToken: preview.planToken }), /Unexpected Azure DevOps/);
            assert.equal((await service.store.read(`review:${review.key}`)).drafts[0].status, 'publishing');
            await assert.rejects(service.publish({ key: review.key, planToken: preview.planToken }), /uncertain outcome/); assert.equal(posts, 1);
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('inline ranges use documented zero-based offsets and normalize legacy whole-line drafts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-position-'));
    try {
        const { service, review } = await fixture(root);
        service.file = async () => ({ original: 'abcdef\r\nsecond\n', modified: 'abcdef\r\nsecond\n', binary: false });
        const result = await service.draft({ key: review.key, path: 'file.cs', side: 'left', startLine: 1, endLine: 1, startOffset: 2, endOffset: 4, content: 'Precise range' });
        const body = buildThread(review, result.drafts.at(-1), changes);
        assert.deepEqual(body.threadContext.leftFileStart, { line: 1, offset: 2 }); assert.deepEqual(body.threadContext.leftFileEnd, { line: 1, offset: 4 });
        const legacy = { ...draftFixture(review), positionVersion: undefined, endOffset: 7 };
        assert.deepEqual(buildThread(review, legacy, changes).threadContext.rightFileStart, { line: 1, offset: 0 });
        assert.deepEqual(buildThread(review, legacy, changes).threadContext.rightFileEnd, { line: 1, offset: 5 });
        await assert.rejects(service.draft({ key: review.key, path: 'file.cs', side: 'right', startLine: 1, endLine: 1, startOffset: 3, endOffset: 2, content: 'Invalid range' }), /character range/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
