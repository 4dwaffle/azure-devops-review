import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export class Store {
    constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); }
    path(key) { return join(this.directory, `${hash(key)}.json`); }
    async read(key, fallback = {}) {
        try { return JSON.parse(await readFile(this.path(key), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
    }
    update(key, change, fallback = {}) {
        const job = this.queue.then(async () => {
            await mkdir(this.directory, { recursive: true });
            const release = await lockfile.lock(this.directory, { stale: 60000, update: 10000, retries: { retries: 80, factor: 1.2, minTimeout: 10, maxTimeout: 250, randomize: true } });
            const path = this.path(key), temporary = `${path}.${randomUUID()}.tmp`;
            try {
                const value = await change(await this.read(key, fallback));
                await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
                await rename(temporary, path);
                return value;
            } finally { await rm(temporary, { force: true }).finally(release); }
        });
        this.queue = job.catch(() => {});
        return job;
    }
}
