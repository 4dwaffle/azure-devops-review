import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';
const executablePath = process.env.REVIEW_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
test('real Monaco worker, 70-file navigation, selection sides, drafts and zero implicit inference', { skip: !existsSync(executablePath), timeout: 90000 }, async () => {
    const files = Array.from({ length: 70 }, (_, index) => ({ path: `Folder${Math.floor(index / 10)}/File${index}.cs`, oldPath: `Folder${Math.floor(index / 10)}/File${index}.cs`, status: 'M', fingerprint: String(index), viewed: false }));
    const pr = { organization: 'org', project: 'project', repositoryId: 'repo', id: 1, title: 'Browser fixture', repository: 'repository', createdBy: 'Reviewer', sourceRefName: 'refs/heads/source', targetRefName: 'refs/heads/main' };
    const review = { key: 'org/repo/1', pr, iteration: { id: 2 }, base: 'a'.repeat(40), worktree: { path: 'local fixture' }, files, threads: [], drafts: [] };
    let inference = 0, publications = 0, previews = 0, writeEnabled = false; const copilotInputs = [];
    const configuration = () => ({ organization: 'org', roots: ['C:\\fixture'], writeEnabled, liveWriteVerification: false, roslyn: { available: false } });
    const service = {
        config: async () => configuration(),
        configure: async input => { writeEnabled = input.writeEnabled; return configuration(); },
        list: async () => ({ pullRequests: [pr] }), open: async () => review,
        analysis: async () => ({ classifications: files.map(file => ({ path: file.path, reasons: [] })), renames: { pairs: [] }, dependencies: { nodes: [], edges: [], changes: 0, manifests: 0, warnings: [] } }),
        file: async (_, path) => ({ ...files.find(file => file.path === path), original: 'class C { int x = 1; }\n', modified: 'class C { int x = 2; }\n', language: 'csharp', binary: false, threads: [{ id: 7, status: 'active', threadContext: { filePath: `/${path}`, rightFileStart: { line: 1, offset: 1 } }, comments: [{ author: { displayName: 'Existing reviewer' }, content: 'Existing inline comment' }] }] }),
        viewed: async ({ path, viewed }) => { files.find(file => file.path === path).viewed = viewed; return { viewed }; },
        draft: async input => { review.drafts.push({ ...input, id: 'draft-1', iteration: 2, status: 'draft' }); return { drafts: review.drafts }; },
        copilot: async input => { inference++; copilotInputs.push(input); return { queued: true }; },
        preparePublish: async () => { previews++; return { key: review.key, prId: pr.id, iteration: review.iteration.id, planToken: 'fixture-plan', payloads: review.drafts.map(draft => ({ draft, body: { threadContext: { filePath: `/${draft.path}` } } })), liveWriteVerification: false }; },
        publish: async input => { assert.equal(input.planToken, 'fixture-plan'); publications++; const published = review.drafts.map((_, index) => index + 1); review.drafts = []; return { published, drafts: [] }; },
    };
    const server = await startServer(service); const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } }); const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const consoleMessages = []; page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleMessages.push(message.text()); });
        await page.goto(server.url); await page.locator('.pr-card').click(); await page.locator('#current-file').filter({ hasText: 'Folder0/File0.cs' }).waitFor();
        await page.waitForFunction(() => window.monaco?.editor.getModels().length === 2);
        const initial = await page.evaluate(() => window.reviewCanvasDiagnostics());
        assert.equal(initial.monacoLoaded, true); assert.equal(initial.diffEditorReady, true); assert.equal(initial.workerVerified, true, JSON.stringify({ initial, consoleMessages, errors }));
        assert.equal(await page.locator('button.file').count(), 70); assert.equal(initial.modelCount, 2); assert.equal(initial.changedLines, 1); assert.ok(initial.workerCount > 0);
        await page.locator('#viewed').check(); await page.waitForFunction(() => document.getElementById('progress').textContent === '1 / 70');
        await page.locator('#code .editor.original .view-lines').click(); await page.locator('#comment').click();
        assert.match(await page.locator('#comment-location').textContent(), /left L\d+/);
        await page.locator('#comment-content').fill('Local draft only'); await page.locator('#comment-form button[type=submit]').click();
        await page.locator('#drafts').filter({ hasText: 'Local draft only' }).waitFor(); assert.equal(review.drafts[0].side, 'left');
        assert.equal(await page.locator('#publish').isDisabled(), true);
        assert.equal(await page.locator('.thread-location').isDisabled(), true);
        await page.locator('#settings-button').click(); assert.equal(await page.locator('#write-enabled').isDisabled(), false); assert.equal(await page.locator('#write-enabled').isChecked(), false); await page.locator('#close-settings').click();
        for (let index = 1; index <= 20; index++) await page.locator(`button.file[data-path="${files[index].path}"]`).click();
        await page.waitForFunction(() => document.getElementById('current-file').textContent === 'Folder2/File20.cs');
        assert.equal((await page.evaluate(() => window.reviewCanvasDiagnostics())).modelCount, 2);
        await page.locator('#pr-title').click(); await page.keyboard.press('Alt+ArrowDown'); await page.waitForFunction(() => document.getElementById('current-file').textContent === 'Folder2/File21.cs');
        await page.keyboard.press('Control+p'); assert.equal(await page.locator('#file-filter').evaluate(node => node === document.activeElement), true);
        await page.locator('#file-filter').fill('File69.cs'); assert.equal(await page.locator('button.file').count(), 1); await page.locator('button.file').click();
        await page.waitForFunction(() => document.getElementById('current-file').textContent === 'Folder6/File69.cs');
        await page.locator('#copilot').click(); await page.locator('#copilot-instruction').fill('Explain selection'); await page.locator('#copilot-form button[type=submit]').click();
        await page.waitForFunction(() => document.getElementById('notice').textContent.includes('Selection sent')); assert.equal(inference, 1); assert.equal(publications, 0);
        await page.locator('#copilot').click(); await page.locator('#copilot-scope').selectOption('file'); await page.locator('#copilot-form button[type=submit]').click();
        await page.locator('#copilot-dialog').waitFor({ state: 'hidden' }); assert.equal(inference, 2); assert.equal(copilotInputs[1].startLine, undefined);
        await page.locator('#file-filter').fill('Folder6/');
        await page.locator('input[data-selection-path="Folder6/File68.cs"]').check(); await page.locator('input[data-selection-path="Folder6/File69.cs"]').check();
        await page.locator('#copilot').click(); assert.equal(await page.locator('#copilot-scope').inputValue(), 'files'); await page.locator('#copilot-form button[type=submit]').click();
        await page.locator('#copilot-dialog').waitFor({ state: 'hidden' }); assert.equal(inference, 3); assert.deepEqual(copilotInputs[2].paths, ['Folder6/File68.cs', 'Folder6/File69.cs']);
        assert.equal(publications, 0); assert.deepEqual(errors, []);
        await page.evaluate(() => { const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.authority === 'base'); editor.focus(); editor.setSelection(new monaco.Selection(1, 7, 1, 10)); });
        await page.locator('#comment').click(); await page.locator('#comment-content').fill('Precise word range'); await page.locator('#comment-form button[type=submit]').click();
        await page.locator('#composer').waitFor({ state: 'hidden' }); assert.equal(review.drafts.at(-1).startOffset, 6); assert.equal(review.drafts.at(-1).endOffset, 8);
        await page.evaluate(() => { const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.authority === 'base'); editor.focus(); editor.setSelection(new monaco.Selection(1, 1, 2, 1)); });
        await page.locator('#comment').click(); await page.locator('#comment-content').fill('Whole first line'); await page.locator('#comment-form button[type=submit]').click();
        await page.locator('#composer').waitFor({ state: 'hidden' }); assert.equal(review.drafts.at(-1).endLine, 1); assert.equal(review.drafts.at(-1).startOffset, 0);
        await page.setViewportSize({ width: 900, height: 850 }); await page.waitForTimeout(100);
        await page.locator('#preview-publish').click(); await page.locator('#publish-preview').waitFor({ state: 'visible' }); assert.equal(previews, 1); assert.equal(publications, 0); assert.match(await page.locator('#publish-plan').textContent(), /Precise word range/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false); await page.locator('#close-publish-preview').click();
        await page.locator('#settings-button').click(); await page.locator('#write-enabled').check(); await page.locator('#config-form button[type=submit]').click(); await page.locator('#settings').waitFor({ state: 'hidden' });
        page.once('dialog', dialog => dialog.dismiss()); await page.locator('#publish').click(); await page.waitForFunction(() => !document.getElementById('publish').disabled); assert.equal(previews, 2); assert.equal(publications, 0);
        page.once('dialog', dialog => dialog.accept()); await page.locator('#publish').click(); await page.waitForFunction(() => document.getElementById('drafts').children.length === 0); assert.equal(previews, 3); assert.equal(publications, 1); assert.equal(inference, 3);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        await page.reload(); await page.locator('.pr-card').click(); await page.waitForFunction(() => document.getElementById('progress').textContent === '1 / 70');
        assert.equal(inference, 3);
    } finally { await browser.close(); await server.close(); }
});
