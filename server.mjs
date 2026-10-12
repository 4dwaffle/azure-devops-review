import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.json': 'application/json' };
async function body(request) {
    let result = ''; for await (const chunk of request) { result += chunk; if (result.length > 100000) throw new Error('Request exceeds 100 KB'); }
    return JSON.parse(result || '{}');
}
export async function startServer(service) {
    const token = randomBytes(24).toString('hex'), prefix = `/${token}/`;
    const server = createServer(async (request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; font-src 'self' data:; img-src 'self' data:; connect-src 'self'");
        const send = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
        try {
            const expected = `127.0.0.1:${server.address().port}`;
            if (request.headers.host !== expected || (request.headers.origin && request.headers.origin !== `http://${expected}`)) return send(403, { error: 'Origin rejected' });
            const url = new URL(request.url, `http://${expected}`);
            if (url.pathname.startsWith('/vendor/')) {
                if (request.method !== 'GET') return send(405, { error: 'GET required' });
                const root = resolve(directory, 'node_modules', 'monaco-editor', 'min');
                const path = resolve(root, decodeURIComponent(url.pathname.slice('/vendor/'.length)));
                if (!path.startsWith(root + sep)) return send(403, { error: 'Invalid asset path' });
                response.setHeader('Content-Type', mime[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream'); response.end(await readFile(path)); return;
            }
            if (!url.pathname.startsWith(prefix)) return send(404, { error: 'Not found' });
            const route = url.pathname.slice(prefix.length);
            const method = request.method;
            if (route.startsWith('api/')) {
                if (request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site API request rejected' });
                const input = method === 'POST' ? await body(request) : null;
                let result;
                if (method === 'GET') {
                    switch (route) {
                        case 'api/config': result = await service.config(); break;
                        case 'api/prs': result = await service.list(url.searchParams.get('status') || 'active'); break;
                        case 'api/file': result = await service.file(url.searchParams.get('key'), url.searchParams.get('path')); break;
                        case 'api/diagnostics': result = await service.diagnostics(); break;
                        case 'api/roslyn/diagnostics': result = await service.roslynDiagnostics(url.searchParams.get('key'), url.searchParams.get('path')); break;
                        default: return send(404, { error: 'Unknown API' });
                    }
                } else if (method === 'POST') {
                    const handlers = { 'api/config': 'configure', 'api/review': 'open', 'api/filters': 'filters', 'api/analysis': 'analysis', 'api/viewed': 'viewed', 'api/viewed/batch': 'viewedMany', 'api/draft': 'draft', 'api/draft/remove': 'removeDraft', 'api/publish/preview': 'preparePublish', 'api/publish': 'publish', 'api/copilot': 'copilot', 'api/fetch': 'fetch', 'api/roslyn/start': 'roslynStart' };
                    if (!handlers[route]) return send(404, { error: 'Unknown API' });
                    result = await service[handlers[route]](input);
                } else return send(405, { error: 'Method not allowed' });
                send(200, result); return;
            }
            if (method !== 'GET' || !['', 'index.html', 'app.mjs', 'styles.css', 'theme.mjs', 'dependencies.mjs', 'diagnostics.mjs'].includes(route)) return send(404, { error: 'Not found' });
            const name = route || 'index.html'; response.setHeader('Content-Type', `${mime[name.slice(name.lastIndexOf('.'))]}; charset=utf-8`); response.end(await readFile(join(directory, 'ui', name)));
        } catch (error) { send(error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.message }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { server, url: `http://127.0.0.1:${server.address().port}${prefix}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
