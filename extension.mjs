import { joinSession, createCanvas } from '@github/copilot-sdk/extension';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewService, defaultSettings } from './review-service.mjs';
import { startServer } from './server.mjs';
const directory = dirname(fileURLToPath(import.meta.url));
const servers = new Map();
let session;
const defaults = await defaultSettings(process.cwd());
const service = new ReviewService(join(directory, 'artifacts'), defaults, prompt => {
    if (!session) throw new Error('Copilot session is not ready');
    return session.send({ prompt });
});
const inputSchema = { type: 'object', properties: { organization: { type: 'string' } }, additionalProperties: false };
const canvas = createCanvas({
    id: 'azure-devops-review',
    displayName: 'Azure DevOps Review',
    description: 'Browse Azure DevOps PRs and review local merge-base diffs, comments, and persisted file progress.',
    inputSchema,
    actions: [
        { name: 'diagnostics', description: 'Report local Monaco and Roslyn integration status.', handler: () => service.diagnostics() },
        { name: 'probe_roslyn', description: 'Test configured Roslyn initialization, syntax and single-file dead-code diagnostics in disposable local fixtures.', handler: async () => { await service.config(); return service.roslyn.probe(); } },
        { name: 'list_pull_requests', description: 'List PRs by state, my drafts or assigned reviewer across configured organization repositories without inference.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'completed', 'abandoned', 'all', 'my-drafts', 'reviewer'] } }, additionalProperties: false }, handler: ctx => service.list(ctx.input?.status || 'active') },
        { name: 'open_pull_request', description: 'Resolve and load a PR and its local diff.', inputSchema: { type: 'object', properties: { organization: { type: 'string' }, project: { type: 'string' }, repositoryId: { type: 'string' }, id: { type: 'integer', minimum: 1 } }, required: ['organization', 'project', 'repositoryId', 'id'], additionalProperties: false }, handler: ctx => service.open(ctx.input) },
    ],
    open: async ctx => {
        if (ctx.input?.organization) { const config = await service.config(); await service.configure({ ...config, organization: ctx.input.organization }); }
        let entry = servers.get(ctx.instanceId);
        if (!entry) { entry = await startServer(service); servers.set(ctx.instanceId, entry); }
        return { title: 'Azure DevOps Review', url: entry.url };
    },
    onClose: async ctx => { const entry = servers.get(ctx.instanceId); servers.delete(ctx.instanceId); if (entry) await entry.close(); if (!servers.size) await service.roslyn.stop(); },
});
session = await joinSession({ canvases: [canvas] });

