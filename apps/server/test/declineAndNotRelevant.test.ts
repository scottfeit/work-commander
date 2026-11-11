import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';

let repo: Repo;
let streamId: string;
beforeEach(async () => {
  repo = new Repo((await openDatabase('sqlite::memory:')).db);
  streamId = (await repo.createStream({ title: 't', summary: 's' })).id;
});
const suggest = (instruction = 'do it') => repo.addChat({ streamId, role: 'suggestion', content: instruction, meta: { suggestion: { instruction, status: 'open' } } });
const decline = async (id: string) => {
  const m = (await repo.getChat(id))!;
  await repo.updateChatMeta(m.id, { ...m.meta, suggestion: { ...m.meta.suggestion!, status: 'dismissed' } });
  return repo.offerCloseAfterDecline(streamId, id);
};

describe('declining a suggested next step', () => {
  it('offers to close the work stream', async () => {
    const s = await suggest();
    const p = await decline(s.id);
    expect(p?.kind).toBe('stream_close');
    expect((await repo.listProposals({ streamId, status: ['pending'] })).map((x) => x.kind)).toEqual(['stream_close']);
  });
  it('does not offer while another next step or a draft is still waiting', async () => {
    const a = await suggest('a');
    await suggest('b');
    expect(await decline(a.id)).toBeNull();
    const c = await suggest('c');
    await repo.createProposal({ streamId, runId: 'r', kind: 'email_send', system: 'google', title: 'd', rationale: '', payload: {}, editable: [] });
    expect(await decline(c.id)).toBeNull();
  });
  it('does not offer twice or for a closed stream', async () => {
    const a = await suggest();
    await decline(a.id);
    const b = await suggest();
    expect(await decline(b.id)).toBeNull(); // close already pending
    await repo.updateStream(streamId, { status: 'closed' });
    expect(await repo.offerCloseAfterDecline(streamId, 'x')).toBeNull();
  });
});

describe('marking an item not relevant to its work stream', () => {
  const upsert = () => repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'e1', title: 'Thread', data: { messages: [] }, streamId });
  it('removes it from the stream and remembers the exclusion across new activity', async () => {
    const { item } = await upsert();
    await repo.markItemNotRelevant(item.id, streamId);
    expect(await repo.listItems(streamId)).toHaveLength(0);
    const again = await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'e1', title: 'Thread', data: { messages: [{ id: 'm', author: {}, text: 'hi', at: new Date().toISOString() }] } });
    expect(again.item.streamId).toBeNull();
    expect(again.item.data.notRelevantTo).toEqual([streamId]);
    expect((await repo.listSkipped())[0]?.reason).toMatch(/not relevant/);
  });
  it('an explicit re-attach clears the exclusion', async () => {
    const { item } = await upsert();
    await repo.markItemNotRelevant(item.id, streamId);
    await repo.attachItem(item.id, streamId);
    const it = (await repo.getItem(item.id))!;
    expect(it.streamId).toBe(streamId);
    expect(it.data.notRelevantTo).toBeUndefined();
  });
});

describe('linking and moving items', () => {
  const ticket = (key: string) => ({ source: 'jsm' as const, kind: 'ticket' as const, externalId: key, title: `${key} Thing`, data: { ticket: { key, summary: 's', status: 'Open', flavor: 'jsm' as const, comments: [] } } });
  it('finds the single open stream that already mentions a ticket key', async () => {
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g1', title: 'Re: SEUS-2260 access', data: { messages: [] }, streamId });
    expect((await repo.findOpenStreamMentioning('SEUS-2260'))?.id).toBe(streamId);
    expect(await repo.findOpenStreamMentioning('SEUS-9999')).toBeNull();
    expect(await repo.findOpenStreamMentioning('SEUS-2260', [streamId])).toBeNull();
    const other = await repo.createStream({ title: 'Also SEUS-2260', summary: '' });
    expect(other.id).not.toBe(streamId);
    expect(await repo.findOpenStreamMentioning('SEUS-2260')).toBeNull(); // ambiguous: left to triage
  });
  it('moves an item between streams, or in from the skipped list', async () => {
    const other = (await repo.createStream({ title: 'other', summary: '' })).id;
    const { item } = await repo.upsertItem({ ...ticket('SEUS-1'), streamId });
    await repo.moveItem(item.id, other);
    expect((await repo.getItem(item.id))!.streamId).toBe(other);
    expect(await repo.listItems(streamId)).toHaveLength(0);
    await repo.markItemNotRelevant(item.id, other);
    await repo.moveItem(item.id, streamId);
    expect((await repo.getItem(item.id))!.streamId).toBe(streamId);
    await repo.updateStream(other, { status: 'closed' });
    await expect(repo.moveItem(item.id, other)).rejects.toThrow(/Reopen/);
  });
});

