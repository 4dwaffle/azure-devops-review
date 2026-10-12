import test from 'node:test';
import assert from 'node:assert/strict';
import { Azure } from '../azure.mjs';
const identity = '12345678-1234-1234-1234-123456789abc';
const repository = { id: 'repo', name: 'repo', project: { id: 'project', name: 'project' } };
function client(handler) {
    const requests = [], azure = new Azure('org', async (url, options) => {
        requests.push({ url, options }); assert.equal(options.method, 'GET');
        return Response.json(await handler(url));
    });
    azure.authenticate = async () => 'test-only-token';
    return { azure, requests };
}
test('my drafts uses authenticated creator identity and paginates raw pages before filtering drafts', async () => {
    const { azure, requests } = client(url => {
        if (url.pathname.endsWith('/connectionData')) return { authenticatedUser: { id: identity }, authorizedUser: { id: 'do-not-use-this-identity' } };
        if (url.pathname.endsWith('/repositories')) return { value: [repository] };
        assert.equal(url.searchParams.get('searchCriteria.status'), 'active'); assert.equal(url.searchParams.get('searchCriteria.creatorId'), identity); assert.equal(url.searchParams.has('searchCriteria.reviewerId'), false);
        return { value: url.searchParams.get('$skip') === '0' ? Array.from({ length: 100 }, (_, index) => ({ pullRequestId: index + 1, title: 'Not a draft', isDraft: false })) : [{ pullRequestId: 101, title: 'My draft', isDraft: true }] };
    });
    const result = await azure.list('my-drafts');
    assert.deepEqual(result.pullRequests.map(pr => pr.id), [101]); assert.equal(result.pullRequests[0].isDraft, true); assert.equal(requests.filter(request => request.url.pathname.endsWith('/pullRequests')).length, 2); assert.deepEqual(result.errors, []);
});
test('reviewer view delegates identity matching to Azure DevOps and includes active drafts', async () => {
    const { azure } = client(url => {
        if (url.pathname.endsWith('/connectionData')) return { authenticatedUser: { id: identity } };
        if (url.pathname.endsWith('/repositories')) return { value: [repository] };
        assert.equal(url.searchParams.get('searchCriteria.status'), 'active'); assert.equal(url.searchParams.get('searchCriteria.reviewerId'), identity); assert.equal(url.searchParams.has('searchCriteria.creatorId'), false);
        return { value: [{ pullRequestId: 2, title: 'Assigned draft', isDraft: true }, { pullRequestId: 1, title: 'Assigned active' }] };
    });
    assert.deepEqual((await azure.list('reviewer')).pullRequests.map(pr => pr.id), [2, 1]);
});
test('ordinary states do not query identity and personal views fail closed on unavailable identity', async () => {
    const { azure, requests } = client(url => url.pathname.endsWith('/repositories') ? { value: [repository] } : { value: [] });
    for (const status of ['active', 'completed', 'abandoned', 'all']) await azure.list(status);
    assert.equal(requests.some(request => request.url.pathname.endsWith('/connectionData')), false);
    assert.deepEqual(requests.filter(request => request.url.pathname.endsWith('/pullRequests')).map(request => request.url.searchParams.get('searchCriteria.status')), ['active', 'completed', 'abandoned', 'all']);
    await assert.rejects(azure.list('unknown'), /Invalid PR status/);
    for (const status of ['my-drafts', 'reviewer']) {
        const { azure: personal, requests: calls } = client(() => ({ authenticatedUser: { displayName: 'Not a stable identity' } }));
        await assert.rejects(personal.list(status), /authenticated identity/); assert.equal(calls.length, 1);
    }
});
