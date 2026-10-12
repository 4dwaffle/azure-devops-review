import { run } from './process.mjs';
import { mapPullRequest } from './reference/pull-request.mjs';
const encode = encodeURIComponent;
export function organizationName(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(value)) throw new Error('Enter an Azure DevOps organization name, not a URL');
    return value;
}
export function prPath(pr) {
    if (!Number.isInteger(Number(pr.id)) || Number(pr.id) < 1) throw new Error('Invalid pull request ID');
    return `${encode(pr.project)}/_apis/git/repositories/${encode(pr.repositoryId)}/pullRequests/${Number(pr.id)}`;
}
export class Azure {
    constructor(organization, transport = fetch) { this.organization = organizationName(organization); this.transport = transport; this.token = null; this.authPromise = null; }
    async authenticate() {
        if (this.token && this.token.expires > Date.now() + 120000) return this.token.value;
        if (!this.authPromise) this.authPromise = (async () => {
            const executable = (process.env.AZURE_CLI_PATH || 'az').replaceAll("'", "''");
            const json = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${executable}' account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --output json`], { timeout: 60000 });
            const value = JSON.parse(json);
            if (!value.accessToken) throw new Error('Azure CLI returned no token. Sign in with az login.');
            this.token = { value: value.accessToken, expires: value.expires_on ? Number(value.expires_on) * 1000 : Date.now() + 300000 };
            return this.token.value;
        })().finally(() => { this.authPromise = null; });
        return this.authPromise;
    }
    async request(path, params = {}, method = 'GET', body) {
        if (path.startsWith('/') || path.includes('..') || /https?:/i.test(path)) throw new Error('Invalid Azure DevOps API path');
        const url = new URL(`https://dev.azure.com/${encode(this.organization)}/${path}`);
        for (const [key, value] of Object.entries({ 'api-version': '7.1', ...params })) if (value != null) url.searchParams.set(key, value);
        const response = await this.transport(url, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${await this.authenticate()}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        if (!response.ok) { const error = new Error(`Azure DevOps ${response.status}: ${(await response.text()).slice(0, 500)}`); error.status = response.status; throw error; }
        return { data: await response.json(), continuation: response.headers.get('x-ms-continuationtoken') };
    }
    async pages(path, params = {}) {
        const values = []; let continuation;
        do { const response = await this.request(path, { ...params, continuationToken: continuation }); values.push(...(response.data.value || [])); continuation = response.continuation; } while (continuation);
        return values;
    }
    async list(status = 'active') {
        if (!['active', 'completed', 'abandoned', 'all', 'my-drafts', 'reviewer'].includes(status)) throw new Error('Invalid PR status');
        const criteria = { 'searchCriteria.status': ['my-drafts', 'reviewer'].includes(status) ? 'active' : status };
        if (['my-drafts', 'reviewer'].includes(status)) {
            const { data } = await this.request('_apis/connectionData', { 'api-version': '7.1-preview.1' });
            const id = data.authenticatedUser?.id;
            if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error('Azure DevOps did not return your authenticated identity; personal PR filters cannot be applied');
            criteria[status === 'my-drafts' ? 'searchCriteria.creatorId' : 'searchCriteria.reviewerId'] = id;
        }
        const repositories = await this.pages('_apis/git/repositories');
        const results = []; const errors = []; let index = 0;
        await Promise.all(Array.from({ length: Math.min(5, repositories.length) }, async () => {
            while (index < repositories.length) {
                const repo = repositories[index++];
                try {
                    let skip = 0, page;
                    do {
                        page = (await this.request(`${encode(repo.project.id)}/_apis/git/repositories/${encode(repo.id)}/pullRequests`, { ...criteria, '$top': 100, '$skip': skip })).data.value || [];
                        results.push(...page.filter(raw => status !== 'my-drafts' || raw.isDraft === true).map(raw => ({ ...mapPullRequest(raw, repo), organization: this.organization, project: repo.project.name })));
                        skip += page.length;
                    } while (page.length === 100);
                } catch (error) { errors.push({ repository: repo.name, error: error.message }); }
            }
        }));
        return { pullRequests: results.sort((a, b) => b.id - a.id), errors };
    }
    async details(pr) {
        const path = prPath(pr);
        const [raw, iterations] = await Promise.all([this.request(path), this.request(`${path}/iterations`)]);
        const iteration = [...(iterations.data.value || [])].sort((a, b) => b.id - a.id)[0];
        if (!iteration) throw new Error('PR has no reviewable iteration');
        const mapped = { ...mapPullRequest(raw.data), organization: this.organization, project: raw.data.repository.project.name };
        const threads = (await this.request(`${path}/threads`, { '$iteration': iteration.id, '$baseIteration': iteration.id })).data.value || [];
        return { pr: mapped, raw: raw.data, iteration, threads, source: iteration.sourceRefCommit.commitId, target: iteration.targetRefCommit.commitId };
    }
    async changes(pr, iteration) {
        const values = []; let skip = 0;
        while (true) {
            const { data } = await this.request(`${prPath(pr)}/iterations/${iteration}/changes`, { '$compareTo': 0, '$top': 2000, '$skip': skip });
            values.push(...(data.changeEntries || []));
            if (!data.nextSkip) break;
            if (data.nextSkip <= skip) throw new Error('Invalid Azure DevOps changes pagination');
            skip = data.nextSkip;
        }
        return values;
    }
    async createThread(pr, body) { return (await this.request(`${prPath(pr)}/threads`, {}, 'POST', body)).data; }
}
export function buildThread(review, draft, changes) {
    if (draft.source !== review.source || draft.base !== review.base || draft.iteration !== review.iteration.id) throw new Error('Draft belongs to an older PR iteration; re-review and recreate it.');
    const change = changes.find(change => change.item?.path === `/${draft.path}` || change.originalPath === `/${draft.path}`);
    if (!Number.isInteger(change?.changeTrackingId) || change.changeTrackingId < 1) throw new Error('No verified Azure DevOps change tracking ID for file');
    const side = draft.side === 'left' ? 'left' : draft.side === 'right' ? 'right' : null;
    if (!side) throw new Error('Invalid comment side');
    const startOffset = draft.positionVersion === 2 ? draft.startOffset : 0;
    const endOffset = draft.positionVersion === 2 ? draft.endOffset : Math.max(0, (draft.endOffset || 1) - 2);
    if (!Number.isInteger(draft.startLine) || !Number.isInteger(draft.endLine) || draft.startLine < 1 || draft.endLine < draft.startLine || !Number.isInteger(startOffset) || startOffset < 0 || !Number.isInteger(endOffset) || endOffset < 0 || (draft.startLine === draft.endLine && endOffset < startOffset)) throw new Error('Invalid comment position');
    const context = { filePath: change.item.path, [`${side}FileStart`]: { line: draft.startLine, offset: startOffset }, [`${side}FileEnd`]: { line: draft.endLine, offset: endOffset } };
    return { comments: [{ parentCommentId: 0, content: draft.content, commentType: 1 }], status: 1, threadContext: context, pullRequestThreadContext: { changeTrackingId: change.changeTrackingId, iterationContext: { firstComparingIteration: review.iteration.id, secondComparingIteration: review.iteration.id } } };
}