describe('Slack DMs are one conversation', () => {
  const dm = (ts: string, id: string, title = 'DM from Pat') => ({ source: 'slack' as const, kind: 'slack_thread' as const, externalId: `D1ABC:${ts}`, title, data: { messages: [{ id, author: { name: 'Pat' }, text: id, at: new Date(Number(ts) * 1000).toISOString() }] } });
  it('adds a later DM to the existing item instead of a new one', async () => {
    const first = (await repo.upsertItem({ ...dm('100.1', 'm1'), streamId })).item;
    const second = await repo.upsertItem(dm('200.2', 'm2', 'DM with Pat'));
    expect(second.item.id).toBe(first.id);
    expect(second.item.title).toBe('DM from Pat');
    expect(second.item.data.messages?.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(second.item.streamId).toBe(streamId);
  });
  it('records a sent reply on an MCP-ingested DM item (no slack metadata)', async () => {
    const { item } = await repo.upsertItem({ ...dm('100.1', 'm1'), streamId });
    const r = await repo.recordSentMessage(streamId, 'slack', { channel: 'D1ABC' }, 'Good day', 'p1', { name: 'Me' });
    expect(r?.id).toBe(item.id);
    expect((await repo.getItem(item.id))!.data.messages?.map((m) => m.text)).toEqual(['m1', 'Good day']);
  });
  it('merges DM items an older version had split', async () => {
    const a = await repo.db.insertInto('items').values({ id: 'a', stream_id: streamId, source: 'slack', kind: 'slack_thread', external_id: 'D1ABC:100.1', title: 'DM from Pat', url: null, data: JSON.stringify(dm('100.1', 'm1').data), updated_at: '2026-01-01T00:00:00Z' }).execute();
    void a;
    await repo.db.insertInto('items').values({ id: 'b', stream_id: streamId, source: 'slack', kind: 'slack_thread', external_id: 'D1ABC:200.2', title: 'DM with Pat', url: null, data: JSON.stringify(dm('200.2', 'm2').data), updated_at: '2026-01-02T00:00:00Z' }).execute();
    expect(await repo.mergeSlackDmItems()).toBe(1);
    const items = await repo.listItems(streamId);
    expect(items.map((i) => i.id)).toEqual(['a']);
    expect(items[0].data.messages?.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('dismissing skipped items', () => {
  const dm = { source: 'gmail' as const, kind: 'email_thread' as const, externalId: 'x1', title: 'FYI', data: { messages: [{ id: 'm1', author: { name: 'A' }, text: 'a', at: '2026-11-11T00:00:00Z' }] } };
  it('hides it until it has new activity', async () => {
    const { item } = await repo.upsertItem(dm);
    expect((await repo.listSkipped()).map((x) => x.id)).toEqual([item.id]);
    await repo.dismissSkipped(item.id);
    expect(await repo.listSkipped()).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    await repo.upsertItem({ ...dm, data: { messages: [{ id: 'm2', author: { name: 'A' }, text: 'again', at: '2026-11-11T01:00:00Z' }] } });
    expect((await repo.listSkipped()).map((x) => x.id)).toEqual([item.id]);
  });
  it('refuses items already in a work stream', async () => {
    const { item } = await repo.upsertItem({ ...dm, streamId });
    await expect(repo.dismissSkipped(item.id)).rejects.toThrow();
  });
});

describe('items created through WC appear in the stream', () => {
  const pu = { name: 'Me', email: 'me@x.com' };
  const sent = (id: string, text = 'hi') => ({ id: `sent-${id}`, author: pu, text, at: new Date().toISOString(), isFromPU: true });
  it('creates a Slack DM item when the stream has none, then reuses it', async () => {
    const a = await repo.recordSentOrCreate(streamId, 'slack', { channel: 'D9' }, sent('1.1'), { kind: 'slack_thread', externalId: 'D9:1.1', title: 'DM with Sam', data: { slack: { channel: 'D9', threadTs: '1.1' } } });
    expect(a?.streamId).toBe(streamId);
    expect((await repo.listItems(streamId)).map((i) => i.title)).toEqual(['DM with Sam']);
    await repo.recordSentOrCreate(streamId, 'slack', { channel: 'D9' }, sent('2.2', 'again'), { kind: 'slack_thread', externalId: 'D9:2.2', title: 'DM with Sam', data: {} });
    const items = await repo.listItems(streamId);
    expect(items).toHaveLength(1);
    expect(items[0].data.messages?.map((m) => m.text)).toEqual(['hi', 'again']);
  });
  it('a placeholder DM title takes the real name once known', async () => {
    await repo.recordSentOrCreate(streamId, 'slack', { channel: 'D9' }, sent('1.1'), { kind: 'slack_thread', externalId: 'D9:1.1', title: 'Slack DM', data: {} });
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'D9:5.5', title: 'DM from Sam', data: { messages: [{ id: '5.5', author: { name: 'Sam' }, text: 'yo', at: new Date().toISOString() }] } });
    expect((await repo.listItems(streamId))[0].title).toBe('DM from Sam');
  });
  it('creates email and ticket items, and does not duplicate a ticket', async () => {
    await repo.recordSentOrCreate(streamId, 'gmail', { threadId: 'T1' }, sent('p1', 'body'), { kind: 'email_thread', externalId: 'T1', title: 'Subject', data: {} });
    const ticket = { key: 'IT-9', summary: 's', status: 'Open', flavor: 'jsm' as const, comments: [] };
    await repo.recordSentOrCreate(streamId, 'jsm', { ticketKey: 'IT-9' }, null, { kind: 'ticket', externalId: 'IT-9', title: 'IT-9: s', data: { ticket } });
    await repo.recordSentOrCreate(streamId, 'jsm', { ticketKey: 'IT-9' }, null, { kind: 'ticket', externalId: 'IT-9', title: 'IT-9: s', data: { ticket } });
    expect((await repo.listItems(streamId)).map((i) => i.title).sort()).toEqual(['IT-9: s', 'Subject']);
  });
  it('leaves an item that is already in another work stream alone', async () => {
    const other = (await repo.createStream({ title: 'o', summary: '' })).id;
    await repo.recordSentOrCreate(other, 'slack', { channel: 'D9' }, sent('1.1'), { kind: 'slack_thread', externalId: 'D9:1.1', title: 'DM with Sam', data: {} });
    await repo.recordSentOrCreate(streamId, 'slack', { channel: 'D9' }, sent('3.3'), { kind: 'slack_thread', externalId: 'D9:3.3', title: 'DM with Sam', data: {} });
    expect(await repo.listItems(streamId)).toHaveLength(0);
    expect(await repo.listItems(other)).toHaveLength(1);
  });
});

describe('a DM named ":dm" by the ingestor joins the conversation', () => {
  it('upserts into the existing DM item and merges old split items', async () => {
    const msg = (id: string, name: string, pu = false) => ({ id, author: { name }, text: id, at: `2026-11-11T00:00:${id.padStart(2, '0')}Z`, isFromPU: pu });
    const first = (await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'D5:1.1', title: 'DM with Pat', data: { messages: [msg('10', 'Pat')] }, streamId })).item;
    const next = await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'D5:dm', title: 'DM with Pat', data: { messages: [msg('11', 'Me', true), msg('12', 'Pat')] } });
    expect(next.item.id).toBe(first.id);
    expect(next.item.data.messages?.map((m) => m.id)).toEqual(['10', '11', '12']);
    // an older build had split them: the cleanup folds them back
    await repo.db.insertInto('items').values({ id: 'z', stream_id: streamId, source: 'slack', kind: 'slack_thread', external_id: 'D6:dm', title: 'DM with Lee', url: null, data: JSON.stringify({ messages: [msg('20', 'Lee')] }), updated_at: '2026-01-01T00:00:00Z' }).execute();
    await repo.db.insertInto('items').values({ id: 'y', stream_id: streamId, source: 'slack', kind: 'slack_thread', external_id: 'D6:5.5', title: 'DM with Lee', url: null, data: JSON.stringify({ messages: [msg('21', 'Lee')] }), updated_at: '2026-01-02T00:00:00Z' }).execute();
    expect(await repo.mergeSlackDmItems()).toBe(1);
  });
});

describe('ticket assignment', () => {
  it('replaces an older pending assign draft for the same ticket', async () => {
    const mk = (assignee: string, runId: string) => repo.createProposal({ streamId, runId, kind: 'ticket_assign', system: 'atlassian', title: 'a', rationale: '', payload: { key: 'IT-1', assignee }, editable: [] });
    const a = await mk('a@x.com', 'r1');
    await mk('b@x.com', 'r2');
    expect((await repo.getProposal(a.id))!.status).toBe('withdrawn');
  });
});
