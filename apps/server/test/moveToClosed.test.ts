import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';

describe('moving a work item into a closed stream', () => {
  it('works, and the stream stays closed', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const open = await repo.createStream({ title: 'Open', summary: '' });
    const done = await repo.createStream({ title: 'Done', summary: '' });
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'keep', title: 'Keep', streamId: open.id, data: { messages: [] } });
    const it = (await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't', title: 'T', streamId: open.id, data: { messages: [] } })).item;
    await repo.updateStream(done.id, { status: 'closed' }, 'you');
    await repo.moveItem(it.id, done.id);
    expect((await repo.getItem(it.id))!.streamId).toBe(done.id);
    expect((await repo.getStream(done.id))!.status).toBe('closed');
  });
});
