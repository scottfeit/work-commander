/**
 * Installs and runs Laya locally, entirely inside <data dir>/laya: the uv tool, a private Python 3.12, a virtual
 * environment with a pinned Laya, and the model files (Hugging Face cache). The PU's own Python is never touched.
 *
 * The helper (laya/wc_laya_helper.py) listens on 127.0.0.1 only, on a free port, and needs a bearer token that
 * changes every start. Local hosting only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

export const UV_VERSION = '0.13.8';
export const LAYA_VERSION = '0.4.32';
const READY_TIMEOUT_MS = 20 * 60_000; // the first start downloads the model
const CALL_TIMEOUT_MS = 120_000;
const FIT_TIMEOUT_MS = 30 * 60_000;

export type InstallState = { state: 'absent' | 'installing' | 'installed' | 'failed'; message?: string; progress?: string };

function helperScript() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/laya/manager.ts (dev) or dist/index.js (built)
  for (const c of [path.resolve(here, '../../laya/wc_laya_helper.py'), path.resolve(here, '../laya/wc_laya_helper.py')]) if (fs.existsSync(c)) return c;
  throw new Error('Laya helper script is missing from this installation');
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

export class LayaManager {
  readonly root: string;
  private child: ChildProcess | null = null;
  private port = 0;
  private token = '';
  private starting: Promise<void> | null = null;
  private installing: Promise<void> | null = null;
  private lastError = '';
  install: InstallState;

  constructor(
    dataDir: string,
    private onChange: () => void = () => undefined,
    private log: (m: string) => void = (m) => console.error('[laya]', m),
  ) {
    this.root = path.join(dataDir, 'laya');
    this.install = this.readInstallState();
  }

  private p = (...x: string[]) => path.join(this.root, ...x);
  private get python() {
    return this.p('venv', 'bin', 'python');
  }
  private readInstallState(): InstallState {
    try {
      const s = JSON.parse(fs.readFileSync(this.p('install.json'), 'utf8')) as InstallState;
      // An install interrupted by a restart is not still running.
      return s.state === 'installing' ? { state: 'failed', message: 'The install was interrupted. Install again.' } : s;
    } catch {
      return { state: 'absent' };
    }
  }
  private setInstall(s: InstallState) {
    this.install = s;
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.p('install.json'), JSON.stringify(s));
    this.onChange();
  }

  get running() {
    return !!this.child && this.port > 0 && !this.starting;
  }
  get serverMessage() {
    return this.lastError || undefined;
  }

  private env(extra: Record<string, string> = {}) {
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER']) if (process.env[k]) env[k] = process.env[k]!;
    return {
      ...env,
      UV_PYTHON_INSTALL_DIR: this.p('python'),
      UV_CACHE_DIR: this.p('uv-cache'),
      HF_HUB_CACHE: this.p('hf'),
      HF_HUB_DISABLE_TELEMETRY: '1',
      TOKENIZERS_PARALLELISM: 'false',
      PYTHONNOUSERSITE: '1',
      ...extra,
    };
  }

  private run(cmd: string, args: string[], env: Record<string, string>, step: string) {
    return new Promise<void>((resolve, reject) => {
      const c = spawn(cmd, args, { env, cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      const keep = (b: Buffer) => (tail = (tail + b.toString()).slice(-2000));
      c.stdout.on('data', keep);
      c.stderr.on('data', keep);
      c.on('error', (e) => reject(new Error(`${step}: ${e.message}`)));
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${step} failed (exit ${code}): ${tail.trim().split('\n').slice(-3).join(' ')}`))));
    });
  }

  /** Download uv, Python 3.12 and Laya, then load the model once (which downloads it). Progress goes to `install.progress`. */
  startInstall() {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      try {
        fs.mkdirSync(this.root, { recursive: true });
        const uv = this.p('bin', 'uv');
        if (!fs.existsSync(uv)) {
          this.setInstall({ state: 'installing', progress: `Downloading the uv tool (${UV_VERSION})…` });
          await this.run('/bin/sh', ['-c', `curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh`], this.env({ UV_INSTALL_DIR: this.p('bin'), UV_NO_MODIFY_PATH: '1', INSTALLER_NO_MODIFY_PATH: '1' }), 'Downloading uv');
        }
        if (!fs.existsSync(this.python)) {
          this.setInstall({ state: 'installing', progress: 'Downloading Python 3.12 and creating a private environment…' });
          await this.run(uv, ['venv', '-q', '-p', '3.12', this.p('venv')], this.env(), 'Creating the Python environment');
        }
        this.setInstall({ state: 'installing', progress: `Installing Laya ${LAYA_VERSION} and PyTorch (a few minutes)…` });
        await this.run(uv, ['pip', 'install', '-q', `laya==${LAYA_VERSION}`, '--torch-backend=auto'], this.env({ VIRTUAL_ENV: this.p('venv') }), 'Installing Laya');
        this.setInstall({ state: 'installing', progress: 'Downloading the Laya model (about 2 GB) and loading it…' });
        await this.stop();
        await this.start();
        this.setInstall({ state: 'installed', message: `Laya ${LAYA_VERSION}` });
      } catch (e: any) {
        this.log(e.message);
        this.setInstall({ state: 'failed', message: e.message });
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  /** Start the helper if it isn't running. */
  ensure(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.starting) return this.starting;
    if (!fs.existsSync(this.python)) return Promise.reject(new Error('Laya is not installed'));
    return this.start();
  }

  private start(): Promise<void> {
    this.starting = (async () => {
      this.port = await freePort();
      this.token = crypto.randomBytes(24).toString('hex');
      const c = spawn(this.python, ['-I', helperScript()], { env: this.env({ WC_LAYA_PORT: String(this.port), WC_LAYA_TOKEN: this.token }), cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = c;
      let tail = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Laya took too long to start')), READY_TIMEOUT_MS);
        c.stdout!.on('data', (b: Buffer) => {
          if (b.toString().includes('WC_LAYA_READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
        c.stderr!.on('data', (b: Buffer) => (tail = (tail + b.toString()).slice(-2000)));
        c.on('exit', (code) => {
          clearTimeout(timer);
          if (this.child === c) {
            this.child = null;
            this.port = 0;
            this.lastError = code ? `Laya stopped (exit ${code}): ${tail.trim().split('\n').slice(-2).join(' ')}` : '';
            this.onChange();
          }
          reject(new Error(this.lastError || 'Laya stopped'));
        });
      });
      this.lastError = '';
    })().finally(() => {
      this.starting = null;
      this.onChange();
    });
    return this.starting;
  }

  async stop() {
    const c = this.child;
    this.child = null;
    this.port = 0;
    if (c && c.exitCode === null) {
      c.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (c.exitCode === null) c.kill('SIGKILL');
    }
    this.onChange();
  }

  async call<T = any>(route: '/predict' | '/fit' | '/min_rows', body: unknown): Promise<T> {
    await this.ensure();
    const r = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(route === '/fit' ? FIT_TIMEOUT_MS : CALL_TIMEOUT_MS),
    });
    const data = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(`Laya: ${data.error ?? r.status}`);
    return data as T;
  }

  /** Folder for a trained version of a part. */
  headsDir(part: string, version: number) {
    return this.p('heads', part, `v${version}`);
  }
}
