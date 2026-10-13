import { posix } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { generatedClassifier } from './generated-code.mjs';
const operators = ['>>>=', '>>=', '<<=', '??=', '=>', '??', '?.', '::', '->', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '..'];
export const defaultFilters = { resources: false, formatting: false, usings: false, renames: true, projectReferenceRenames: true, namespaceRenames: false, generated: true, designers: true, migrations: true, patterns: [], showIgnored: false };
export function normalizeFilters(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review filters');
    const patterns = value.patterns ?? [];
    if (!Array.isArray(patterns) || patterns.length > 50 || patterns.some(pattern => typeof pattern !== 'string' || !pattern.trim() || pattern.length > 200 || /[\r\n\0\\]/.test(pattern))) throw new Error('Provide up to 50 relative ignore globs, using / separators and at most 200 characters each');
    return { resources: value.resources === true, formatting: value.formatting === true, usings: value.usings === true, renames: value.renames !== false, projectReferenceRenames: value.projectReferenceRenames !== false, namespaceRenames: value.namespaceRenames === true, generated: value.generated !== false, designers: value.designers !== false, migrations: value.migrations !== false, patterns: [...new Set(patterns.map(pattern => pattern.trim()))], showIgnored: value.showIgnored === true };
}
export function resourcePath(path) { return /\.(resx|resources|xlf|xliff|po|pot)$/i.test(path) || /(?:^|\/)[^/]*Resources(?:\.Designer)?\.cs$/i.test(path); }
function tokens(text) {
    if (text.length > 200000 || /^\s*#/m.test(text) || /(?:\$+@?"|@\$+")/.test(text)) return null;
    const result = []; let index = 0;
    while (index < text.length) {
        const rest = text.slice(index); let token;
        if (/^\s/u.test(rest)) { index++; continue; }
        if (rest.startsWith('//')) { const end = rest.indexOf('\n'); token = end < 0 ? rest : rest.slice(0, end).replace(/\r$/, ''); }
        else if (rest.startsWith('/*')) { const end = rest.indexOf('*/', 2); if (end < 0) return null; token = rest.slice(0, end + 2); }
        else if (rest.startsWith('@"')) {
            let end = 2;
            while (end < rest.length) { if (rest[end] === '"') { if (rest[end + 1] === '"') end += 2; else break; } else end++; }
            if (end >= rest.length) return null; token = rest.slice(0, end + 1);
        } else if (rest[0] === '"' || rest[0] === "'") {
            const quotes = rest.match(/^"{3,}/)?.[0];
            if (quotes) { const end = rest.indexOf(quotes, quotes.length); if (end < 0) return null; token = rest.slice(0, end + quotes.length); }
            else {
                let end = 1;
                while (end < rest.length && rest[end] !== rest[0]) { if (rest[end] === '\\') end += 2; else { if (rest[end] === '\n' || rest[end] === '\r') return null; end++; } }
                if (end >= rest.length) return null; token = rest.slice(0, end + 1);
            }
        } else if (rest[0] === '\\') return null;
        else token = rest.match(/^@?[\p{ID_Start}_][\p{ID_Continue}_]*/u)?.[0] || rest.match(/^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)[uUlLfFdDmM]*/)?.[0] || operators.find(operator => rest.startsWith(operator)) || rest[0];
        if (token.startsWith('"') && rest.slice(token.length).startsWith('u8')) token += 'u8';
        result.push(token); index += token.length;
    }
    return result;
}
const commentToken = token => token.startsWith('//') || token.startsWith('/*');
function withoutUsings(values) {
    const result = [], scopes = []; let pendingNamespace = false, removed = 0;
    for (let index = 0; index < values.length; index++) {
        const token = values[index];
        if (scopes.every(scope => scope === 'namespace') && (token === 'using' || (token === 'global' && values[index + 1] === 'using'))) {
            const start = index, usingIndex = token === 'using' ? index : index + 1;
            let end = usingIndex + 1;
            while (end < values.length && ![';', '{', '}'].includes(values[end])) end++;
            const content = values.slice(usingIndex + 1, end);
            const identifier = '@?[\\p{ID_Start}_][\\p{ID_Continue}_]*', name = `${identifier}(?:(?:\\.|::)${identifier})*`;
            const spelling = content.join(' ');
            const directive = new RegExp(`^(?:static )?${name.replaceAll('(?:\\.|::)', ' (?:\\.|::) ')}$`, 'u');
            const alias = new RegExp(`^${identifier} = ${name.replaceAll('(?:\\.|::)', ' (?:\\.|::) ')}$`, 'u');
            if (values[end] === ';' && !content.some(commentToken) && (directive.test(spelling) || alias.test(spelling))) { index = end; removed++; continue; }
            index = start;
        }
        if (token === 'namespace') pendingNamespace = true;
        if (token === '{') { scopes.push(pendingNamespace ? 'namespace' : 'other'); pendingNamespace = false; }
        else if (token === '}') scopes.pop();
        else if (token === ';') pendingNamespace = false;
        result.push(token);
    }
    return { values: result, removed };
}
function leadingUsings(text) {
    const header = text.match(/^(?:\s*(?:global\s+)?using\b[^;{}]*;)+/)?.[0] || '';
    const values = tokens(header), stripped = values && withoutUsings(values);
    if (!stripped || stripped.values.length) return null;
    return { values, removed: stripped.removed, body: text.slice(header.length) };
}
export function classifyChange(path, original, modified) {
    const result = { resource: resourcePath(path), formattingOnly: false, usingsOnly: false };
    if (!original || !modified || original === modified || !/\.(cs|json)$/i.test(path)) return result;
    if (/\.json$/i.test(path)) { try { JSON.parse(original); JSON.parse(modified); } catch { return result; } }
    if (/\.cs$/i.test(path)) {
        const left = leadingUsings(original), right = leadingUsings(modified);
        result.usingsOnly = !!left && !!right && left.removed + right.removed > 0 && left.body === right.body && JSON.stringify(left.values) !== JSON.stringify(right.values);
    }
    const before = tokens(original), after = tokens(modified); if (!before || !after) return result;
    result.formattingOnly = JSON.stringify(before) === JSON.stringify(after);
    if (!result.formattingOnly && /\.cs$/i.test(path)) {
        const left = withoutUsings(before), right = withoutUsings(after);
        result.usingsOnly = left.removed + right.removed > 0 && JSON.stringify(left.values) === JSON.stringify(right.values);
    }
    return result;
}
export function ignoredReasons(file, filters, classification = {}) {
    const reasons = [];
    const bothPaths = predicate => predicate(file.path) && (!file.oldPath || file.status?.startsWith('A') || predicate(file.oldPath));
    if (!file.modeChanged && filters.designers && bothPaths(path => /\.designer\.[^/.]+$/i.test(path))) reasons.push('designer file');
    if (!file.modeChanged && filters.migrations && bothPaths(path => /(?:^|\/)migrations\//i.test(path))) reasons.push('migration folder');
    if (filters.resources && resourcePath(file.path)) reasons.push('resource file');
    if (!file.modeChanged && filters.generated && classification.generated) reasons.push(`generated code: ${classification.generatedReason}`);
    if (!file.modeChanged && filters.formatting && classification.formattingOnly) reasons.push('formatting only');
    if (!file.modeChanged && filters.usings && classification.usingsOnly) reasons.push('using directives only');
    if (!file.modeChanged && filters.renames && classification.renameOnly) reasons.push(classification.fileRenameOnly ? 'file/path rename only' : 'detected type-rename references only');
    if (!file.error && !file.binary && !file.modeChanged && filters.projectReferenceRenames !== false && classification.projectReferenceRenameOnly) reasons.push('project-reference path rename propagation only');
    if (!file.error && !file.binary && !file.modeChanged && filters.namespaceRenames && classification.namespaceTextOnly) reasons.push('namespace rename propagation (text-only; not compiler-verified)');
    for (const pattern of filters.patterns || []) if (posix.matchesGlob(file.path, pattern)) { reasons.push(`pattern: ${pattern}`); break; }
    return reasons;
}
export function dependencyManifest(path) { return /\.(csproj|fsproj|vbproj|props|targets)$/i.test(path) || /(?:^|\/)(?:packages\.config|packages\.lock\.json|package\.json|package-lock\.json)$/i.test(path); }
function dependency(owner, kind, name, version = '', scope = '', condition = '', metadata = {}) {
    const target = kind === 'project' ? `file:${posix.normalize(posix.join(posix.dirname(owner), name.replaceAll('\\', '/')))}` : `${kind}:${name}`;
    const key = JSON.stringify([owner, target, scope, condition]);
    return { key, from: `file:${owner}`, to: target, owner, kind, name, version: String(version).trim(), scope, condition, metadata };
}
function xmlDependencies(path, text) {
    if (/<!DOCTYPE/i.test(text)) throw new Error('DTD manifests are not analyzed');
    const valid = XMLValidator.validate(text); if (valid !== true) throw new Error(`Invalid XML: ${valid.err.msg}`);
    const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, processEntities: false, removeNSPrefix: true }).parse(text), values = [];
    const visit = (object, inheritedCondition = '') => {
        if (!object || typeof object !== 'object') return;
        if (Array.isArray(object)) { object.forEach(value => visit(value, inheritedCondition)); return; }
        const own = object['@_Condition']?.trim(), condition = [inheritedCondition, own].filter(Boolean).join(' && ');
        for (const [tag, entries] of Object.entries(object)) {
            if (tag.startsWith('@_')) continue;
            for (const entry of Array.isArray(entries) ? entries : [entries]) {
                const type = ({ PackageReference: 'nuget', PackageVersion: 'nuget', ProjectReference: 'project', FrameworkReference: 'framework', Reference: 'assembly', package: 'nuget' })[tag];
                if (type && entry && typeof entry === 'object') {
                    const name = entry['@_Include'] || entry['@_Update'] || entry['@_id'];
                    if (typeof name === 'string' && name.trim()) {
                        const ownCondition = entry['@_Condition']?.trim(), edgeCondition = [condition, ownCondition].filter(Boolean).join(' && ');
                        const metadata = {};
                        for (const field of ['PrivateAssets', 'IncludeAssets', 'ExcludeAssets', 'Aliases', 'ReferenceOutputAssembly', 'HintPath']) { const value = entry[`@_${field}`] ?? entry[field]; if (typeof value === 'string') metadata[field] = value.trim(); }
                        const version = entry['@_VersionOverride'] ?? entry.VersionOverride ?? entry['@_Version'] ?? entry['@_version'] ?? entry.Version ?? '';
                        if (typeof version !== 'string') throw new Error('Unsupported nested version expression');
                        values.push(dependency(path, type, name.trim(), version, tag, edgeCondition, metadata));
                    }
                } else visit(entry, condition);
            }
        }
    };
    visit(parsed); return values;
}
function jsonDependencies(path, text) {
    const object = JSON.parse(text), values = [], leaf = posix.basename(path).toLowerCase();
    const packages = (entries, scope) => { if (entries && typeof entries === 'object') for (const [name, version] of Object.entries(entries)) if (typeof version === 'string') values.push(dependency(path, 'npm', name, version, scope)); };
    if (leaf === 'packages.lock.json') {
        for (const [framework, entries] of Object.entries(object.dependencies || {})) for (const [name, entry] of Object.entries(entries)) values.push(dependency(path, 'nuget', name, entry.resolved || entry.requested || '', `${framework}/${entry.type || 'locked'}`, '', { requested: entry.requested || '' }));
    } else if (leaf === 'package-lock.json') {
        if (object.packages) {
            for (const [location, entry] of Object.entries(object.packages)) if (location.includes('node_modules/')) values.push(dependency(path, 'npm', entry.name || location.split('node_modules/').at(-1), entry.version || '', `locked: ${location}`, '', { resolved: entry.resolved || '', integrity: entry.integrity || '' }));
        } else {
            const visit = (entries, scope = 'locked') => { for (const [name, entry] of Object.entries(entries || {})) { values.push(dependency(path, 'npm', name, entry.version || '', scope)); if (entry.dependencies) visit(entry.dependencies, `${scope}/${name}`); } }; visit(object.dependencies);
        }
    } else {
        for (const scope of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'resolutions']) packages(object[scope], scope);
        const overrides = (entries, parent = '') => { for (const [name, value] of Object.entries(entries || {})) { if (typeof value === 'string') values.push(dependency(path, 'npm', name === '.' ? parent : name, value, `overrides${parent ? `/${parent}` : ''}`)); else if (value && typeof value === 'object') overrides(value, name); } }; overrides(object.overrides);
    }
    return values;
}
export function parseDependencies(path, text) {
    if (!text.trim()) return [];
    if (Buffer.byteLength(text, 'utf8') > 2000000) throw new Error('Manifest exceeds the 2 MB analysis limit');
    const values = /\.json$/i.test(path) ? jsonDependencies(path, text) : xmlDependencies(path, text);
    const unique = new Map();
    for (const value of values) { if (unique.has(value.key)) throw new Error('Duplicate dependency declarations require manual review'); unique.set(value.key, value); }
    return values;
}
function sourceDependencies(path, text) {
    if (!text.trim()) return [];
    const values = tokens(text);
    if (!values) throw new Error('Unsupported C# syntax or source size; source dependency diagram is incomplete');
    const result = new Map();
    for (let index = 0; index < values.length; index++) {
        if (values[index] !== 'using') continue;
        let end = index + 1;
        while (end < values.length && ![';', '{', '}'].includes(values[end])) end++;
        if (values[end] !== ';') continue;
        let name = values.slice(index + 1, end);
        if (name[0] === 'static') name = name.slice(1);
        if (name[1] === '=') name = name.slice(2);
        if (!name.length || !name.every((token, i) => i % 2 ? token === '.' || token === '::' : /^@?[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(token))) continue;
        const edge = dependency(path, 'csharp-import', name.join(''), '', 'explicit using (syntax only)');
        result.set(edge.key, edge);
    }
    return [...result.values()];
}
export function dependencyDelta(files) {
    const before = new Map(), after = new Map(), warnings = []; let manifests = 0, sourceFiles = 0;
    for (const file of files) {
        const source = /\.cs$/i.test(file.path);
        if (!source && !dependencyManifest(file.path) && !dependencyManifest(file.oldPath || file.path)) continue;
        if (source) sourceFiles++; else manifests++;
        try {
            if (file.binary || file.error) throw new Error(file.reason || file.error || 'Binary file');
            const parse = source ? sourceDependencies : parseDependencies;
            const left = parse(file.oldPath || file.path, file.original), right = parse(file.path, file.modified);
            left.forEach(value => before.set(value.key, value)); right.forEach(value => after.set(value.key, value));
        } catch (error) { warnings.push({ path: file.path, message: error.message }); }
    }
    const edges = [], nodes = new Map();
    for (const key of new Set([...before.keys(), ...after.keys()])) {
        const left = before.get(key), right = after.get(key), value = right || left;
        const status = !left ? 'added' : !right ? 'removed' : JSON.stringify(left) === JSON.stringify(right) ? 'unchanged' : 'modified';
        edges.push({ ...value, status, before: left ? { version: left.version, metadata: left.metadata } : null, after: right ? { version: right.version, metadata: right.metadata } : null });
        nodes.set(value.from, { id: value.from, label: value.owner, kind: 'file', path: value.owner });
        nodes.set(value.to, { id: value.to, label: value.kind === 'project' ? value.to.slice(5) : value.name, kind: value.kind, path: value.kind === 'project' ? value.to.slice(5) : null });
    }
    return { nodes: [...nodes.values()], edges, changes: edges.filter(edge => edge.status !== 'unchanged').length, manifests, sourceFiles, warnings };
}
function typeDeclarations(values) {
    if (!values) return [];
    const namespaces = values.flatMap((token, index) => {
        if (token !== 'namespace') return [];
        const parts = []; for (let next = index + 1; next < values.length && ![';', '{'].includes(values[next]); next++) parts.push(values[next]);
        return [parts.join('')];
    });
    if (namespaces.length > 1) return [];
    const declarations = [];
    for (let index = 0; index < values.length; index++) {
        let kind = values[index], next = index + 1;
        if (!['class', 'record', 'struct', 'interface', 'enum'].includes(kind)) continue;
        if (kind === 'record' && ['class', 'struct'].includes(values[next])) { kind += ` ${values[next++]}`; }
        if (kind === 'struct' && values[index - 1] === 'record' || kind === 'class' && values[index - 1] === 'record') continue;
        const name = values[next];
        if (name && /^@?[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(name) && !['where', 'new', 'as', 'with', 'is', 'return', 'void'].includes(name)) declarations.push({ kind, name, namespace: namespaces[0] || '' });
    }
    return declarations;
}
function replaceNamespace(values, from, to) {
    if (!values) return null;
    const left = from.split('.').flatMap((part, index) => index ? ['.', part] : [part]);
    const right = to.split('.').flatMap((part, index) => index ? ['.', part] : [part]);
    const result = [];
    for (let index = 0; index < values.length; index++) {
        if (values[index - 1] !== '.' && left.every((part, offset) => values[index + offset] === part)) {
            result.push(...right); index += left.length - 1;
        } else result.push(values[index]);
    }
    return result;
}
function namespaceRenames(prepared) {
    const proposed = [], origins = new Set(), added = new Map();
    for (const file of prepared.filter(file => !file.original && file.modified)) {
        const key = posix.basename(file.path);
        if (!added.has(key)) added.set(key, []); added.get(key).push(file);
    }
    for (const file of prepared) {
        const before = typeDeclarations(file.left);
        if (!file.original || !before.length) continue;
        const matches = (file.modified ? [file] : added.get(posix.basename(file.path)) || []).flatMap(next => {
            const after = typeDeclarations(next.right);
            if (before.length !== after.length || before.some((value, index) => value.kind !== after[index].kind || value.name !== after[index].name)) return [];
            const from = before[0].namespace, to = after[0].namespace;
            if (!from || !to || from === to || before.some(value => value.namespace !== from) || after.some(value => value.namespace !== to)) return [];
            if (JSON.stringify(replaceNamespace(file.left, from, to)) !== JSON.stringify(next.right)) return [];
            return [{from, to, namespace:'', kind:'namespace', declaration:next.path, previous:file.path}];
        });
        if (matches.length === 1) proposed.push(matches[0]);
    }
    const pairs = [...new Map(proposed.filter(pair => !proposed.some(other =>
        other.from === pair.from && other.to !== pair.to || other.to === pair.to && other.from !== pair.from
        || pair.from.startsWith(other.from + '.') && pair.to !== other.to + pair.from.slice(other.from.length)
    )).map(pair => [pair.from, pair])).values()].sort((a,b) => a.from.length - b.from.length);
    for (const pair of proposed) { origins.add(pair.previous); origins.add(pair.declaration); }
    const roots = pairs.filter(pair => !pairs.some(other => other !== pair && pair.from.startsWith(other.from + '.') && pair.to === other.to + pair.from.slice(other.from.length)));
    return {pairs:roots, origins};
}
function namespaceTokens(text) {
    const pragmas = text.match(/^[ \t]*#pragma[ \t]+warning\b[^\r\n]*(?:\r?\n|$)/gm) || [];
    return { pragmas, values: tokens(text.replace(/^[ \t]*#pragma[ \t]+warning\b[^\r\n]*(?:\r?\n|$)/gm, '\n')) };
}
function projectReferenceRenames(files) {
    const projects = files.filter(file => /\.(csproj|fsproj|vbproj)$/i.test(file.path) && file.oldPath && file.oldPath !== file.path && /^R/.test(file.status) && !file.error && !file.binary && !file.modeChanged);
    const pairs = projects.filter(file => projects.filter(other => other.oldPath === file.oldPath || other.path === file.path).length === 1);
    const references = (owner, text) => {
        if (!text || /<!DOCTYPE/i.test(text) || XMLValidator.validate(text) !== true) return null;
        const values = []; let masked = '', end = 0;
        for (const match of text.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/g)) {
            if (!/^<ProjectReference\s/.test(match[0])) continue;
            if (!/^<ProjectReference(?:\s+[\w:.-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))+\s*\/?>$/.test(match[0])) return null;
            const attributes = [...match[0].matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)];
            const include = attributes.find(attribute => attribute[1] === 'Include');
            if (!include || /[$@%*?;]/.test(include[3]) || include[3].includes('&') || /^[\\/]|^[A-Za-z]:/.test(include[3])) return null;
            const offset = match.index + include.index + include[0].indexOf(include[2]) + 1;
            masked += text.slice(end, offset) + '__PROJECT_REFERENCE_PATH__'; end = offset + include[3].length;
            values.push(posix.normalize(posix.join(posix.dirname(owner), include[3].replaceAll('\\', '/'))));
        }
        return { masked: masked + text.slice(end), values };
    };
    return files.filter(file => /\.(csproj|fsproj|vbproj|props|targets)$/i.test(file.path) && !file.error && !file.binary && !file.modeChanged && file.original !== file.modified).flatMap(file => {
        const left = references(file.oldPath || file.path, file.original), right = references(file.path, file.modified);
        if (!left || !right || left.masked !== right.masked || left.values.length !== right.values.length) return [];
        let changed = false;
        for (let index = 0; index < left.values.length; index++) {
            if (left.values[index] === right.values[index]) continue;
            if (!pairs.some(pair => pair.oldPath === left.values[index] && pair.path === right.values[index])) return [];
            changed = true;
        }
        return changed ? [{ path: file.path, projectReferenceRenameOnly: true }] : [];
    });
}
export function detectRenames(files) {
    const prepared = files.filter(file => /\.cs$/i.test(file.path) && !file.binary && !file.error).map(file => ({ ...file, left: tokens(file.original), right: tokens(file.modified) }));
    const proposals = [], origins = new Set();
    const propose = (leftFile, rightFile, strict = false) => {
        const left = typeDeclarations(leftFile.left), right = typeDeclarations(rightFile.right);
        if (!left.length || left.length !== right.length || left.some((value, index) => value.kind !== right[index].kind || value.namespace !== right[index].namespace)) return;
        const pairs = left.flatMap((value, index) => value.name === right[index].name ? [] : [{ from: value.name, to: right[index].name, namespace: value.namespace, declaration: rightFile.path }]);
        if (!pairs.length) return;
        const replacements = new Map(pairs.map(pair => [pair.from, pair.to]));
        if (strict && JSON.stringify(leftFile.left.map(token => replacements.get(token) || token)) !== JSON.stringify(rightFile.right)) return;
        proposals.push(...pairs); origins.add(leftFile.path); origins.add(rightFile.path);
    };
    for (const file of prepared) if (file.original && file.modified) propose(file, file);
    const deleted = prepared.filter(file => file.original && !file.modified), added = prepared.filter(file => !file.original && file.modified);
    const signature = (values) => {
        const declarations = typeDeclarations(values);
        if (declarations.length !== 1) return null;
        const declaration = declarations[0];
        return JSON.stringify([declaration.kind, declaration.namespace, values.map(token => token === declaration.name ? '__DECLARED_TYPE__' : token)]);
    };
    const indexed = list => {
        const map = new Map();
        for (const file of list) {
            const key = signature(file.original ? file.left : file.right);
            if (key !== null) { if (!map.has(key)) map.set(key, []); map.get(key).push(file); }
        }
        return map;
    };
    const oldIndex = indexed(deleted), newIndex = indexed(added);
    for (const [key, previous] of oldIndex) {
        const next = newIndex.get(key);
        if (previous.length === 1 && next?.length === 1) propose(previous[0], next[0], true);
    }
    const ambiguous = new Set();
    const declarations = prepared.flatMap(file => [...typeDeclarations(file.left), ...typeDeclarations(file.right)]);
    for (const proposal of proposals) if (declarations.some(value => [proposal.from, proposal.to].includes(value.name) && value.namespace !== proposal.namespace)) ambiguous.add(proposal.from);
    for (const proposal of proposals) if (proposals.some(other => other.from === proposal.from && (other.to !== proposal.to || other.namespace !== proposal.namespace)) || proposals.some(other => other.from !== proposal.from && other.to === proposal.to)) ambiguous.add(proposal.from);
    const pairs = [...new Map(proposals.filter(pair => !ambiguous.has(pair.from)).map(pair => [pair.from, pair])).values()], replacements = new Map(pairs.map(pair => [pair.from, pair.to]));
    const classifications = prepared.map(file => {
        const fileRenameOnly = /^R100$/.test(file.status) && file.blobUnchanged === true && file.original === file.modified;
        const matches = file.left?.filter(token => replacements.has(token)) || [];
        const renameOnly = fileRenameOnly || !origins.has(file.path) && matches.length > 0 && file.original && file.modified && file.right && JSON.stringify(file.left.map(token => replacements.get(token) || token)) === JSON.stringify(file.right);
        return { path: file.path, renameOnly: Boolean(renameOnly), fileRenameOnly, namespaceTextOnly: false, renames: renameOnly ? pairs.filter(pair => matches.includes(pair.from)) : [] };
    });
    const namespacePrepared = prepared.map(file => {
        if (file.left && file.right) return file;
        const before = namespaceTokens(file.original), after = namespaceTokens(file.modified);
        return before.pragmas.length && JSON.stringify(before.pragmas) === JSON.stringify(after.pragmas) ? { ...file, left: before.values, right: after.values, namespacePragmas: true } : file;
    });
    const namespaces = namespaceRenames(namespacePrepared);
    for (const file of namespacePrepared) {
        if (!file.original || !file.modified || file.error || file.modeChanged) continue;
        const headerBefore = leadingUsings(file.original), headerAfter = leadingUsings(file.modified);
        const headerOnly = (!file.left || !file.right) && headerBefore && headerAfter && headerBefore.removed > 0 && headerBefore.body === headerAfter.body;
        const left = headerOnly ? headerBefore.values : file.left, right = headerOnly ? headerAfter.values : file.right;
        if (!left || !right) continue;
        let transformed = left, text = file.original;
        const used = [];
        for (const pair of namespaces.pairs) {
            const next = replaceNamespace(transformed, pair.from, pair.to);
            if (JSON.stringify(next) !== JSON.stringify(transformed)) { used.push(pair); text = text.replaceAll(pair.from, pair.to); }
            transformed = next;
        }
        if (used.length && JSON.stringify(transformed) === JSON.stringify(right)) {
            const value = classifications.find(value => value.path === file.path);
            value.namespaceTextOnly = text === file.modified;
            if (!headerOnly && !file.namespacePragmas && !origins.has(file.path) && !namespaces.origins.has(file.path)) { value.renameOnly = true; value.namespaceRenameOnly = true; value.renames = used; }
        }
    }
    classifications.push(...projectReferenceRenames(files));
    return { pairs: [...pairs, ...namespaces.pairs], classifications, ambiguous: [...ambiguous] };
}
export async function analyzeReview(review, readFile, classify = false, configurations = {}) {
    const generated = generatedClassifier(configurations), contents = new Map();
    const candidates = review.files.filter(file => dependencyManifest(file.path) || dependencyManifest(file.oldPath) || (classify && /\.(cs|csx|vb|json)$/i.test(file.path)));
    const classifications = [], manifests = [], sourceFiles = []; let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
        while (cursor < candidates.length) {
            const file = candidates[cursor++];
            try {
                const content = { ...file, ...await readFile(file.path) };
                if (classify && !content.binary) contents.set(file.path, { original: content.original.slice(0, 65536), modified: content.modified.slice(0, 65536) });
                if (classify) {
                    classifications.push({ path: file.path, ...classifyChange(file.path, content.original, content.modified) });
                    if (/\.cs$/i.test(file.path) && !content.binary && content.original.length + content.modified.length <= 400000) sourceFiles.push(content);
                }
                if (dependencyManifest(file.path) || dependencyManifest(file.oldPath)) manifests.push(content);
            } catch (error) { if (dependencyManifest(file.path) || dependencyManifest(file.oldPath)) manifests.push({ ...file, original: '', modified: '', binary: true, reason: error.message }); }
        }
    }));
    classifications.sort((a, b) => a.path.localeCompare(b.path)); manifests.sort((a, b) => a.path.localeCompare(b.path));
    sourceFiles.sort((a, b) => a.path.localeCompare(b.path));
    const renamed = detectRenames([...new Map([...sourceFiles, ...manifests].map(file => [file.path, file])).values()]);
    const renameClassification = new Map(renamed.classifications.map(value => [value.path, value]));
    const classifiedFiles = new Map(renamed.classifications.map(value => [value.path, value]));
    for (const value of classifications) classifiedFiles.set(value.path, { ...value, ...renameClassification.get(value.path) });
    for (const file of review.files) if (/^R100$/.test(file.status) && file.blobUnchanged === true) classifiedFiles.set(file.path, { ...classifiedFiles.get(file.path), path: file.path, renameOnly: true, fileRenameOnly: true });
    if (classify) for (const file of review.files) classifiedFiles.set(file.path, { ...classifiedFiles.get(file.path), path: file.path, ...generated(file, contents.get(file.path)) });
    return { classified: classify, classifications: [...classifiedFiles.values()], renames: { pairs: renamed.pairs, ambiguous: renamed.ambiguous, semanticVerification: false }, dependencies: dependencyDelta([...manifests, ...sourceFiles]) };
}
