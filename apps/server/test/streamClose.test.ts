import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';

describe('close-stream suggestions are withdrawn when work continues', () => {
  let repo: Repo;
  let streamId: string;
  const propose = (runId: string, kind: 'stream_close' | 'email_send') =>
    repo.createProposal({ streamId, runId, kind, system: kind === 'stream_close' ? 'internal' : 'google', title: kind, rationale: '', payload: {}, editable: [] });
  const status = async (id: string) => (await repo.getProposal(id))!.status;

  beforeEach(async () => {
    const { db } = await openDatabase('sqlite::memory:');
    repo = new Repo(db);
    streamId = (await repo.createStream({ title: 't', summary: 's' })).id;
  });

  it('withdraws a pending close when a later turn drafts more work', async () => {
    const close = await propose('run1', 'stream_close');
    await propose('run2', 'email_send');
    expect(await status(close.id)).toBe('withdrawn');
    expect((await repo.listChat(streamId)).some((m) => m.role === 'system' && /Close suggestion withdrawn/.test(m.content))).toBe(true);
  });

  it('keeps a close proposed in the same turn as the last drafts ("send this, then close")', async () => {
    await propose('run1', 'email_send');
    const close = await propose('run1', 'stream_close');
    await propose('run1', 'email_send');
    expect(await status(close.id)).toBe('pending');
  });

  it('withdraws on new inbound activity, and leaves decided closes alone', async () => {
    const close = await propose('run1', 'stream_close');
    expect(await repo.withdrawStaleClose(streamId, 'new activity arrived')).toBe(1);
    expect(await status(close.id)).toBe('withdrawn');
    expect(await repo.withdrawStaleClose(streamId, 'again')).toBe(0);
  });
});

describe('a redone draft replaces the earlier one', () => {
  let repo: Repo;
  let streamId: string;
  const reply = (runId: string, thread: string, body: string) =>
    repo.createProposal({ streamId, runId, kind: 'email_reply', system: 'google', title: `Reply ${body}`, rationale: '', payload: { thread_id: thread, body }, editable: [] });
  const status = async (id: string) => (await repo.getProposal(id))!.status;
  beforeEach(async () => {
    const { db } = await openDatabase('sqlite::memory:');
    repo = new Repo(db);
    streamId = (await repo.createStream({ title: 't', summary: 's' })).id;
  });

  it('withdraws the older pending reply to the same thread from an earlier turn', async () => {
    const first = await reply('run1', 't1', 'firm');
    const second = await reply('run2', 't1', 'after lunch');
    expect(await status(first.id)).toBe('withdrawn');
    expect(await status(second.id)).toBe('pending');
    expect((await repo.listChat(streamId)).some((m) => /Reply firm" withdrawn: replaced by the new draft/.test(m.content))).toBe(true);
  });

  it('keeps replies to different threads, and two drafts from the same turn', async () => {
    const a = await reply('run1', 't1', 'a');
    const b = await reply('run2', 't2', 'b');
    const c = await reply('run2', 't2', 'c');
    expect([await status(a.id), await status(b.id), await status(c.id)]).toEqual(['pending', 'pending', 'pending']);
  });

  it('never withdraws a draft that was already approved', async () => {
    const a = await reply('run1', 't1', 'a');
    await repo.updateProposal(a.id, { status: 'approved' });
    await reply('run2', 't1', 'b');
    expect(await status(a.id)).toBe('approved');
  });
});
