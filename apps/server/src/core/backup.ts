import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import type { BackupStatus, Settings } from '@wc/shared';
import type { Repo } from './repo.js';

export const BACKUP_KEY = 'backup.status';
const NAME = /^work-commander-\d{4}-\d{2}-\d{2}-\d{6}\.sqlite$/;
const RETRY_AFTER_FAILURE_MS = 3600_000;

export const expandHome = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

export async function getBackupStatus(repo: Repo): Promise<BackupStatus> {
  try {
    return JSON.parse((await repo.getSync(BACKUP_KEY)) ?? '{}');
  } catch {
    return {};
  }
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

type Deps = { repo: Repo; settings: () => Promise<Settings>; sqlite: boolean };

/**
 * Write a consistent snapshot of the database (VACUUM INTO, safe while WC is running) into the configured folder,
 * then delete the oldest snapshots beyond `keep`. Only files WC itself named are ever deleted.
 */
export async function runBackup(deps: Deps): Promise<BackupStatus> {
  const b = (await deps.settings()).backup;
  const prev = await getBackupStatus(deps.repo);
  const status: BackupStatus = { ...prev, lastAttemptAt: new Date().toISOString() };
  try {
    if (!deps.sqlite) throw new Error('Backups are only available with the local SQLite database');
    if (!b.folder.trim()) throw new Error('Choose a backup folder first');
    const folder = path.resolve(expandHome(b.folder.trim()));
    fs.mkdirSync(folder, { recursive: true });
    fs.accessSync(folder, fs.constants.W_OK);
    const file = path.join(folder, `work-commander-${stamp(new Date())}.sqlite`);
    await sql`VACUUM INTO ${file}`.execute(deps.repo.db);
    fs.chmodSync(file, 0o600); // it holds your messages
    const keep = Math.max(1, Math.floor(b.keep) || 1);
    const all = fs.readdirSync(folder).filter((f) => NAME.test(f)).sort().reverse();
    for (const old of all.slice(keep)) fs.rmSync(path.join(folder, old), { force: true });
    delete status.lastError;
    status.lastSuccessAt = status.lastAttemptAt;
    status.lastFile = file;
  } catch (e: any) {
    status.lastError = e.message;
  }
  await deps.repo.setSync(BACKUP_KEY, JSON.stringify(status));
  return status;
}

/** Runs scheduled backups while WC is running; after downtime the first one happens right at startup. */
export class BackupScheduler {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private deps: Deps, private log: (msg: string) => void = () => undefined) {}
  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const b = (await this.deps.settings()).backup;
      if (!this.deps.sqlite || !b.enabled || !b.folder.trim()) return;
      const hours = Math.max(1, Number(b.everyHours) || 24);
      const st = await getBackupStatus(this.deps.repo);
      const every = st.lastError ? Math.min(hours * 3600_000, RETRY_AFTER_FAILURE_MS) : hours * 3600_000;
      if (st.lastAttemptAt && Date.now() - Date.parse(st.lastAttemptAt) < every) return;
      const r = await runBackup(this.deps);
      if (r.lastError) this.log(`backup failed: ${r.lastError}`);
    } catch (e: any) {
      this.log(`backup: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}
