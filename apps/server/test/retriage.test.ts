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
  const item = (messages: any[]) => repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Development Idea', data: { messages } });
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
