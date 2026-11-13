import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { attachDriveFile, googleFileLinks } from '../src/core/docs.js';
import { buildBrief } from '../src/core/handoff.js';

describe('Google file links', () => {
  it('finds Docs, Sheets and Slides links once per file, ignoring trailing punctuation and other links', () => {
    const text = [
      'Edited https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMn/edit#gid=0.',
      'Also (https://docs.google.com/document/d/DOC1234567890abc/edit?usp=sharing) and again https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMn/edit?x=1',
      'Deck: https://docs.google.com/presentation/d/SLIDES1234567/edit. Not this: https://example.com/d/1234567890 or https://drive.google.com/file/d/xyz',
    ].join('\n');
    expect(googleFileLinks(text).map((l) => l.id)).toEqual(['1AbCdEfGhIjKlMn', 'DOC1234567890abc', 'SLIDES1234567']);
    expect(googleFileLinks(text)[0].url).toBe('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMn/edit');
  });
});

describe('attaching a Google file as a work item', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });
  const docs = (text = 'cell A1') => ({ read: async () => ({ title: 'Gainsight access', text, url: 'https://docs.google.com/spreadsheets/d/FILE1234567890/edit' }) });

  it('adds it to the stream, and the same file in a second stream is its own item there', async () => {
    const a = (await repo.createStream({ title: 'A', summary: '' })).id;
    const b = (await repo.createStream({ title: 'B', summary: '' })).id;
    await attachDriveFile(repo, docs(), a, { id: 'FILE1234567890' });
    await attachDriveFile(repo, docs(), b, { id: 'FILE1234567890' });
    const [ia] = await repo.listItems(a);
    const [ib] = await repo.listItems(b);
    expect(ia).toMatchObject({ title: 'Gainsight access', source: 'drive', kind: 'doc' });
    expect(ib.id).not.toBe(ia.id);
    expect(ia.url).toBe(ib.url);
    expect(ia.data.unread).toBe(true); // new activity: its tab gets a dot
  });
  it('refreshes the item instead of duplicating it, and still works when the file cannot be read', async () => {
    const a = (await repo.createStream({ title: 'A', summary: '' })).id;
    await attachDriveFile(repo, docs('old'), a, { id: 'FILE1234567890' });
    await attachDriveFile(repo, docs('new text'), a, { id: 'FILE1234567890' });
    const items = await repo.listItems(a);
    expect(items).toHaveLength(1);
    expect(items[0].data.body).toBe('new text');
    const noAccess = { read: async () => { throw new Error('403'); } };
    const c = (await repo.createStream({ title: 'C', summary: '' })).id;
    await attachDriveFile(repo, noAccess, c, { id: 'OTHERFILE12345', url: 'https://docs.google.com/document/d/OTHERFILE12345/edit' });
    expect((await repo.listItems(c))[0].url).toBe('https://docs.google.com/document/d/OTHERFILE12345/edit');
  });
});

describe('hand-off brief', () => {
  const stream: any = { id: 's', title: 'Gainsight access', summary: 'Needs a sheet edit', labels: [] };
  it('puts the task first and asks for the files edited', () => {
    const brief = buildBrief(stream, [], [], 'Change row 12 to Approved');
    expect(brief.indexOf('## Task')).toBeGreaterThan(-1);
    expect(brief.indexOf('## Task')).toBeLessThan(brief.indexOf('## Overview'));
    expect(brief).toContain('Change row 12 to Approved');
    expect(brief).toMatch(/Files edited/);
    expect(buildBrief(stream, [], [])).not.toContain('## Task');
  });
});
