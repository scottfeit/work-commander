import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { getBackupStatus, runBackup } from '../src/core/backup.js';

describe('database backup', () => {
  let dir: string;
  let repo: Repo;
  const settings = (over: object = {}) => async () => ({ ...defaultSettings(), backup: { enabled: true, folder: dir, everyHours: 24, keep: 2, ...over } });
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-backup-'));
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    await repo.createStream({ title: 'Keep me', summary: '' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes a readable snapshot and prunes the oldest beyond "keep", touching only its own files', async () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(dir, 'work-commander-2020-01-01-000000.sqlite'), 'old');
    fs.writeFileSync(path.join(dir, 'work-commander-2020-01-02-000000.sqlite'), 'old');
    const st = await runBackup({ repo, settings: settings(), sqlite: true });
    expect(st.lastError).toBeUndefined();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort();
    expect(files).toHaveLength(2); // keep = 2: the new one and the newest old one
    expect(files).not.toContain('work-commander-2020-01-01-000000.sqlite');
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    const { default: SQLite } = await import('better-sqlite3');
    const copy = new SQLite(st.lastFile!, { readonly: true });
    expect((copy.prepare('select title from streams').get() as any).title).toBe('Keep me');
    copy.close();
    expect((await getBackupStatus(repo)).lastSuccessAt).toBe(st.lastSuccessAt);
  });
  it('reports a clear error and changes nothing without a folder or on Postgres', async () => {
    expect((await runBackup({ repo, settings: settings({ folder: ' ' }), sqlite: true })).lastError).toMatch(/Choose a backup folder/);
    expect((await runBackup({ repo, settings: settings(), sqlite: false })).lastError).toMatch(/SQLite/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
