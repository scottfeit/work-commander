import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';

describe('closing a work stream', () => {
  it('marks it read; reopening with new activity marks it unread again', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const s = await repo.createStream({ title: 'S', summary: '' });
    expect((await repo.getStream(s.id))!.unread).toBe(true);
    await repo.updateStream(s.id, { status: 'closed' }, 'you');
    expect((await repo.getStream(s.id))!).toMatchObject({ status: 'closed', unread: false });
    await repo.updateStream(s.id, { status: 'open' });
    await repo.updateStream(s.id, { touch: true, unread: true });
    expect((await repo.getStream(s.id))!).toMatchObject({ status: 'open', unread: true });
  });
});
