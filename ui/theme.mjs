let signature = '';
const pixel = document.createElement('canvas'); pixel.width = pixel.height = 1;
const context = pixel.getContext('2d', { willReadFrequently: true });
function color(value, fallback) {
    context.clearRect(0, 0, 1, 1); context.fillStyle = fallback; context.fillStyle = value || fallback; context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}
export function applyAppTheme(monaco, editor) {
    const styles = getComputedStyle(document.body);
    const background = color(styles.getPropertyValue('--background-color-default').trim(), styles.backgroundColor);
    const foreground = color(styles.getPropertyValue('--text-color-default').trim(), styles.color);
    const muted = color(styles.getPropertyValue('--text-color-muted').trim(), foreground);
    const border = color(styles.getPropertyValue('--border-color-default').trim(), muted);
    const accent = color(styles.getPropertyValue('--true-color-blue').trim(), foreground);
    const font = styles.getPropertyValue('--font-mono').trim() || 'monospace';
    const next = JSON.stringify({ background, foreground, muted, border, accent, font }); if (next === signature) return;
    signature = next;
    const channels = background.slice(1).match(/../g).map(value => parseInt(value, 16));
    const dark = channels.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0) < 128;
    monaco.editor.defineTheme('app-review', { base: dark ? 'vs-dark' : 'vs', inherit: true,
        rules: [{ token: '', foreground: foreground.slice(1) }, { token: 'comment', foreground: muted.slice(1) }],
        colors: {
            'editor.background': background, 'editor.foreground': foreground,
            'editorGutter.background': background, 'editorLineNumber.foreground': muted, 'editorLineNumber.activeForeground': foreground,
            'editor.lineHighlightBackground': background, 'editor.lineHighlightBorder': background,
            'editorWidget.background': background, 'editorWidget.border': border, 'editorWidget.foreground': foreground,
            'editorHoverWidget.background': background, 'editorHoverWidget.foreground': foreground, 'editorHoverWidget.border': border,
            'editorOverviewRuler.background': background, 'editorOverviewRuler.border': background,
            'editorIndentGuide.background1': border, 'editorIndentGuide.activeBackground1': muted,
            'editor.selectionBackground': `${accent}33`, 'editor.inactiveSelectionBackground': `${muted}22`,
            'editorCursor.foreground': foreground, 'editorWhitespace.foreground': border,
            'minimap.background': background, 'diffEditor.diagonalFill': background,
            'diffEditor.insertedLineBackground': '#00000000', 'diffEditor.removedLineBackground': '#00000000',
            'diffEditor.border': border, 'scrollbar.shadow': '#00000000',
            'scrollbarSlider.background': `${muted}33`, 'scrollbarSlider.hoverBackground': `${muted}55`, 'scrollbarSlider.activeBackground': `${muted}77`,
        },
    });
    monaco.editor.setTheme('app-review'); editor.updateOptions({ fontFamily: font });
}
export function watchAppTheme(monaco, editor) {
    let pending = false;
    const update = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; applyAppTheme(monaco, editor); }); } };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true }); observer.observe(document.body, { attributes: true });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
    applyAppTheme(monaco, editor);
}
