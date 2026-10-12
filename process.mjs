import { execFile } from 'node:child_process';
export function run(command, args, options = {}) {
    return new Promise((resolve, reject) => execFile(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
        if (error) { const failure = new Error(`${command} failed: ${String(stderr).slice(0, 1200) || error.message}`); failure.code = error.code; reject(failure); }
        else resolve(stdout);
    }));
}
export const git = (cwd, args, options) => run('git', ['--no-pager', '-c', 'core.quotepath=false', ...args], { cwd, ...options });
