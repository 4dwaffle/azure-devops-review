export async function selectReviewLines(page, host, side) {
    const pane = page.locator(`${host} .editor.${side === 'left' ? 'original' : 'modified'}`);
    await pane.locator('.view-lines').click({ position: { x: 60, y: 10 } });
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
}
