import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMime } from '../src/integrations/google.js';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { AttachmentStore } from '../src/core/attachments.js';

describe('email MIME with attachments', () => {
  it('builds multipart/mixed with base64 parts and RFC 2231 filenames', () => {
    const mime = buildMime({ from: 'A <a@x>', to: ['b@x'], cc: [], subject: 'Files', body: 'see attached', files: [{ filename: 'résumé "v2".pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 hi') }] });
    const boundary = mime.match(/boundary="([^"]+)"/)![1];
    expect(mime).toContain('Content-Type: multipart/mixed');
    expect(mime.split(`--${boundary}`).length).toBe(4); // preamble, text, file, closing
    expect(mime).toContain(`filename*=UTF-8''${encodeURIComponent('résumé "v2".pdf')}`);
    expect(mime).toContain(Buffer.from('%PDF-1.4 hi').toString('base64'));
    expect(mime.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });
  it('stays single-part without attachments', () => {
    expect(buildMime({ from: 'a@x', to: ['b@x'], cc: [], subject: 's', body: 'b' })).not.toContain('multipart');
  });
});

describe('hand-off folder access', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-att-'));
  const folder = path.join(home, 'proj');
  let store: AttachmentStore;
  let repo: Repo;
  let streamId: string;
  beforeAll(async () => {
    fs.mkdirSync(path.join(folder, 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'pkg', 'lib.py'), 'print(1)');
    fs.writeFileSync(path.join(folder, 'RESULT.md'), 'done');
    fs.writeFileSync(path.join(folder, '.env'), 'TOKEN=secret');
    fs.writeFileSync(path.join(folder, 'aws_credentials.txt'), 'secret');
    fs.writeFileSync(path.join(folder, 'node_modules', 'x', 'i.js'), '');
    fs.writeFileSync(path.join(home, 'outside.txt'), 'nope');
    fs.symlinkSync(path.join(home, 'outside.txt'), path.join(folder, 'link.txt'));
    const { db } = await openDatabase('sqlite::memory:');
    repo = new Repo(db);
    store = new AttachmentStore(db, repo);
    streamId = (await repo.createStream({ title: 't', summary: 's' })).id;
    await repo.createHandoff(streamId, folder);
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  it('lists only real project files', async () => {
    const { files } = await store.listFiles(streamId);
    expect(files.map((f) => f.path).sort()).toEqual(['RESULT.md', path.join('pkg', 'lib.py')].sort()); // symlinks are not followed;
  });
  it('reads and attaches files inside the folder', async () => {
    expect(await store.readText(streamId, 'pkg/lib.py')).toBe('print(1)');
    const ref = await store.attachFromHandoff(streamId, 'pkg/lib.py');
    expect(ref).toMatchObject({ filename: 'lib.py', size: 8 });
    const [f] = await store.resolve([ref], streamId);
    expect(f.data.toString()).toBe('print(1)');
  });
  it('refuses paths outside the folder, symlinks out of it, and secret-looking files', async () => {
    await expect(store.readText(streamId, '../outside.txt')).rejects.toThrow(/outside|No file/);
    await expect(store.readText(streamId, path.join(home, 'outside.txt'))).rejects.toThrow(/outside|No file/);
    await expect(store.readText(streamId, 'link.txt')).rejects.toThrow(/outside/);
    await expect(store.readText(streamId, '.env')).rejects.toThrow(/secret-looking/);
    await expect(store.attachFromHandoff(streamId, 'aws_credentials.txt')).rejects.toThrow(/secret-looking/);
    await expect(store.readText(streamId, 'node_modules/x/i.js')).rejects.toThrow(/dependency/);
  });
  it('refuses attachments from another stream when sending', async () => {
    const other = (await repo.createStream({ title: 'o', summary: 's' })).id;
    const ref = await store.save({ streamId: other, filename: 'a.txt', data: Buffer.from('x'), source: 'upload' });
    await expect(store.resolve([ref], streamId)).rejects.toThrow(/different work stream/);
  });
});
