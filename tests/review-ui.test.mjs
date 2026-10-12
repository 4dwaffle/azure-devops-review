import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';
import { analyzeReview, normalizeFilters, ignoredReasons } from '../analysis.mjs';
const executablePath = process.env.REVIEW_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
test('app theme, persistent ignores, rename navigation and safe dependency SVGs need no inference', { skip: !existsSync(executablePath), timeout: 90000 }, async () => {
    const contents = [
        ['New.cs', 'namespace N; class Old {}', 'namespace N; class New {}'],
        ['Ref.cs', 'namespace N; class Ref { Old x; }', 'namespace N; class Ref { New x; }'],
        ['Format.cs', 'class F{int x=1;}', 'class F { int x = 1; }'],
        ['Usings.cs', 'using System; class U {}', 'class U {}'],
        ['Text.resx', 'old resource', 'new resource'],
        ['Generated.g.cs', 'class G { int x; }', 'class G { int y; }'],
        ['package.json', '{"dependencies":{"A":"1"}}', JSON.stringify({ dependencies: { A: '2', '<img src=x onerror=alert(1)>': '1' } })],
    ];
    const files = contents.map(([path, original, modified], index) => ({ path, oldPath: path, original, modified, status: 'M', fingerprint: String(index), viewed: false, language: path.endsWith('.cs') ? 'csharp' : 'json' }));
    const pr = { organization: 'org', project: 'project', repositoryId: 'repo', id: 1, title: 'Filter and diagram fixture', repository: 'repo', sourceRefName: 'refs/heads/source', targetRefName: 'refs/heads/main' };
    const review = { key: 'org/repo/1', pr, iteration: { id: 1 }, base: 'a'.repeat(40), worktree: { path: 'local fixture' }, files, threads: [], drafts: [] };
    let filters = normalizeFilters(), inference = 0, publications = 0;
    const views = [];
    const configuration = () => ({ organization: 'org', roots: ['C:\\fixture'], reviewFilters: filters, roslyn: { available: false }, writeEnabled: false });
    const service = {
        config: async () => configuration(), list: async status => { views.push(status); return { pullRequests: [pr] }; }, open: async () => review,
        file: async (_, path) => ({ ...files.find(file => file.path === path), threads: [], binary: false }),
        viewed: async ({ path, viewed }) => { files.find(file => file.path === path).viewed = viewed; return { viewed }; },
        filters: async input => { filters = normalizeFilters(input.filters); return configuration(); },
        analysis: async ({ classify }) => { const result = await analyzeReview(review, async path => files.find(file => file.path === path), classify); const map = new Map(result.classifications.map(value => [value.path, value])); return { ...result, classifications: files.map(file => ({ path: file.path, ...map.get(file.path), reasons: ignoredReasons(file, filters, map.get(file.path)) })) }; },
        copilot: async () => { inference++; return {}; }, publish: async () => { publications++; return {}; },
    };
    const server = await startServer(service), browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1500, height: 950 } }), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(server.url); await page.locator('.pr-card').click(); await page.locator('#filter-status').filter({ hasText: 'Local analysis complete' }).waitFor();
        assert.equal(await page.locator('button.file').count(), 5); assert.equal(await page.locator('button.file[data-path="Ref.cs"]').count(), 0);
        assert.equal(await page.locator('button.file[data-path="New.cs"]').count(), 1);
        assert.equal(await page.locator('button.file[data-path="Generated.g.cs"]').count(), 0);
        assert.deepEqual(await page.locator('#status option').evaluateAll(nodes => nodes.map(node => node.value)), ['active', 'my-drafts', 'reviewer', 'completed', 'abandoned', 'all']);
        for (const status of ['my-drafts', 'reviewer', 'active']) {
            const loaded = page.waitForResponse(response => response.url().includes(`api/prs?status=${status}`));
            await page.locator('#status').selectOption(status); await loaded; await page.locator('.pr-card').waitFor();
        }
        assert.deepEqual(views, ['active', 'my-drafts', 'reviewer', 'active']);
        await page.locator('#viewed').check(); await page.locator('#progress').filter({ hasText: '1 / 5 · 2 ignored' }).waitFor();
        await page.locator('#pr-title').click(); await page.keyboard.press('Alt+ArrowDown'); await page.locator('#current-file').filter({ hasText: 'Format.cs' }).waitFor();
        for (const [background, foreground] of [['#0c141c', '#f0f4f8'], ['#faf7f2', '#202020']]) {
            await page.evaluate(({ background, foreground }) => { document.documentElement.style.setProperty('--background-color-default', background); document.documentElement.style.setProperty('--text-color-default', foreground); document.documentElement.style.setProperty('--text-color-muted', foreground); }, { background, foreground });
            await page.waitForFunction(() => [...document.querySelectorAll('.monaco-editor-background')].every(node => getComputedStyle(node).backgroundColor === getComputedStyle(document.body).backgroundColor));
            assert.ok(await page.locator('.monaco-editor-background').count() >= 2);
        }
        await page.locator('#review-filters').click(); assert.equal(await page.locator('#ignore-renames').isChecked(), true); assert.match(await page.locator('#detected-renames').textContent(), /Old → New/);
        assert.equal(await page.locator('#ignore-generated').isChecked(), true);
        for (const name of ['designers', 'migrations']) { assert.equal(await page.locator(`#ignore-${name}`).isChecked(), true); await page.locator(`#ignore-${name}`).uncheck(); }
        await page.locator('#ignore-renames').uncheck(); await page.locator('#filters-form button[type=submit]').click();
        await page.waitForFunction(() => document.querySelectorAll('button.file').length === 6);
        assert.equal(await page.locator('button.file[data-path="Generated.g.cs"]').count(), 0);
        await page.locator('#review-filters').click(); await page.locator('#ignore-generated').uncheck(); await page.locator('#filters-form button[type=submit]').click();
        await page.waitForFunction(() => document.querySelectorAll('button.file').length === 7);
        assert.equal(await page.locator('button.file[data-path="Generated.g.cs"]').count(), 1);
        await page.locator('#review-filters').click(); await page.locator('#ignore-generated').check(); await page.locator('#ignore-renames').check();
        for (const name of ['designers', 'migrations']) { assert.equal(await page.locator(`#ignore-${name}`).isChecked(), false); await page.locator(`#ignore-${name}`).check(); }
        for (const name of ['resources', 'formatting', 'usings']) await page.locator(`#ignore-${name}`).check();
        await page.locator('#filters-form button[type=submit]').click(); await page.waitForFunction(() => document.querySelectorAll('button.file').length === 2);
        assert.deepEqual(await page.locator('button.file').evaluateAll(nodes => nodes.map(node => node.dataset.path)), ['New.cs', 'package.json']);
        assert.equal(await page.locator('#current-file').textContent(), 'New.cs'); assert.equal(files.filter(file => file.viewed).length, 1);
        await page.locator('#dependencies').click(); await page.locator('#dependency-dialog').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#dependency-diagrams svg').count(), 1); assert.match(await page.locator('#dependency-stats').textContent(), /2 changed dependency declarations/);
        assert.match(await page.locator('#dependency-diagrams').textContent(), /1 → 2/); assert.match(await page.locator('#dependency-diagrams').textContent(), /<img src=x/);
        assert.equal(await page.locator('#dependency-diagrams img, #dependency-diagrams script').count(), 0);
        await page.locator('.dependency-owner').click(); await page.locator('#current-file').filter({ hasText: 'package.json' }).waitFor();
        await page.locator('#dependency-file-summary').waitFor({ state: 'visible' });
        await page.locator('#review-filters').click(); await page.locator('#show-ignored').check(); await page.locator('#filters-form button[type=submit]').click();         await page.waitForFunction(() => document.querySelectorAll('button.file').length === 7);
                assert.equal(await page.locator('button.file.ignored-file').count(), 5);
        await page.locator('button.file[data-path="Ref.cs"]').click(); await page.locator('#ignored-file-status').filter({ hasText: 'type-rename references' }).waitFor();
        const markedIgnored = page.waitForResponse(response => response.url().includes('api/viewed'));
        await page.locator('#viewed').check(); await markedIgnored;
        assert.equal(await page.locator('#progress').textContent(), '1 / 2 · 5 ignored');
        await page.reload(); await page.locator('.pr-card').click(); await page.locator('#filter-status').filter({ hasText: 'Local analysis complete' }).waitFor();
        assert.equal(await page.locator('button.file').count(), 7); assert.equal(await page.locator('button.file.ignored-file').count(), 5);
                assert.equal(await page.locator('#progress').textContent(), '1 / 2 · 5 ignored');
        await page.locator('#review-filters').click(); await page.locator('#show-ignored').uncheck(); await page.locator('#ignore-patterns').fill('**/*.cs\npackage.json'); await page.locator('#filters-form button[type=submit]').click();
        await page.waitForFunction(() => document.querySelectorAll('button.file').length === 0 && document.getElementById('current-file').textContent.includes('All files ignored'));
        assert.equal(await page.evaluate(() => monaco.editor.getModels().length), 0);
        assert.equal(await page.locator('#progress').textContent(), '0 / 0 · 7 ignored');
        await page.locator('#review-filters').click(); await page.locator('#show-ignored').check(); await page.locator('#filters-form button[type=submit]').click(); await page.waitForFunction(() => monaco.editor.getModels().length === 2);
        assert.equal(inference, 0); assert.equal(publications, 0); assert.deepEqual(errors, []);
    } finally { await browser.close(); await server.close(); }
});
