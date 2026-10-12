import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { ReviewService } from '../review-service.mjs';
import { startServer } from '../server.mjs';
const executablePath = process.env.REVIEW_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
function fixture(directory) {
    const service = new ReviewService(directory, { organization: 'org', roots: [] }, () => { throw new Error('Unexpected inference'); });
    const paths = [...Array.from({ length: 30 }, (_, i) => `Folder0/Nested/File${i}.cs`), ...Array.from({ length: 5 }, (_, i) => `Folder1/File${i}.cs`), 'Migrations/Update.cs', 'Folder0/Nested/View.Designer.cs'];
    const files = paths.map((path, index) => ({ path, oldPath: path, status: 'M', fingerprint: String(index), viewed: false }));
    const pr = { organization: 'org', project: 'project', repositoryId: 'repo', id: 1, isDraft: true, status: 'active', title: 'Draft review fixture', repository: 'repo', sourceRefName: 'refs/heads/source', targetRefName: 'refs/heads/main' };
    const review = { key: 'org/repo/1', pr, base: 'a'.repeat(40), source: 'b'.repeat(40), iteration: { id: 1 }, worktree: { path: 'fixture' }, files, threads: [], drafts: [] };
    service.reviews.set(review.key, review);
    service.gitClient = async () => ({ file: async (_, path) => ({ ...files.find(file => file.path === path), original: 'class C { int x; }', modified: 'class C { int y; }', language: 'csharp', binary: false }) });
    return { service, review, input: paths => ({ key: review.key, source: review.source, base: review.base, paths, viewed: true }) };
}
test('batch progress is atomic, durable, unlimited by Copilot scope and preserves drafts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-bulk-'));
    try {
        const { service, review, input } = fixture(directory);
        await service.store.update(`review:${review.key}`, () => ({ viewed: {}, drafts: [{ id: 'keep' }] }));
        const paths = review.files.slice(0, 30).map(file => file.path);
        const result = await service.viewedMany(input([...paths, paths[0]]));
        assert.equal(result.paths.length, 30); assert.equal(review.files.filter(file => file.viewed).length, 30);
        const fresh = new ReviewService(directory, {}, () => {}), state = await fresh.store.read(`review:${review.key}`);
        assert.equal(Object.keys(state.viewed).length, 30); assert.deepEqual(state.drafts, [{ id: 'keep' }]);
        await service.viewedMany({ ...input(paths), viewed: false });
        assert.equal(Object.keys((await fresh.store.read(`review:${review.key}`)).viewed).length, 0);
        for (const invalid of [{ paths: [] }, { paths: [paths[0], 'unknown'] }, { paths: [42] }, { viewed: 'true' }, { source: 'stale' }, { base: 'stale' }]) await assert.rejects(service.viewedMany({ ...input(paths), ...invalid }));
        assert.equal(Object.keys((await fresh.store.read(`review:${review.key}`)).viewed).length, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
test('batch progress rejects a review replaced while waiting for the persistence lock', async () => {
    const { service, review, input } = fixture('unused');
    let release; const waiting = new Promise(resolve => release = resolve);
    service.store.update = async (_, change) => { await waiting; return change({ viewed: {}, drafts: [] }); };
    const pending = assert.rejects(service.viewedMany(input([review.files[0].path])), /PR changed/);
    service.reviews.set(review.key, { ...review, source: 'new' }); release(); await pending;
    assert.equal(review.files[0].viewed, false);
});
test('folder selection, filtered batches, revealable ignored files, draft badges and dead-code markers are inference-free', { skip: !existsSync(executablePath), timeout: 90000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-bulk-ui-'));
    const { service, review } = fixture(directory);
    const config = service.config.bind(service); service.config = async () => ({ ...await config(), roslyn: { available: true } });
    service.list = async () => ({ pullRequests: [review.pr, { ...review.pr, id: 2, isDraft: false, title: 'Ready for review' }] });
    service.open = async input => {
        const progress = await service.store.read(`review:${review.key}`, { viewed: {} });
        review.files.forEach(file => file.viewed = progress.viewed[file.path] === file.fingerprint);
        const result = service.publicReview(review);
        if (input.id === 2) result.pr = { ...review.pr, id: 2, isDraft: false, title: 'Ready for review' };
        return result;
    };
    const diagnostic = code => ({ code, message: code === 'IDE0035' ? 'Unreachable code detected' : 'Private member is unused', severity: 4, tags: [1], range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } });
    let pendingDiagnostics;
    service.roslynStart = async () => ({});
    service.roslynDiagnostics = async () => pendingDiagnostics || ({ diagnostics: [diagnostic('IDE0035'), diagnostic('IDE0051')], deadCode: [diagnostic('IDE0035'), diagnostic('IDE0051')] });
    const server = await startServer(service), browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }), errors = [], unexpected = [];
        page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/api\/(copilot|publish)/.test(request.url())) unexpected.push(request.url()); });
        await page.goto(server.url); assert.equal(await page.locator('.pr-card .pr-state').textContent(), 'Draft');
        assert.equal(await page.locator('.pr-card').nth(1).locator('.pr-state').count(), 0);
        const style = await page.locator('.pr-card .draft-state').evaluate(node => ({ weight: getComputedStyle(node).fontWeight, border: getComputedStyle(node).borderTopWidth, transform: getComputedStyle(node).textTransform }));
        assert.equal(style.weight, '600'); assert.equal(style.border, '2px'); assert.equal(style.transform, 'uppercase');
        await page.locator('.pr-card').nth(1).click(); await page.locator('#filter-status').filter({ hasText: 'Local analysis complete' }).waitFor();
        assert.equal(await page.locator('#review-pr-state').isHidden(), true);
        await page.locator('.pr-card').first().click(); await page.locator('#filter-status').filter({ hasText: 'Local analysis complete' }).waitFor();
        assert.equal(await page.locator('#review-pr-state').textContent(), 'Draft'); assert.equal(await page.locator('button.file').count(), 35);
        const folder = page.locator('input[data-selection-folder="Folder0"]');
        await folder.check(); assert.match(await page.locator('#selected-count').textContent(), /30 selected/);
        await page.locator('input[data-selection-path="Folder0/Nested/File0.cs"]').uncheck(); assert.equal(await folder.evaluate(node => node.indeterminate), true);
        await folder.check(); await page.locator('#mark-selected-reviewed').click(); await page.locator('#progress').filter({ hasText: '30 / 35 · 2 ignored' }).waitFor();
        assert.equal(await page.locator('#viewed').isChecked(), true);
        await page.locator('#mark-selected-unreviewed').click(); await page.locator('#progress').filter({ hasText: /^0 \/ 35 · 2 ignored/ }).waitFor();
        assert.equal(await page.locator('#viewed').isChecked(), false);
        await page.locator('#mark-selected-reviewed').click(); await page.locator('#progress').filter({ hasText: '30 / 35 · 2 ignored' }).waitFor();
        await page.locator('#clear-selection').click(); await page.locator('#file-filter').fill('Folder1'); await page.locator('#select-visible').click();
        assert.match(await page.locator('#selected-count').textContent(), /5 selected/);
        assert.equal(await page.locator('#progress').textContent(), '30 / 35 · 2 ignored');
        await page.locator('#mark-selected-reviewed').click(); await page.locator('#progress').filter({ hasText: '35 / 35 · 2 ignored' }).waitFor();
        assert.equal(review.files.find(file => file.path === 'Migrations/Update.cs').viewed, false);
        await page.reload(); await page.locator('.pr-card').first().click(); await page.locator('#filter-status').filter({ hasText: 'Local analysis complete' }).waitFor();
        assert.match(await page.locator('#progress').textContent(), /35 \/ 35 · 2 ignored/);
        await page.locator('#roslyn').click(); await page.locator('#notice').filter({ hasText: '2 dead-code' }).waitFor();
        const markers = await page.evaluate(() => monaco.editor.getModelMarkers({ owner: 'roslyn' }));
        assert.deepEqual(markers.map(item => item.code), ['IDE0035', 'IDE0051']); assert.ok(markers.every(item => item.severity === 1 && item.tags.includes(1)));
        let release; pendingDiagnostics = new Promise(resolve => release = resolve);
        const requested = page.waitForRequest(request => request.url().includes('api/roslyn/diagnostics'));
        await page.locator('#roslyn').click(); await requested;
        await page.locator('button.file[data-path="Folder1/File0.cs"]').click(); await page.locator('#current-file').filter({ hasText: /^Folder1\/File0\.cs$/ }).waitFor();
        const completed = page.waitForResponse(response => response.url().includes('api/roslyn/diagnostics'));
        release({ diagnostics: [diagnostic('IDE0051')], deadCode: [diagnostic('IDE0051')] }); await completed;
        assert.equal(await page.evaluate(() => monaco.editor.getModelMarkers({ owner: 'roslyn' }).length), 0);
        await page.locator('#review-filters').click(); await page.locator('#show-ignored').check(); await page.locator('#filters-form button[type=submit]').click();
        await page.waitForFunction(() => document.querySelectorAll('button.file').length === 37);
        await page.locator('#select-visible').click(); await page.locator('#mark-selected-reviewed').click(); await page.locator('#notice').filter({ hasText: '37 files marked reviewed' }).waitFor();
        assert.equal(await page.locator('#progress').textContent(), '35 / 35 · 2 ignored');
        assert.equal(Object.keys((await service.store.read(`review:${review.key}`)).viewed).length, 37);
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    } finally { await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
