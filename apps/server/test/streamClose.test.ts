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

describe('a draft you edited is not replaced by Claude\'s newer one', () => {
  let repo: Repo;
  let streamId: string;
  const slack = (runId: string, text: string) => repo.createProposal({ streamId, runId, kind: 'slack_post', system: 'slack', title: `Post ${text}`, rationale: '', payload: { channel: 'C1', text }, editable: [] });
  const status = async (id: string) => (await repo.getProposal(id))!.status;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    streamId = (await repo.createStream({ title: 't', summary: 's' })).id;
  });

  it('what counts as an edit: a changed field, not the mentions worked out from the text', async () => {
    const a = await slack('run1', 'hello');
    expect(Repo.editedByPU(a)).toBe(false);
    expect(Repo.editedByPU({ ...a, payload: { ...a.payload, mentions: [{ name: 'x' }] } })).toBe(false);
    expect(Repo.editedByPU({ ...a, payload: { ...a.payload, text: 'hello there' } })).toBe(true);
  });

  it('a later draft to the same place sits next to the edited one; an untouched older one is still replaced', async () => {
    const edited = await slack('run1', 'hello');
    await repo.updateProposal(edited.id, { payload: { channel: 'C1', text: 'hello, my wording' } });
    const untouched = await slack('run1b', 'hello again'); // same turn as nothing: a separate run
    const newer = await slack('run2', 'more details');
    expect(await status(edited.id)).toBe('pending'); // yours stays
    expect(await status(untouched.id)).toBe('withdrawn'); // Claude's own, untouched, is replaced as before
    expect(await status(newer.id)).toBe('pending');
    expect((await repo.getProposal(edited.id))!.payload.text).toBe('hello, my wording');
  });

  it('naming the edited draft in "replaces" does not discard it either', async () => {
    const { buildTools } = await import('../src/agent/tools.js');
    const { defaultSettings } = await import('../src/core/settings.js');
    const edited = await slack('run1', 'hello');
    await repo.updateProposal(edited.id, { payload: { channel: 'C1', text: 'hello, my wording' } });
    const plain = await slack('run1c', 'plain');
    const hub = { systemMode: async () => 'api', api: async () => ({}) } as any;
    const list = await buildTools({ streamId, runId: 'run3' }, { repo, hub, grants: {} as any, executor: {} as any, settings: async () => defaultSettings() });
    const out = await list.find((t) => t.name === 'propose_slack_message')!.handler({ channel: 'C1', text: 'more details', rationale: 'more detail asked for', replaces: [edited.id, plain.id] });
    expect(await status(edited.id)).toBe('pending');
    expect(await status(plain.id)).toBe('withdrawn');
    expect(String(out)).toMatch(/discarded\. 1 the PU had edited was kept and shown next to this one/);
  });
});
