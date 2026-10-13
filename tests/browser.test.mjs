import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';
import { verifyEditorFind } from './editor-find.mjs';
import { selectReviewLines } from './editor-comments.mjs';
const executablePath = process.env.REVIEW_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
test('real Monaco worker, 70-file navigation, selection sides, drafts and zero implicit inference', { skip: !existsSync(executablePath), timeout: 90000 }, async () => {
    const files = Array.from({ length: 70 }, (_, index) => ({ path: `Folder${Math.floor(index / 10)}/File${index}.cs`, oldPath: `Folder${Math.floor(index / 10)}/File${index}.cs`, status: 'M', fingerprint: String(index), viewed: false }));
    files[9].path = files[9].oldPath = 'Folder0/Nested/File9.cs';
    const pr = { organization: 'org', project: 'project', repositoryId: 'repo', id: 1, title: 'Browser fixture', repository: 'repository', createdBy: 'Reviewer', sourceRefName: 'refs/heads/source', targetRefName: 'refs/heads/main' };
    const review = { key: 'org/repo/1', pr, iteration: { id: 2 }, source: 'b'.repeat(40), base: 'a'.repeat(40), worktree: { path: 'local fixture' }, files, threads: [], drafts: [] };
    let inference = 0, publications = 0, previews = 0, writeEnabled = false, failViewed = false; const copilotInputs = [];
    const configuration = () => ({ organization: 'org', roots: ['C:\\fixture'], writeEnabled, liveWriteVerification: false, roslyn: { available: false } });
    const service = {
        config: async () => configuration(),
        configure: async input => { writeEnabled = input.writeEnabled; return configuration(); },
        list: async () => ({ pullRequests: [pr] }), open: async () => review,
        analysis: async () => ({ classifications: files.map(file => ({ path: file.path, reasons: [] })), renames: { pairs: [] }, dependencies: { nodes: [], edges: [], changes: 0, manifests: 0, warnings: [] } }),
        file: async (_, path) => ({ ...files.find(file => file.path === path), original: 'class C {\n int x = 1;\n int y = 3;\n}\n', modified: 'class C {\n int x = 2;\n int y = 3;\n}\n', language: 'csharp', binary: false, threads: [{ id: 7, status: 'active', threadContext: { filePath: `/${path}`, rightFileStart: { line: 1, offset: 1 } }, comments: [{ author: { displayName: 'Existing reviewer' }, content: 'Existing inline comment' }] }] }),
        viewed: async ({ path, viewed }) => { if (failViewed) throw new Error('Progress write failed'); files.find(file => file.path === path).viewed = viewed; return { viewed }; },
        viewedMany: async ({ paths, viewed, source, base }) => { assert.equal(source, review.source); assert.equal(base, review.base); if (failViewed) throw new Error('Progress write failed'); for (const path of paths) files.find(file => file.path === path).viewed = viewed; return { paths, viewed }; },
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
        await verifyEditorFind(page, '#diff');
        assert.equal(inference, 0, 'Editor Find never invokes Copilot');
        for (const side of ['left', 'right']) {
            for (const action of ['toolbar', 'shortcut', 'context-menu']) {
                await selectReviewLines(page, '#diff', side);
                if (action === 'toolbar') await page.click('#comment');
                else if (action === 'shortcut') await page.keyboard.press('Control+m');
                else { await page.keyboard.press('Shift+F10'); const item = page.getByRole('menuitem', { name: /Add review comment on selected lines/ }); await item.hover(); await page.waitForTimeout(150); await item.click(); }
                await page.locator('#composer').waitFor({ state: 'visible', timeout: 5000 }).catch(async error => { throw new Error(`${side} ${action}: ${await page.locator('#notice').innerText()} · ${errors} · ${error.message}`); });
                assert.match(await page.locator('#comment-location').textContent(), new RegExp(`${side} L1-2`));
                await page.fill('#comment-content', `Multi-line ${side} ${action}`); await page.locator('#comment-form button[type=submit]').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
                const saved = review.drafts.pop(); assert.equal(saved.side, side); assert.equal(saved.startLine, 1); assert.equal(saved.endLine, 2); assert.equal(saved.startOffset, 0);
            }
        }
        assert.equal(inference, 0, 'Selecting lines and drafting never invoke Copilot');
        const reviewed = page.getByRole('checkbox', { name: 'Reviewed Folder0/File0.cs', exact: true });
        assert.equal(await reviewed.isChecked(), false, 'Opening does not mark reviewed');
        await reviewed.check(); await page.waitForFunction(() => document.getElementById('progress').textContent === '1 / 70');
        assert.equal(await page.locator('#viewed').isChecked(), true);
        failViewed = true; await reviewed.click(); await page.locator('#notice').filter({ hasText: 'Progress write failed' }).waitFor();
        assert.equal(await reviewed.isChecked(), true); assert.equal(await page.locator('#viewed').isChecked(), true); failViewed = false;
        await reviewed.uncheck(); await page.waitForFunction(() => document.getElementById('progress').textContent === '0 / 70');
        const folder = page.getByRole('checkbox', { name: 'Reviewed folder Folder0', exact: true });
        const details = page.locator('details[data-folder="Folder0"]');
        await reviewed.check(); await page.waitForFunction(() => document.getElementById('progress').textContent === '1 / 70');
        assert.equal(await folder.evaluate(node => node.indeterminate), true);
        await page.fill('#file-filter', 'File0.cs'); await folder.check(); await page.waitForFunction(() => document.getElementById('progress').textContent === '10 / 70');
        assert.equal(files[9].viewed, true, 'Search-hidden nested descendant included');
        await page.fill('#file-filter', ''); await details.locator(':scope > summary').click(); assert.equal(await details.evaluate(node => node.open), false);
        failViewed = true; await folder.click(); await page.locator('#notice').filter({ hasText: 'Progress write failed' }).waitFor(); assert.equal(await folder.isChecked(), true); failViewed = false;
        assert.equal(await details.evaluate(node => node.open), false, 'Failed checkbox write preserves collapse');
        await page.reload(); await page.locator('.pr-card').click(); await page.waitForFunction(() => document.getElementById('progress').textContent === '10 / 70'); assert.equal(await folder.isChecked(), true);
        await details.locator(':scope > summary').click(); await folder.uncheck(); await page.waitForFunction(() => document.getElementById('progress').textContent === '0 / 70'); assert.equal(await details.evaluate(node => node.open), false, 'Checkbox must not expand folder');
        await details.locator(':scope > summary').click();
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
        assert.equal(await page.locator('input[data-selection-path], input[data-selection-folder], #select-visible, #mark-selected-reviewed').count(), 0);
        assert.equal(await page.getByRole('checkbox', { name: 'Reviewed Folder6/File69.cs', exact: true }).evaluate(node => node.parentElement.firstElementChild === node), true);
        assert.equal(inference, 2);
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
        page.once('dialog', dialog => dialog.accept()); await page.locator('#publish').click(); await page.waitForFunction(() => document.getElementById('drafts').children.length === 0); assert.equal(previews, 3); assert.equal(publications, 1); assert.equal(inference, 2);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        await page.reload(); await page.locator('.pr-card').click(); await page.waitForFunction(() => document.getElementById('progress').textContent === '1 / 70');
        assert.equal(inference, 2);
    } finally { await browser.close(); await server.close(); }
});
