import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { git } from './process.mjs';
import { deadCodeDiagnostics } from './ui/diagnostics.mjs';
export class Roslyn {
    constructor(serverPath) { this.serverPath = serverPath; this.pending = new Map(); this.nextId = 1; this.buffer = Buffer.alloc(0); this.opened = new Map(); this.capabilities = null; }
    available() { return Boolean(this.serverPath && existsSync(this.serverPath)); }
    write(message) {
        const body = Buffer.from(JSON.stringify(message));
        this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); this.process.stdin.write(body);
    }
    notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }
    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Roslyn ${method} timed out`)); }, 30000);
            this.pending.set(id, { resolve, reject, timer }); this.write({ jsonrpc: '2.0', id, method, params });
        });
    }
    receive(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        while (true) {
            const end = this.buffer.indexOf('\r\n\r\n'); if (end < 0) return;
            const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1]);
            if (!Number.isFinite(length) || length > 16 * 1024 * 1024) { this.stop(); return; }
            if (this.buffer.length < end + 4 + length) return;
            const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString());
            this.buffer = this.buffer.subarray(end + 4 + length);
            if (message.method && message.id != null) {
                this.write({ jsonrpc: '2.0', id: message.id, result: message.method === 'workspace/configuration' ? message.params.items.map(() => ({})) : null });
            } else if (message.id != null && this.pending.has(message.id)) {
                const item = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(item.timer);
                message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
            }
        }
    }
    async start(root) {
        if (this.starting) { await this.starting; return this.start(root); }
        if (this.process && this.root === root && this.capabilities) return { available: true, status: 'initialized', semanticWorkspace: false, capabilities: this.capabilities };
        this.starting = this.initialize(root);
        try { return await this.starting; } catch (error) { await this.stop(); throw error; } finally { this.starting = null; }
    }
    async initialize(root) {
        await this.stop();
        if (!this.available()) throw new Error('No configured local Roslyn language server');
        this.root = root;
        this.process = spawn('dotnet', [this.serverPath, '--stdio', '--logLevel', 'Error', '--telemetryLevel', 'off', '--clientProcessId', String(process.pid)], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const child = this.process;
        child.stdout.on('data', data => { if (this.process === child) { try { this.receive(data); } catch { void this.stop(); } } });
        child.stderr.on('data', () => {});
        child.on('error', error => { if (this.process === child) { this.process = null; this.fail(error); } });
        child.on('exit', () => { if (this.process === child) { this.process = null; this.capabilities = null; this.fail(new Error('Roslyn process exited')); } });
        const result = await this.request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'PR review' }], capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: { diagnostic: { dynamicRegistration: false }, hover: { contentFormat: ['plaintext'] }, definition: {} } }, initializationOptions: { automaticWorkspaceInit: false } });
        this.capabilities = result.capabilities; this.notify('initialized', {});
        return { available: true, status: 'initialized', semanticWorkspace: false, capabilities: this.capabilities };
    }
            async probe() {
                const root = await mkdtemp(join(tmpdir(), 'canvas-roslyn-'));
                const client = new Roslyn(this.serverPath);
                try {
                    const text = 'class C { void M() { int n = 1 } }';
                    const file = join(root, 'Program.cs'); await writeFile(file, text);
                    await client.start(root); const uri = pathToFileURL(file).href;
                    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'csharp', version: 1, text } });
                    const result = await client.request('textDocument/diagnostic', { textDocument: { uri } });
                    const deadFile = join(root, 'DeadCode.cs'), deadText = 'class DeadCode { private int unused; private void NeverCalled() {} int M() { return 1; int unreachable = 2; } }';
                    await writeFile(deadFile, deadText); const deadUri = pathToFileURL(deadFile).href;
                    client.notify('textDocument/didOpen', { textDocument: { uri: deadUri, languageId: 'csharp', version: 1, text: deadText } });
                    const deadResult = await client.request('textDocument/diagnostic', { textDocument: { uri: deadUri } });
                    const codes = deadCodeDiagnostics(deadResult.items || []).map(item => String(item.code));
                    return { initialized: true, syntaxDiagnosticsVerified: result.items?.some(item => item.code === 'CS1002') === true, deadCodeDiagnosticsVerified: codes.includes('IDE0035') && codes.includes('IDE0051'), deadCodeCodes: [...new Set(codes)], semanticWorkspace: false, analysisScope: 'single-file' };
                } finally { await client.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
            }
            fail(error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
    async open(review, file) {
        const head = (await git(review.worktree.path, ['rev-parse', 'HEAD'])).trim();
        const dirty = (await git(review.worktree.path, ['status', '--porcelain', '--untracked-files=no'])).trim();
        if (head !== review.source || dirty) throw new Error('Roslyn semantic features require a clean worktree checked out at the reviewed source commit. Diff browsing does not.');
        await this.start(review.worktree.path);
        const uri = pathToFileURL(join(review.worktree.path, file.path)).href;
        if (!this.opened.has(uri)) { this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'csharp', version: 1, text: file.modified } }); this.opened.set(uri, true); }
        return uri;
    }
    async diagnostics(review, file) { const uri = await this.open(review, file); const result = await this.request('textDocument/diagnostic', { textDocument: { uri } }); const diagnostics = result.items || []; return { diagnostics, deadCode: deadCodeDiagnostics(diagnostics), resultKind: result.kind, semanticWorkspace: false, analysisScope: 'single-file' }; }
    async hover(review, file, line, character) { const uri = await this.open(review, file); return this.request('textDocument/hover', { textDocument: { uri }, position: { line, character } }); }
    async stop() {
        const child = this.process; this.process = null;
        if (child) {
            this.fail(new Error('Roslyn stopped'));
            if (child.exitCode == null) await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); });
        }
        this.opened.clear(); this.buffer = Buffer.alloc(0); this.capabilities = null;
    }
}
