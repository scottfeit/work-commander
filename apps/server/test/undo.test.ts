import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { UndoLog } from '../src/core/undo.js';
import type { GmailAction, Settings } from '@wc/shared';

const msg = (id: string, text = 'hello', at = new Date().toISOString()) => ({ id, author: { name: 'Dana', email: 'dana@x.com' }, text, at });

describe('system-wide Undo', () => {
  let repo: Repo;
  let undo: UndoLog;
  let gmailCalls: [string, GmailAction, boolean | undefined][];
  let n = 0;
  const email = async (streamId: string | null, title = 'Thread') => {
    n++;
    return (await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: `t${n}`, title, data: { messages: [msg(`m${n}`)] }, streamId })).item;
  };

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    gmailCalls = [];
    undo = new UndoLog({ repo, gmail: async (id, a, o) => void gmailCalls.push([id, a, o.toInbox]) });
  });

  it('moving the last item out of a stream (which removes it) is undone: the stream, its chat and its drafts come back', async () => {
    const a = await repo.createStream({ title: 'A', summary: 'about A' });
    const b = await repo.createStream({ title: 'B', summary: '' });
    const it = await email(a.id);
    await repo.addChat({ streamId: a.id, role: 'assistant', content: 'notes on A' });
    const p = await repo.createProposal({ streamId: a.id, runId: 'r', kind: 'email_reply', system: 'gmail', title: 'Reply', rationale: '', payload: { thread_id: 't1' }, editable: [], dependsOn: [] } as any);
    await undo.capture('move', { items: [it.id], streams: [b.id] }, () => repo.moveItem(it.id, b.id));
    expect(await repo.getStream(a.id)).toBeNull();
    expect((await undo.info()).next).toBe('move');

    expect(await undo.undo()).toBe('move');
    expect((await repo.getStream(a.id))?.summary).toBe('about A');
    expect((await repo.getItem(it.id))?.streamId).toBe(a.id);
    expect((await repo.listChat(a.id)).some((c) => c.content === 'notes on A')).toBe(true);
    expect((await repo.getProposal(p.id))?.streamId).toBe(a.id);
    expect((await undo.info()).count).toBe(0);
  });

  it('stream state and edits: pending, close, title and overview (whose history entry goes too)', async () => {
    const s = await repo.createStream({ title: 'Budget', summary: 'v1' });
    await undo.capture('pending', { streams: [s.id] }, () => repo.updateStream(s.id, { pending: true }, 'you'));
    await undo.capture('edit', { streams: [s.id] }, () => repo.updateStream(s.id, { title: 'Budget 2', summary: 'v2' }, 'you'));
    await undo.capture('close', { streams: [s.id] }, () => repo.updateStream(s.id, { status: 'closed' }, 'you'));
    expect((await repo.getStream(s.id))!.status).toBe('closed');

    await undo.undo();
    expect((await repo.getStream(s.id))!).toMatchObject({ status: 'open', pending: true }); // closing had cleared pending; both come back as they were before the close
    await undo.undo();
    expect((await repo.getStream(s.id))!).toMatchObject({ title: 'Budget', summary: 'v1' });
    expect((await repo.listSummaries(s.id)).map((v) => v.summary)).toEqual(['v1']);
    await undo.undo();
    expect((await repo.getStream(s.id))!.pending).toBe(false);
    expect(await undo.undo()).toBeNull();
  });

  it('keeps only the last three actions, newest first', async () => {
    const s = await repo.createStream({ title: 'S', summary: '' });
    for (const t of ['one', 'two', 'three', 'four']) await undo.capture(t, { streams: [s.id] }, () => repo.updateStream(s.id, { title: t }, 'you'));
    expect(await undo.info()).toEqual({ next: 'four', count: 3 });
    expect(await undo.undo()).toBe('four');
    expect(await undo.undo()).toBe('three');
    expect(await undo.undo()).toBe('two');
    expect(await undo.undo()).toBeNull();
    expect((await repo.getStream(s.id))!.title).toBe('one');
  });

  it("doesn't rewind content that arrived since: new messages on an item survive undoing a decline", async () => {
    const it = await email(null);
    await undo.capture('decline & mute', { items: [it.id] }, () => repo.dismissSkipped(it.id, true));
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: it.externalId, title: it.title, data: { messages: [msg('later')] } });
    await undo.undo();
    const back = (await repo.getItem(it.id))!;
    expect(back.data.proposalsMuted).toBeUndefined();
    expect(back.data.dismissedAt).toBeUndefined();
    expect(back.data.messages!.map((m) => m.id)).toContain('later');
  });

  it('tab order goes back', async () => {
    const s = await repo.createStream({ title: 'S', summary: '' });
    const x = await email(s.id);
    const y = await email(s.id);
    const ids = async () => (await repo.listItems(s.id)).map((i) => i.id);
    const before = await ids();
    await undo.capture('rearrange', { items: before, streams: [s.id] }, () => repo.setItemOrder(s.id, [y.id, x.id]));
    expect(await ids()).toEqual([y.id, x.id]);
    await undo.undo();
    expect(await ids()).toEqual(before);
  });

  it('a Gmail button is undone by the opposite action; undoing a delete puts it back in the Inbox only if it was there', async () => {
    const it = await email(null);
    await undo.recordGmail('archive', it.id, 'archive', true);
    await undo.recordGmail('delete', it.id, 'trash', true);
    await undo.undo();
    await undo.undo();
    expect(gmailCalls).toEqual([
      [it.id, 'untrash', true],
      [it.id, 'unarchive', false],
    ]);
  });

  it('a Slack message move is undoable only until a new message arrives in that conversation', async () => {
    const a = await repo.createStream({ title: 'A', summary: '' });
    const b = await repo.createStream({ title: 'B', summary: '' });
    const t0 = Date.now();
    const at = (k: number) => new Date(t0 + k * 1000).toISOString();
    const base = { source: 'slack' as const, kind: 'slack_thread' as const, externalId: 'C0CHANNEL1:dm', title: 'Channel' };
    const it = (await repo.upsertItem({ ...base, data: { slack: { channel: 'C0CHANNEL1' } as any, messages: [msg('1.1', 'a', at(1)), msg('1.2', 'b', at(2)), msg('1.3', 'c', at(3))] }, streamId: a.id })).item;
    const move = () => undo.capture('move 1', { slackChannel: 'C0CHANNEL1', items: [it.id], streams: [a.id, b.id] }, () => repo.placeSlackMessages({ channel: 'C0CHANNEL1', toStreamId: b.id, messages: [msg('1.3', 'c', at(3))], title: 'Channel', flat: true }));
    await move();
    const where = async () => Object.fromEntries((await repo.slackFamily('C0CHANNEL1')).map((i) => [i.streamId, (i.data.messages ?? []).map((m) => m.id)]));
    expect(await where()).toEqual({ [a.id]: ['1.1', '1.2'], [b.id]: ['1.3'] });
    await undo.undo();
    expect(await where()).toEqual({ [a.id]: ['1.1', '1.2', '1.3'] });

    // again, then a reply arrives in the conversation: the move can't be undone any more
    await move();
    await repo.upsertItem({ ...base, data: { slack: { channel: 'C0CHANNEL1' } as any, messages: [msg('1.4', 'd', at(4))] } });
    expect(await undo.info()).toEqual({ next: null, count: 0 });
    expect(await undo.undo()).toBeNull();
  });

  it('Laya forgets what an undone action taught it', async () => {
    let restored = 0;
    undo = new UndoLog({ repo, gmail: async () => undefined, layaChanged: async () => void restored++ });
    const it0 = await email(null);
    const db = repo.db;
    const t = new Date().toISOString();
    await db.insertInto('laya_examples').values({ id: 'ex1', part: 'relevance', item_id: it0.id, candidate: '', state: 's', gold: '{"q":false}', source: 'claude', created_at: t, updated_at: t }).execute();
    await undo.capture('accept', { items: [it0.id] }, async () => {
      await db.updateTable('laya_examples').set({ gold: '{"q":true}', source: 'pu' }).where('id', '=', 'ex1').execute();
      await db.insertInto('laya_examples').values({ id: 'ex2', part: 'stream', item_id: it0.id, candidate: 'S', state: 's', gold: '{"q":true}', source: 'pu', created_at: t, updated_at: t }).execute();
    });
    await undo.undo();
    const rows = await db.selectFrom('laya_examples').selectAll().where('item_id', '=', it0.id).execute();
    expect(rows.map((r) => [r.id, r.gold, r.source])).toEqual([['ex1', '{"q":false}', 'claude']]);
    expect(restored).toBe(1);
  });

  describe('accepting', () => {
    let s: Settings;
    let triage: TriagePipeline;
    beforeEach(() => {
      s = defaultSettings();
      s.pu = { ...s.pu, name: 'Scott', email: 'scott@x.com' };
      s.triage = { ...s.triage, newStreams: 'ask' };
      const answer = { relevant: true, reason: 'asks', stream: { action: 'new', streamId: null, title: 'Q3 budget', summary: 'Review it', labels: [] }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
      triage = new TriagePipeline(repo, { structured: async () => answer } as any, { run: async () => undefined } as any, async () => s);
    });

    it('undoing Accept on a proposed stream removes the stream and its drafts; the proposal is back in the list', async () => {
      await triage.handle({ source: 'gmail', kind: 'email_thread', externalId: 'tp', title: 'Budget', eventId: 'e', data: { messages: [msg('mp')] } });
      const item = (await repo.findItem('gmail', 'tp'))!;
      const r = await undo.capture('accept', { items: [item.id] }, async () => ({ streamId: await triage.acceptProposed(item.id) }), { created: (x) => ({ streams: [x.streamId] }) });
      const draft = await repo.createProposal({ streamId: r.streamId, runId: 'later', kind: 'email_reply', system: 'gmail', title: 'Reply', rationale: '', payload: { thread_id: 'tp' }, editable: [], dependsOn: [] } as any);
      await undo.undo();
      expect(await repo.getStream(r.streamId!)).toBeNull();
      expect((await repo.getProposal(draft.id))?.status).toBe('withdrawn');
      const back = (await repo.getItem(item.id))!;
      expect(back.streamId).toBeNull();
      expect(back.data.proposedStream?.title).toBe('Q3 budget');
      expect((await repo.listSkipped())[0]).toMatchObject({ id: item.id, proposed: { title: 'Q3 budget' } });
    });

    it('undoing an Accept that filed into an existing stream takes the item out and withdraws the drafts made for it there', async () => {
      const home = await repo.createStream({ title: 'Budget', summary: '' });
      const other = await email(home.id, 'Other thread');
      const item = await email(null, 'Skipped');
      const r = await undo.capture('accept', { items: [item.id] }, async () => (await repo.attachItem(item.id, home.id), { streamId: home.id }), { created: (x) => ({ streams: [x.streamId] }), draftsFor: (x) => ({ itemId: item.id, streamId: x.streamId }) });
      const forIt = await repo.createProposal({ streamId: home.id, runId: 'x', kind: 'email_reply', system: 'gmail', title: 'Reply', rationale: '', payload: { thread_id: item.externalId }, editable: [], dependsOn: [] } as any);
      const forOther = await repo.createProposal({ streamId: home.id, runId: 'y', kind: 'email_reply', system: 'gmail', title: 'Reply 2', rationale: '', payload: { thread_id: other.externalId }, editable: [], dependsOn: [] } as any);
      await undo.undo();
      expect(await repo.getStream(r.streamId)).not.toBeNull(); // existing stream stays
      expect((await repo.getItem(item.id))!.streamId).toBeNull();
      expect((await repo.getProposal(forIt.id))?.status).toBe('withdrawn');
      expect((await repo.getProposal(forOther.id))?.status).toBe('pending');
    });
  });
});
