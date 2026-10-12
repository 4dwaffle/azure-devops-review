import { git } from './process.mjs';
import { hash } from './store.mjs';
import { resolve, isAbsolute } from 'node:path';
import { readdir } from 'node:fs/promises';
export function parseRemote(raw) {
    try {
        const ssh = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)$/.exec(raw.trim());
        if (ssh) return { organization: ssh[1], project: ssh[2], repository: ssh[3] };
        const url = new URL(raw.trim());
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const index = parts.indexOf('_git');
        if (index < 1) return null;
        if (url.hostname === 'dev.azure.com') return { organization: parts[0], project: parts[index - 1], repository: parts[index + 1] };
        if (url.hostname.endsWith('.visualstudio.com')) return { organization: url.hostname.slice(0, -17), project: parts[index - 1], repository: parts[index + 1] };
    } catch { return null; }
    return null;
}
export function sameRepository(remote, pr) {
    return remote && remote.organization.toLowerCase() === pr.organization.toLowerCase() && remote.project.toLowerCase() === pr.project.toLowerCase() && [pr.repository, pr.repositoryId].some(value => value?.toLowerCase() === remote.repository.toLowerCase());
}
export function parseChanges(output) {
    const fields = output.split('\0'); const changes = [];
    for (let i = 0; i < fields.length && fields[i];) {
        const status = fields[i++], oldPath = fields[i++];
        const path = /^[RC]/.test(status) ? fields[i++] : oldPath;
        if (!path) throw new Error('Invalid Git diff name-status response');
        changes.push({ status, path, oldPath });
    }
    return changes;
}
export function parseWorktrees(output) {
    return output.split('\0\0').filter(Boolean).map(record => {
        const fields = record.split('\0');
        const get = prefix => fields.find(field => field.startsWith(prefix))?.slice(prefix.length);
        return { path: get('worktree ') ? resolve(get('worktree ')) : null, head: get('HEAD '), branch: get('branch '), bare: fields.includes('bare') };
    }).filter(value => value.path && !value.bare);
}
export class GitReview {
    constructor(roots = [], excludedPaths = []) { this.roots = roots; this.excludedPaths = excludedPaths.map(path => resolve(path).toLowerCase()); this.worktrees = []; }
    excluded(path) { const normalized = resolve(path).toLowerCase(); return this.excludedPaths.some(root => normalized === root || normalized.startsWith(root + '\\')); }
    async discover() {
        const candidates = new Set();
        for (const root of this.roots) {
            if (!isAbsolute(root)) throw new Error('Checkout roots must be absolute paths');
            if (this.excluded(root)) continue;
            try {
                const checkout = resolve((await git(root, ['rev-parse', '--show-toplevel'])).trim());
                if (!this.excluded(checkout)) candidates.add(checkout);
                continue;
            } catch {}
            try { for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith('.') && !this.excluded(resolve(root, entry.name))) candidates.add(resolve(root, entry.name)); } catch {}
        }
        const found = new Map();
        await Promise.all([...candidates].map(async cwd => {
            try {
                const remotes = (await git(cwd, ['remote', '-v'])).split('\n').map(line => { const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line); return match ? { name: match[1], identity: parseRemote(match[2]) } : null; }).filter(item => item?.identity);
                if (!remotes.length) return;
                const trees = parseWorktrees(await git(cwd, ['worktree', 'list', '--porcelain', '-z']));
                for (const tree of trees) if (!this.excluded(tree.path)) found.set(tree.path, { ...tree, remotes });
            } catch {}
        }));
        this.worktrees = [...found.values()]; return this.worktrees;
    }
    async resolve(pr) {
        if (!this.worktrees.length) await this.discover();
        const matches = this.worktrees.filter(tree => tree.remotes.some(remote => sameRepository(remote.identity, pr)));
        return matches.find(tree => tree.branch === pr.sourceRefName) || matches.find(tree => tree.head === pr.source) || matches.find(tree => this.roots.some(root => resolve(root).toLowerCase() === tree.path.toLowerCase())) || matches[0] || null;
    }
    async compare(worktree, source, target) {
        for (const commit of [source, target]) {
            if (!/^[a-f0-9]{40}$/i.test(commit || '')) throw new Error('Azure DevOps did not provide a full commit SHA');
            try { await git(worktree.path, ['cat-file', '-e', `${commit}^{commit}`]); }
            catch { const failure = new Error('PR commits are missing locally. Use Fetch to explicitly download PR refs.'); failure.code = 'missing_commits'; throw failure; }
        }
        const bases = (await git(worktree.path, ['merge-base', '--all', target, source])).trim().split('\n');
        if (bases.length !== 1) throw new Error('Multiple merge bases: ambiguous review baseline; publishing is disabled.');
        const base = bases[0];
        const files = parseChanges(await git(worktree.path, ['diff', '--name-status', '-z', '--find-renames', base, source, '--']));
        const trees = await Promise.all([base, source].map(commit => git(worktree.path, ['ls-tree', '-r', '-z', commit])));
        const objects = trees.map(tree => new Map(tree.split('\0').filter(Boolean).map(record => { const split = record.indexOf('\t'); return [record.slice(split + 1), record.slice(0, split)]; })));
        files.forEach(file => {
            const before = objects[0].get(file.oldPath) || '';
            const after = objects[1].get(file.path) || '';
            file.fingerprint = hash(`${file.oldPath}\0${file.path}\0${before}\0${after}`);
            file.blobUnchanged = Boolean(before && after && before === after);
            file.modeChanged = Boolean(before && after && before.split(' ')[0] !== after.split(' ')[0]);
            if (before.startsWith('160000 ')) file.originalGitlink = before.split(' ').at(-1);
            if (after.startsWith('160000 ')) file.modifiedGitlink = after.split(' ').at(-1);
        });
        const configurationPaths = Object.fromEntries(['base', 'source'].map((side, index) => [side, [...objects[index]].filter(([path]) => /(?:^|\/)\.editorconfig$|\.globalconfig$/i.test(path)).map(([path, descriptor]) => ({ path, descriptor }))]));
        return { base, source, target, files, configurationPaths };
    }
    async generatedConfigs(review) {
        const result = { base: [], source: [] }, jobs = [];
        for (const side of ['base', 'source']) {
            const entries = review.configurationPaths?.[side] || [];
            if (entries.length > 200) { result[side].push({ path: '.editorconfig', error: 'Too many analyzer configuration files' }); continue; }
            for (const entry of entries) jobs.push({ side, ...entry });
        }
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
            while (cursor < jobs.length) {
                const entry = jobs[cursor++];
                try {
                    if (!/^100(?:644|755) blob /.test(entry.descriptor)) throw new Error('Analyzer configuration is not a regular blob');
                    const contents = await git(review.worktree.path, ['show', `${review[entry.side]}:${entry.path}`], { maxBuffer: 256 * 1024 });
                    if (contents.includes('\0')) throw new Error('Binary analyzer configuration');
                    result[entry.side].push({ path: entry.path, contents });
                } catch (error) { result[entry.side].push({ path: entry.path, error: error.message }); }
            }
        }));
        return result;
    }
    async file(review, path) {
        const file = review.files.find(file => file.path === path);
        if (!file) throw new Error('File is not part of this review');
        const read = async (commit, path, missing, gitlink) => {
            if (missing) return Buffer.alloc(0);
            if (gitlink) return Buffer.from(`Subproject commit ${gitlink}\n`);
            try { return await git(review.worktree.path, ['show', `${commit}:${path}`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }); }
            catch (error) { if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return null; throw error; }
        };
        const [original, modified] = await Promise.all([read(review.base, file.oldPath, file.status.startsWith('A'), file.originalGitlink), read(review.source, file.path, file.status.startsWith('D'), file.modifiedGitlink)]);
        const oversized = original === null || modified === null;
        const binary = oversized || original.includes(0) || modified.includes(0);
        const extension = path.split('.').at(-1).toLowerCase();
        const language = ({ cs: 'csharp', js: 'javascript', mjs: 'javascript', ts: 'typescript', json: 'json', xml: 'xml', csproj: 'xml', razor: 'html', css: 'css', md: 'markdown', sql: 'sql', yml: 'yaml', yaml: 'yaml', ps1: 'powershell' })[extension] || 'plaintext';
        return { original: binary ? '' : original.toString('utf8'), modified: binary ? '' : modified.toString('utf8'), binary, reason: oversized ? 'File exceeds the 8 MB rendering limit' : binary ? 'Binary file (not rendered)' : null, language, path, oldPath: file.oldPath };
    }
    async fetch(review) {
        const remote = review.worktree.remotes.find(remote => sameRepository(remote.identity, review.pr));
        if (!remote) throw new Error('No matching Azure DevOps Git remote');
        await git(review.worktree.path, ['fetch', '--no-tags', '--', remote.name, review.pr.sourceRefName, review.pr.targetRefName], { timeout: 120000 });
    }
}
