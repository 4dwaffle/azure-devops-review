import assert from 'node:assert/strict';

export async function verifyEditorFind(page, root, sides = ['original', 'modified']) {
    for (const side of sides) {
        const pane = page.locator(`${root} .editor.${side}`);
        await pane.locator('.view-line span').filter({ hasText: /^class$/ }).last().dblclick();
        await page.keyboard.press('Control+f');
        const search = pane.getByRole('textbox', { name: 'Find', exact: true });
        await search.waitFor({ state: 'visible' });
        assert.equal(await search.inputValue(), 'class', `${side}: selected word seeds current-file Find`);
        assert.equal(await search.evaluate(node => node === document.activeElement), true);
        await pane.locator('.find-widget .matchesCount').filter({ hasText: '1 of 1' }).waitFor();
        await page.keyboard.press('Escape');
        await search.waitFor({ state: 'hidden' });
    }
}
