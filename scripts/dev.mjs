// Runs the API server and the web dev server together and stops BOTH on Ctrl+C.
// (The old `a & b` npm script left the server running in the background after Ctrl+C,
// so the next start talked to a stale server.)
import { spawn } from 'node:child_process';

const watch = !process.argv.includes('--no-watch');
const run = (name, args) => spawn('npm', ['run', ...args], { stdio: 'inherit', detached: true });
const kids = [run('server', [watch ? 'dev' : 'serve', '-w', '@wc/server']), run('web', ['dev', '-w', '@wc/web'])];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  // Each child leads its own process group, so signal the whole group (npm -> tsx/vite -> node).
  for (const k of kids) {
    try {
      process.kill(-k.pid, 'SIGTERM');
    } catch {}
  }
  setTimeout(() => process.exit(code), 1500).unref();
};
kids.forEach((k) => k.on('exit', (c) => stop(c ?? 0)));
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((s) => process.on(s, () => stop(0)));
