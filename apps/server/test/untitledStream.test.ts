import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';

const item = (externalId: string, title: string, streamId: string) => ({ source: 'gmail' as const, kind: 'email_thread' as const, externalId, title, data: { messages: [] }, streamId });

describe('a work stream started without a title', () => {
  it('takes the title of the first work item added, once', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const s = await repo.createStream({ title: 'New work stream', summary: '', untitled: true }, 'you');
    expect((await repo.getStream(s.id))!.title).toBe('New work stream');
    await repo.upsertItem(item('a', 'Budget approval for Q3', s.id) as any);
    expect((await repo.getStream(s.id))!.title).toBe('Budget approval for Q3');
    await repo.upsertItem(item('b', 'Something else', s.id) as any);
    expect((await repo.getStream(s.id))!.title).toBe('Budget approval for Q3');
  });

  it('a title given on purpose is never replaced', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const named = await repo.createStream({ title: 'Mine', summary: '' }, 'you');
    await repo.upsertItem(item('a', 'Item title', named.id) as any);
    expect((await repo.getStream(named.id))!.title).toBe('Mine');
    const s = await repo.createStream({ title: 'New work stream', summary: '', untitled: true }, 'you');
    await repo.updateStream(s.id, { title: 'Renamed' });
    await repo.upsertItem(item('c', 'Item title', s.id) as any);
    expect((await repo.getStream(s.id))!.title).toBe('Renamed');
  });
});
