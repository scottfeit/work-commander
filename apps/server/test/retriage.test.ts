import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';

const no = { relevant: false, reason: 'Newsletter', stream: { action: 'none', streamId: null, title: null, summary: null, labels: null }, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
const yes = { ...no, relevant: true, reason: 'Chris asks Scott for advice', stream: { action: 'new', streamId: null, title: 'Advice for Chris', summary: 'Chris asks for advice', labels: [] } };

describe('Triage again', () => {
  let repo: Repo;
  let answer: any;
  let seen: string[];
  const triage = () =>
    new TriagePipeline(repo, { structured: async (i: any) => (seen.push(i.prompt), answer) } as any, { run: async () => undefined } as any, async () => defaultSettings());
  const item = (messages: any[]) => repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Development Idea', data: { messages }, eventId: 'e1' });
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    seen = [];
  });

  it('lists the skipped item, and turns it into a work stream when triage now says so', async () => {
    const { item: it } = await item([{ id: 'm1', author: { name: 'Chris' }, text: 'Is this a good idea?', at: '2026-11-11T05:25:54Z' }]);
    expect((await repo.listSkipped()).map((x) => x.id)).toEqual([it.id]);
    answer = yes;
    const r = await triage().retriage(it.id);
    expect(r.decision.relevant).toBe(true);
    expect((await repo.getStream(r.streamId!))!.title).toBe('Advice for Chris');
    expect(await repo.listSkipped()).toEqual([]);
    expect(seen[0]).toContain('<message from="Chris');
  });

  it('reports "still not relevant" and only creates a stream when forced', async () => {
    const { item: it } = await item([{ id: 'm1', author: { name: 'News' }, text: 'Weekly digest', at: '2026-11-11T05:00:00Z' }]);
    answer = no;
    expect((await triage().retriage(it.id)).streamId).toBeNull();
    const forced = await triage().retriage(it.id, true);
    expect(forced.streamId).toBeTruthy();
    expect(forced.decision.reason).toMatch(/Marked relevant by the PU/);
  });

  it('triages only what others sent after the PU last wrote', async () => {
    const { item: it } = await item([
      { id: 'm1', author: { name: 'Chris' }, text: 'old question', at: '2026-11-11T01:00:00Z' },
      { id: 'm2', author: { name: 'Scott' }, text: 'my answer', at: '2026-11-11T02:00:00Z', isFromPU: true },
      { id: 'm3', author: { name: 'Chris' }, text: 'new question', at: '2026-11-11T03:00:00Z' },
    ]);
    answer = no;
    await triage().retriage(it.id);
    const newPart = seen[0].split('NEW activity:')[1];
    expect(newPart).toContain('new question');
    expect(newPart).not.toContain('old question');
  });

  it('files a no-action item into the existing stream triage names (SEUS-2260 case)', async () => {
    const stream = await repo.createStream({ title: 'SEUS-2260 access request', summary: '' });
    const { item: it } = await item([{ id: 'm1', author: { name: 'Scott' }, text: 'Checking, more info tomorrow', at: '2026-11-11T05:00:00Z', isFromPU: true }]);
    answer = { ...no, reason: 'Own reply; belongs to the existing stream', stream: { action: 'existing', streamId: stream.id, title: null, summary: null, labels: null } };
    const r = await triage().retriage(it.id);
    expect(r.decision.relevant).toBe(false);
    expect(r.streamId).toBe(stream.id);
    expect((await repo.getItem(it.id))!.streamId).toBe(stream.id);
  });

  it('links a ticket to the one open stream already mentioning its key, without asking the model', async () => {
    const stream = await repo.createStream({ title: 'x', summary: '' });
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g1', title: 'Re: SEUS-2260 access', data: { messages: [] }, streamId: stream.id });
    const { item: tk } = await repo.upsertItem({ source: 'jsm', kind: 'ticket', externalId: 'SEUS-2260', title: 'SEUS-2260 Access', data: { ticket: { key: 'SEUS-2260', summary: 's', status: 'Open', flavor: 'jsm', comments: [] } } });
    answer = no;
    const r = await triage().retriage(tk.id);
    expect(r.streamId).toBe(stream.id);
    expect(seen).toHaveLength(0);
  });
});

