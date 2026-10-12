import { posix, resolve, sep } from 'node:path';
import { parseFromFilesSync } from 'editorconfig';

export function generatedFilename(path) {
    const name = posix.basename(path);
    return /^TemporaryGeneratedFile_/i.test(name) || /\.(designer|generated|g|g\.i)\.[^.]+$/i.test(name);
}
export function generatedHeader(path, text) {
    if (typeof text !== 'string' || !/\.(cs|csx|vb)$/i.test(path)) return false;
    const prefix = text.slice(0, 65536); let index = 0;
    while (index < prefix.length) {
        const rest = prefix.slice(index), space = /^\s+/u.exec(rest);
        if (space) { index += space[0].length; continue; }
        let comment;
        if (/\.vb$/i.test(path)) comment = /^(?:'|REM\s)[^\r\n]*/i.exec(rest)?.[0];
        else if (rest.startsWith('//')) comment = /^[^\r\n]*/.exec(rest)[0];
        else if (rest.startsWith('/*')) {
            const end = rest.indexOf('*/', 2);
            if (end < 0) return false;
            comment = rest.slice(0, end + 2);
        }
        if (!comment) return false;
        const documentation = /\.vb$/i.test(path) ? comment.startsWith("'''") : comment.startsWith('///') || comment.startsWith('/**');
        if (!documentation && /<auto-?generated/.test(comment)) return true;
        index += comment.length;
    }
    return false;
}
export function generatedClassifier(configurations = {}) {
    const root = resolve(sep, 'azure-review-immutable'), caches = { base: new Map(), source: new Map() };
    const classify = (path, text, side) => {
        const configs = configurations[side] || [];
        if (configs.some(config => config.error || /(?:^|\n)\s*is_global\s*=\s*true\s*(?:\r?\n|$)/i.test(config.contents || '') || /\.globalconfig$/i.test(config.path) && /(?:^|\n)\s*generated_code\s*=/i.test(config.contents || ''))) return null;
        const ancestors = configs.filter(config => posix.basename(config.path) === '.editorconfig' && (posix.dirname(config.path) === '.' || path.startsWith(`${posix.dirname(config.path)}/`))).sort((a, b) => b.path.length - a.path.length);
        try {
            const options = parseFromFilesSync(resolve(root, ...path.split('/')), ancestors.map(config => ({ name: resolve(root, ...config.path.split('/')), contents: Buffer.from(config.contents) })), { root, cache: caches[side] });
            const override = String(options.generated_code ?? '').trim().toLowerCase();
            if (override === 'false') return false;
            if (override === 'true') return '.editorconfig generated_code = true';
        } catch { return null; }
        if (generatedFilename(path)) return 'Roslyn filename convention';
        return generatedHeader(path, text) ? 'leading auto-generated comment' : false;
    };
    return (file, content = {}) => {
        const before = file.status?.startsWith('A') ? true : classify(file.oldPath || file.path, content.original, 'base');
        const after = file.status?.startsWith('D') ? true : classify(file.path, content.modified, 'source');
        const generated = Boolean(before && after);
        return { generated, generatedReason: generated ? [...new Set([before, after].filter(value => typeof value === 'string'))].join('; ') : null };
    };
}
