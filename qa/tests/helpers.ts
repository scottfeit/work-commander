import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test, expect, type Page } from '@playwright/test';

const ROOT = path.resolve(__dirname, '../..');
export const WEB_PORT = 5273;
export const API_PORT = 8887;
export const WEB = `http://localhost:${WEB_PORT}`;
export const API = `http://127.0.0.1:${API_PORT}`;

async function until<T>(fn: () => Promise<T | null | false | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out after ${ms}ms waiting for ${what}${last ? ` (${String(last)})` : ''}`);
}

export interface Proposal {
  id: string;
  streamId: string | null;
  kind: string;
  status: string;
  title: string;
  error?: string | null;
  dependsOn: string[];
  payload: Record<string, any>;
}

/** Thin JSON client for the server's API (talks to the server directly, not through the web proxy). */
export const api = {
  async call(method: string, p: string, body?: unknown) {
    const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, json, text };
  },
  get: (p: string) => api.call('GET', p),
  post: (p: string, b: unknown = {}) => api.call('POST', p, b),
  proposals: async (query = ''): Promise<Proposal[]> => (await api.get('/api/proposals' + query)).json,
  pending: () => api.proposals('?status=pending'),
  async waitPending(kinds: string[], ms = 40_000) {
    return until(async () => {
      const p = await api.pending();
      const got = kinds.map((k) => p.find((x) => x.kind === k));
      return got.every(Boolean) ? (got as Proposal[]) : null;
    }, ms, `pending proposals ${kinds.join(', ')}`);
  },
  async waitStatus(id: string, status: string, ms = 20_000) {
    return until(async () => {
      const p = (await api.proposals()).find((x) => x.id === id);
      return p?.status === status ? p : null;
    }, ms, `proposal ${id} to be ${status}`);
  },
  async streams() {
    return (await api.get('/api/streams?includeClosed=1')).json as any[];
  },
  async auditFailures() {
    const rows = (await api.get('/api/audit')).json as any[];
    return rows.filter((r) => r.action === 'proposal.failed').map((r) => r.detail);
  },
};

/** Raw HTTP request with full control over headers (fetch forbids overriding Host/Origin). */
export function rawRequest(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: API_PORT, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/**
 * Boots a fresh, isolated demo instance for the spec file that calls this (own data dir, fixed QA ports)
 * and stops it afterwards. Call once at the top of a spec file.
 */
let currentDir = '';
/** The demo instance's data directory (the sqlite file lives inside it). */
export const demoDataDir = () => path.join(currentDir, '.work-commander-demo');

export function freshApp() {
  let child: ChildProcess | null = null;
  let dir = '';
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-qa-'));
    currentDir = dir;
    child = spawn('node', ['scripts/dev.mjs', '--no-watch'], {
      cwd: ROOT,
      detached: true,
      stdio: process.env.QA_VERBOSE ? 'inherit' : 'ignore',
      env: {
        ...process.env,
        DEMO_MODE: '1',
        PORT: String(API_PORT),
        WEB_PORT: String(WEB_PORT),
        // The server only wipes a data dir named like this, which keeps every run starting clean.
        WC_DATA_DIR: path.join(dir, '.work-commander-demo'),
        DEMO_SEED_DELAY_MS: '300',
        // Hand-offs from tests never open a real Terminal or write into the real ~/WorkCommander.
        WC_NO_TERMINAL: '1',
        WC_HANDOFF_ROOT: path.join(os.homedir(), '.wc-qa-handoffs'),
        DEMO_REPLY_DELAY_MS: '800',
        LOG_LEVEL: 'error',
      },
    });
    await until(async () => (await fetch(WEB + '/api/env')).ok, 60_000, 'demo app to start');
  });
  test.afterAll(async () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await until(async () => {
        try {
          await fetch(WEB + '/api/env');
          return false;
        } catch {
          return true;
        }
      }, 15_000, 'demo app to stop').catch(() => undefined);
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** Collects console errors, uncaught page errors and failed (>=400) responses for later assertion. */
export function watchPage(page: Page, ignore: RegExp[] = []) {
  const problems: string[] = [];
  const skip = (s: string) => ignore.some((r) => r.test(s));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !skip(m.text())) problems.push(`console.error: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !skip(`${r.status()} ${r.url()}`)) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return problems;
}

export const stream = (page: Page, re: RegExp) => page.locator('button.stream-open', { hasText: re }).first();
export const draft = (page: Page, title: RegExp) => page.locator('.draft', { hasText: title }).first();

export { expect, test };