describe('ticket outcomes are not new activity', () => {
  let repo: Repo;
  let calls = 0;
  const triage = () => new TriagePipeline(repo, { structured: async () => (calls++, no) } as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, name: 'Scott Feit', email: 's@x.com' } }));
  const ticket = (status: string, assignee: string | undefined, eventId: string) => ({ source: 'jsm' as const, kind: 'ticket' as const, externalId: 'IT-1', title: 'IT-1 Thing', eventId, data: { ticket: { key: 'IT-1', summary: 's', status, assignee, flavor: 'jsm' as const, comments: [] } } });
  const setup = async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    calls = 0;
    const streamId = (await repo.createStream({ title: 't', summary: '' })).id;
    await repo.upsertItem({ ...ticket('In Progress', 'Someone', 'e0'), streamId });
    const close = await repo.createProposal({ streamId, runId: 'r', kind: 'stream_close', system: 'internal', title: 'Close', rationale: '', payload: {}, editable: [] });
    return { close };
  };

  it('a close WC requested (and the follow-on Resolved -> Closed) keeps the pending close and skips triage', async () => {
    const { close } = await setup();
    const it = (await repo.findItem('jsm', 'IT-1'))!;
    await repo.noteWcTransition(it.id);
    await triage().handle(ticket('Resolved', 'Scott Feit', 'e1'));
    await triage().handle(ticket('Closed', 'Scott Feit', 'e2'));
    expect(calls).toBe(0);
    expect((await repo.getProposal(close.id))!.status).toBe('pending');
  });
  it('an assignment to the PU that WC did not make is new activity', async () => {
    await setup();
    await triage().handle(ticket('In Progress', 'Scott Feit', 'e1'));
    expect(calls).toBe(1);
  });
  it('a close nobody at WC asked for, a reopen, or a hand-off is still activity', async () => {
    await setup();
    await triage().handle(ticket('Closed', 'Someone', 'e1'));
    expect(calls).toBe(1);
    await triage().handle(ticket('Waiting', 'Someone Else', 'e2'));
    expect(calls).toBe(2);
  });
});

describe('the PU replies directly (outside WC)', () => {
  let repo: Repo;
  let runs: any[];
  const triage = () => new TriagePipeline(repo, { structured: async () => no } as any, { run: async (r: any) => void runs.push(r) } as any, async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, name: 'Scott Feit', email: 's@x.com' } }));
  const msg = (id: string, text: string, pu: boolean) => ({ id, author: { name: pu ? 'Scott Feit' : 'Alex' }, text, at: new Date(Number(id) * 1000).toISOString(), isFromPU: pu });
  const dm = (messages: any[], eventId: string) => ({ source: 'slack' as const, kind: 'slack_thread' as const, externalId: 'D1:dm', title: 'DM with Alex', eventId, data: { messages, slack: { channel: 'D1', threadTs: '1' } } });
  let streamId: string;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    runs = [];
    streamId = (await repo.createStream({ title: 't', summary: '' })).id;
    await repo.upsertItem({ ...dm([msg('1', 'question?', true), msg('2', 'not sanctioned', false)], 'e0'), streamId });
  });

  it('withdraws the pending draft for that conversation, settles open questions, and tells the agent', async () => {
    const draft = await repo.createProposal({ streamId, runId: 'r', kind: 'mcp_tool_call', system: 'slack', title: 'slack send', rationale: '', payload: { server: 'slack', tool: 'slack_send_message', args: { channel_id: 'D1', message: 'x' } }, editable: [] });
    const q = await repo.addChat({ streamId, role: 'question', content: 'What should change?', meta: { question: { options: ['a'] } } });
    await triage().handle(dm([msg('1', 'question?', true), msg('2', 'not sanctioned', false), msg('3', 'my own reply', true)], 'e1'));
    expect((await repo.getProposal(draft.id))!.status).toBe('withdrawn');
    expect((await repo.getChat(q.id))!.meta.question?.answered).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toContain('my own reply');
  });
  it("WC's own send coming back from Slack (with its footer) is not a direct reply", async () => {
    await repo.recordSentMessage(streamId, 'slack', { channel: 'D1' }, 'On it', 'p1', { name: 'Scott Feit' });
    await triage().handle(dm([msg('1', 'question?', true), msg('2', 'not sanctioned', false), msg('3', 'On it\n*Sent using* Work Commander', true)], 'e2'));
    expect(runs).toHaveLength(0);
    const it = (await repo.listItems(streamId))[0];
    expect(it.data.messages?.some((m) => m.id.startsWith('sent-'))).toBe(false);
  });
});

