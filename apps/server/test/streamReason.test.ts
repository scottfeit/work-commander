import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';

const msg = (id: string, name: string, at: string, isFromPU = false) => ({ id, author: { name }, text: 'x', at, isFromPU });

describe("why a work stream is in front of you", () => {
  it('names the most pressing reason', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const s = await repo.createStream({ title: 'T', summary: '' });
    const reason = async () => (await repo.getStream(s.id))!.reason;
    expect(await reason()).toBe('New work stream');
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C1:1', title: 't', streamId: s.id, data: { messages: [msg('1', 'Priya Shah', '2026-11-19T10:00:00Z')] } } as any);
    expect(await reason()).toBe('New message from Priya Shah on Slack');
    await repo.createProposal({ streamId: s.id, runId: 'r', kind: 'email_send', system: 'google', title: 'd', rationale: '', payload: {}, editable: [] });
    expect(await reason()).toBe('1 draft to review');
    await repo.addChat({ streamId: s.id, role: 'question', content: 'Which project?', meta: { question: {} } });
    expect(await reason()).toBe('Claude has a question for you');
    await repo.db.updateTable('streams').set({ reopened_at: new Date().toISOString() }).where('id', '=', s.id).execute();
    expect(await reason()).toBe('Reopened: new message from Priya Shah on Slack');
  });

  it('nothing notable: no reason; your own last message is not "new"', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const s = await repo.createStream({ title: 'T', summary: '' });
    await repo.db.updateTable('streams').set({ unread: 0 }).where('id', '=', s.id).execute();
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g1', title: 't', streamId: s.id, data: { messages: [msg('1', 'Me', '2026-11-19T10:00:00Z', true)] } } as any);
    expect((await repo.getStream(s.id))!.reason).toBeNull();
  });
});