describe('auto-linking by ticket key', () => {
  let repo: Repo;
  let calls = 0;
  const triage = () => new TriagePipeline(repo, { structured: async () => (calls++, no) } as any, { run: async () => undefined } as any, async () => defaultSettings());
  const slack = (text: string, id = 't1') => ({ source: 'slack' as const, kind: 'slack_thread' as const, externalId: `C1:${id}`, title: 'follow-up in #ops', eventId: `e-${id}`, data: { messages: [{ id: '9', author: { name: 'Scott' }, text, at: '2026-11-11T00:00:00Z', isFromPU: true }] } });
  const stream = async (title: string) => (await repo.createStream({ title, summary: '' })).id;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    calls = 0;
  });

  it("links the PU's own Slack message that names a tracked ticket to that stream, without a model call", async () => {
    const id = await stream('IT-75435 Umbrella reinstall');
    await triage().handle(slack('Update on IT-75435: waiting on Jamf'));
    const it = (await repo.findItem('slack', 'C1:t1'))!;
    expect(it.streamId).toBe(id);
    expect(calls).toBe(0);
  });
  it('Triage again links it too, instead of creating a second stream', async () => {
    const id = await stream('IT-75435 Umbrella reinstall');
    const { item } = await repo.upsertItem(slack('Re IT-75435: more info', 't2'));
    const r = await triage().retriage(item.id, true);
    expect(r.streamId).toBe(id);
    expect(await repo.listStreams(false)).toHaveLength(1);
  });
  it('does not guess when several open streams track the mentioned tickets', async () => {
    await stream('IT-1 first');
    await stream('IT-2 second');
    await triage().handle(slack('Both IT-1 and IT-2 are related'));
    expect((await repo.findItem('slack', 'C1:t1'))!.streamId).toBeNull();
  });
});

describe('related skipped messages', () => {
  it('shows recent skipped items to triage and files the related ones into the new stream', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const a = (await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'a', title: 'Pilot: Outage - 60 East 42nd', data: { messages: [{ id: '1', author: { name: 'Pilot' }, text: 'power outage', at: new Date().toISOString() }] } })).item;
    const unrelated = (await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'u', title: 'Newsletter', data: { messages: [{ id: '2', author: { name: 'News' }, text: 'weekly', at: new Date().toISOString() }] } })).item;
    let seen = '';
    const decision = { relevant: true, reason: 'NYC office outage: several reports of one incident', stream: { action: 'new', streamId: null, title: 'NYC office outage', summary: 'Network down in NYC', labels: [] }, relatedItemIds: [a.id, 'nope'], updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    const t = new TriagePipeline(repo, { structured: async (i: any) => ((seen = i.prompt), decision) } as any, { run: async () => undefined } as any, async () => defaultSettings());
    await t.handle({ source: 'gmail', kind: 'email_thread', externalId: 'b', title: 'NYC internet down', eventId: 'e1', data: { messages: [{ id: '3', author: { name: 'Ben', email: 'ben@x.com' }, text: 'office is offline', at: new Date().toISOString() }] } });
    expect(seen).toContain('Recently skipped messages');
    expect(seen).toContain(`item ${a.id}`);
    const streamId = (await repo.findItem('gmail', 'b'))!.streamId!;
    expect((await repo.getItem(a.id))!.streamId).toBe(streamId);
    expect((await repo.getItem(unrelated.id))!.streamId).toBeNull();
  });
});

describe('recovering interrupted triage', () => {
  it('judges an event that was recorded but never processed, and files it', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const stream = (await repo.createStream({ title: 'Ticket work', summary: '' })).id;
    const { item } = await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g1', title: '[JIRA] X mentioned you on PD-1', data: { messages: [{ id: '1', author: { name: 'Jira' }, text: 'please check', at: '2026-11-11T00:00:00Z' }] } });
    await repo.recordInbound('gmail', 'g1', item.id); // ...and then the process died
    expect(await repo.listUnprocessedInbound(0)).toHaveLength(1);
    expect(await repo.listUnprocessedInbound(60_000)).toHaveLength(0); // too recent to be sure it is stuck
    const decision = { relevant: true, reason: 'Needs a look', stream: { action: 'existing', streamId: stream, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    const t = new TriagePipeline(repo, { structured: async () => decision } as any, { run: async () => undefined } as any, async () => defaultSettings());
    expect(await t.recoverUnprocessed(0)).toBe(1);
    expect((await repo.getItem(item.id))!.streamId).toBe(stream);
    expect(await repo.listUnprocessedInbound(0)).toHaveLength(0);
  });
});

describe('Accept (forced triage)', () => {
  it('files into the open stream triage names instead of starting a new one, even when it judged "not work"', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const stream = (await repo.createStream({ title: 'Outage', summary: '' })).id;
    const { item } = await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g', title: 'More outage news', data: { messages: [{ id: '1', author: { name: 'ISP' }, text: 'restored', at: '2026-11-11T00:00:00Z' }] } });
    const d = { relevant: false, reason: 'FYI', stream: { action: 'existing', streamId: stream, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    const t = new TriagePipeline(repo, { structured: async () => d } as any, { run: async () => undefined } as any, async () => defaultSettings());
    const r = await t.retriage(item.id, true);
    expect(r.streamId).toBe(stream);
    expect(await repo.listStreams(false)).toHaveLength(1);
  });
  it('lists dismissed items only on request', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const { item } = await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g', title: 'FYI', data: { messages: [{ id: '1', author: { name: 'A' }, text: 'x', at: '2026-11-11T00:00:00Z' }] } });
    await repo.dismissSkipped(item.id);
    expect(await repo.listSkipped(14)).toEqual([]);
    expect((await repo.listSkipped(14, true)).map((x) => [x.id, x.dismissed])).toEqual([[item.id, true]]);
  });
});

describe('item tab dot from triage', () => {
  it('flags the tab when others add something to an item in a stream, not for the PU\'s own messages', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const streamId = (await repo.createStream({ title: 't', summary: '' })).id;
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g', title: 'Thread', data: { messages: [{ id: '1', author: { name: 'A' }, text: 'first', at: '2026-11-11T00:00:00Z' }] }, streamId });
    const d = { relevant: true, reason: 'follow-up', stream: { action: 'existing', streamId, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    const t = new TriagePipeline(repo, { structured: async () => d } as any, { run: async () => undefined } as any, async () => defaultSettings());
    const msg = (id: string, name: string, pu: boolean) => ({ id, author: { name }, text: id, at: `2026-11-11T00:00:${id.padStart(2, '0')}Z`, isFromPU: pu });
    const inbound = (messages: any[], eventId: string) => ({ source: 'gmail' as const, kind: 'email_thread' as const, externalId: 'g', title: 'Thread', eventId, data: { messages } });
    await t.handle(inbound([msg('1', 'A', false), msg('2', 'Me', true)], 'e1'));
    expect((await repo.findItem('gmail', 'g'))!.data.unread).toBeUndefined();
    await t.handle(inbound([msg('1', 'A', false), msg('2', 'Me', true), msg('3', 'B', false)], 'e2'));
    expect((await repo.findItem('gmail', 'g'))!.data.unread).toBe(true);
  });
});

describe('silenced work items', () => {
  const setup = async () => {
    const { bus } = await import('../src/core/bus.js');
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const streamId = (await repo.createStream({ title: 'Stream', summary: '' })).id;
    const first = { id: '1', author: { name: 'A' }, text: 'first', at: '2026-11-11T00:00:00Z' };
    const second = { id: '2', author: { name: 'B' }, text: 'second', at: '2026-11-11T01:00:00Z' };
    const { item } = await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g', title: 'Thread', data: { messages: [first] }, streamId });
    let calls = 0;
    const decision = { relevant: true, reason: 'worth a look', stream: { action: 'existing', streamId, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: 'New summary', notify: { title: 'Heads up', body: 'something happened' }, next: { type: 'none', instruction: '', offerLabel: null } };
    const t = new TriagePipeline(repo, { structured: async () => (calls++, decision) } as any, { run: async () => undefined } as any, async () => defaultSettings());
    const notes: any[] = [];
    const off = bus.subscribe((e: any) => e.type === 'notify' && notes.push(e));
    const arrive = (messages: any[], eventId: string) => t.handle({ source: 'gmail', kind: 'email_thread', externalId: 'g', title: 'Thread', eventId, data: { messages } });
    return { repo, streamId, item, t, notes, off, arrive, first, second, calls: () => calls };
  };

  it('keeps pulling updates in, but makes no noise, leaves the stream read and closed', async () => {
    const { repo, streamId, item, notes, off, arrive, first, second, calls } = await setup();
    await repo.setItemMuted(item.id, true);
    await repo.updateStream(streamId, { status: 'closed', unread: false });
    await arrive([first, second], 'e1');
    off();
    expect((await repo.findItem('gmail', 'g'))!.data.messages?.map((m) => m.id)).toEqual(['1', '2']); // still pulled in
    expect(notes).toEqual([]); // no notification
    expect(calls()).toBe(0); // and the agent isn't spent on it
    const stream = (await repo.getStream(streamId))!;
    expect(stream.unread).toBe(false); // not marked unread
    expect(stream.status).toBe('closed'); // not reopened
    expect((await repo.findItem('gmail', 'g'))!.data.unread).toBeUndefined(); // no dot on its tab
    expect((await repo.listChat(streamId)).filter((m) => /Heads up/.test(m.content))).toEqual([]);
  });
  it('un-silencing brings back normal handling', async () => {
    const { repo, streamId, item, notes, off, arrive, first, second, calls } = await setup();
    await repo.setItemMuted(item.id, true);
    await repo.setItemMuted(item.id, false);
    expect((await repo.findItem('gmail', 'g'))!.data.muted).toBeUndefined();
    await arrive([first, second], 'e2');
    off();
    expect(calls()).toBe(1);
    expect(notes).toHaveLength(1);
    expect((await repo.getStream(streamId))!.unread).toBe(true);
    expect((await repo.findItem('gmail', 'g'))!.data.unread).toBe(true);
  });
  it('silencing clears an existing dot and silenced items never raise one', async () => {
    const { repo, item, off } = await setup();
    off();
    await repo.markItemUnread(item.id);
    expect((await repo.getItem(item.id))!.data.unread).toBe(true);
    await repo.setItemMuted(item.id, true);
    expect((await repo.getItem(item.id))!.data.unread).toBeUndefined();
    await repo.markItemUnread(item.id);
    expect((await repo.getItem(item.id))!.data.unread).toBeUndefined();
  });
});

describe('silenced items: skip polling and mention override', () => {
  const PU = { name: 'Scott Feit', email: 'scott@bazaarvoice.com', aliases: ['sfeit'], slackUserId: 'UPU123' };
  const setup = async (silencing: { skipPolling: boolean; mentionsOverride: boolean }) => {
    const { bus } = await import('../src/core/bus.js');
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const streamId = (await repo.createStream({ title: 'Stream', summary: '' })).id;
    const msg = (id: string, text: string) => ({ id, author: { name: 'B' }, text, at: `2026-11-11T00:00:${id.padStart(2, '0')}Z` });
    const { item } = await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C1:1.1', title: 'Thread', data: { messages: [msg('1', 'first')] }, streamId });
    await repo.setItemMuted(item.id, true);
    let calls = 0;
    const decision = { relevant: true, reason: 'x', stream: { action: 'existing', streamId, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: { title: 'Heads up', body: 'b' }, next: { type: 'none', instruction: '', offerLabel: null } };
    const t = new TriagePipeline(repo, { structured: async () => (calls++, decision) } as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, ...PU }, silencing }));
    const notes: any[] = [];
    const off = bus.subscribe((e: any) => e.type === 'notify' && notes.push(e));
    const arrive = (texts: string[], eventId: string) => t.handle({ source: 'slack', kind: 'slack_thread', externalId: 'C1:1.1', title: 'Thread', eventId, data: { messages: [msg('1', 'first'), ...texts.map((x, i) => msg(String(i + 2), x))] } });
    const ids = async () => (await repo.findItem('slack', 'C1:1.1'))!.data.messages?.map((m) => m.id);
    return { repo, streamId, arrive, notes, off, calls: () => calls, ids };
  };

  it('referencesPU: slack mention, full name, alias, email — not a first name', async () => {
    const { referencesPU } = await import('../src/core/mentions.js');
    const m = (text: string) => [{ id: '1', author: {}, text, at: '' }];
    expect(referencesPU(m('hey <@UPU123> can you look'), PU)).toBe(true);
    expect(referencesPU(m('CC: @Scott Feit'), PU)).toBe(true);
    expect(referencesPU(m('thanks scott feit!'), PU)).toBe(true);
    expect(referencesPU(m('ping sfeit please'), PU)).toBe(true);
    expect(referencesPU(m('write to Scott@Bazaarvoice.com'), PU)).toBe(true);
    expect(referencesPU(m('Scott mentioned it'), PU)).toBe(false);
    expect(referencesPU(m('<@UOTHER> look'), PU)).toBe(false);
    expect(referencesPU(m('Scottish things, sfeitzer'), PU)).toBe(false);
  });
  it("with 'don't poll silenced items', nothing is stored or judged until it is un-silenced", async () => {
    const { repo, arrive, off, calls, ids } = await setup({ skipPolling: true, mentionsOverride: true });
    await arrive(['new reply mentioning <@UPU123>'], 'e1');
    off();
    expect(await ids()).toEqual(['1']); // not even stored, and the override can't apply
    expect(calls()).toBe(0);
    expect(await repo.listUnprocessedInbound(0)).toEqual([]);
    const it = (await repo.findItem('slack', 'C1:1.1'))!;
    await repo.setItemMuted(it.id, false);
    await arrive(['new reply mentioning <@UPU123>'], 'e2');
    expect(await ids()).toEqual(['1', '2']); // catches up once un-silenced
  });
  it('with the override on, a message that refers to the PU breaks through; others stay silent', async () => {
    const { repo, streamId, arrive, notes, off, calls, ids } = await setup({ skipPolling: false, mentionsOverride: true });
    await repo.updateStream(streamId, { unread: false });
    await arrive(['just chatter'], 'e1');
    expect(await ids()).toEqual(['1', '2']); // still pulled in
    expect(calls()).toBe(0);
    expect(notes).toEqual([]);
    expect((await repo.getStream(streamId))!.unread).toBe(false);
    await arrive(['just chatter', 'hey <@UPU123> your call'], 'e2');
    off();
    expect(calls()).toBe(1);
    expect(notes).toHaveLength(1);
    expect((await repo.getStream(streamId))!.unread).toBe(true);
    expect((await repo.findItem('slack', 'C1:1.1'))!.data.unread).toBe(true); // its tab gets a dot even though it is silenced
    expect((await repo.findItem('slack', 'C1:1.1'))!.data.muted).toBe(true); // and it stays silenced
  });
  it('without the override, even a direct mention stays quiet', async () => {
    const { arrive, notes, off, calls } = await setup({ skipPolling: false, mentionsOverride: false });
    await arrive(['hey <@UPU123> your call'], 'e1');
    off();
    expect(calls()).toBe(0);
    expect(notes).toEqual([]);
  });
  it('threads read by the poll skip silenced ones when asked', async () => {
    const { planTrackedSlackReads } = await import('../src/agent/mcpIngest.js');
    const mk = (externalId: string, muted: boolean): any => ({ id: externalId, streamId: 's', source: 'slack', kind: 'slack_thread', externalId, title: '', data: { messages: [], muted: muted || undefined }, updatedAt: '2026-11-12T00:00:00Z' });
    const items = [mk('C1:1.1', true), mk('C1:2.2', false), mk('D9:3.3', true)];
    expect(planTrackedSlackReads(items).threads.map((t) => t.ts).sort()).toEqual(['1.1', '2.2']);
    const skip = planTrackedSlackReads(items, { skipMuted: true });
    expect(skip.threads.map((t) => t.ts)).toEqual(['2.2']);
    expect(skip.conversations).toEqual([]); // the silenced DM isn't read either
  });
});
