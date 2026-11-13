import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';

const msg = (id: string, text: string, at: string, pu = false) => ({ id, author: { name: pu ? 'Me' : 'Anne' }, text, at, isFromPU: pu });

describe('a group DM message arriving in message form', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('lands in the group DM item, even when its work stream is closed', async () => {
    const streamId = (await repo.createStream({ title: 'Approvers', summary: '' })).id;
    const { item } = await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0GROUP1:dm', title: 'Group DM', data: { messages: [msg('1.1', 'first', '2026-11-12T10:00:00Z')] }, streamId });
    await repo.updateStream(streamId, { status: 'closed' });
    const r = await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0GROUP1:2.2', title: 'Group DM: Anne on Lance', data: { messages: [msg('2.2', 'second', '2026-11-12T11:00:00Z')] } });
    expect(r.item.id).toBe(item.id);
    expect(r.item.streamId).toBe(streamId);
    expect(r.item.data.messages!.map((m) => m.id)).toEqual(['1.1', '2.2']);
    expect((await repo.db.selectFrom('items').select('id').execute()).length).toBe(1);
  });
  it('a thread in an ordinary channel stays its own item', async () => {
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0GROUP1:dm', title: 'Group DM', data: { messages: [msg('1.1', 'a', '2026-11-12T10:00:00Z')] } });
    const other = await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0OTHER99:2.2', title: '#chan', data: { messages: [msg('2.2', 'b', '2026-11-12T11:00:00Z')] } });
    expect(other.created).toBe(true);
    expect((await repo.db.selectFrom('items').select('id').execute()).length).toBe(2);
  });
});

describe('triage of activity on a conversation whose stream is closed', () => {
  const run = async (relevant: boolean) => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const streamId = (await repo.createStream({ title: 'Jira automation failed', summary: 'Waiting on who approves MS licenses.' })).id;
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0GROUP1:dm', title: 'Group DM', data: { messages: [msg('1.1', 'who approves?', '2026-11-12T10:00:00Z')] }, streamId });
    await repo.updateStream(streamId, { status: 'closed' });
    let prompt = '';
    const decision = { relevant, reason: 'x', stream: { action: 'existing', streamId, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    const t = new TriagePipeline(repo, { structured: async (a: any) => ((prompt = a.prompt), decision) } as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, name: 'Scott Feit', email: 's@x.com' } }));
    // the message arrives in the message form that used to miss the conversation
    await t.handle({ source: 'slack', kind: 'slack_thread', externalId: 'C0GROUP1:2.2', title: 'Group DM: Anne', eventId: 'e1', data: { messages: [msg('2.2', 'Lance is now sole approver, ok?', new Date().toISOString())] } });
    return { repo, streamId, prompt };
  };

  it('tells the model the stream is closed and what it was about, and a relevant verdict reopens it', async () => {
    const { repo, streamId, prompt } = await run(true);
    expect(prompt).toContain('CLOSED');
    expect(prompt).toContain('Jira automation failed');
    expect(prompt).toContain('Waiting on who approves MS licenses');
    expect((await repo.getStream(streamId))!.status).toBe('open');
    expect((await repo.db.selectFrom('items').select('id').execute()).length).toBe(1); // no stray second item
  });
  it('a not-relevant verdict leaves the stream closed, and still no stray item', async () => {
    const { repo, streamId } = await run(false);
    expect((await repo.getStream(streamId))!.status).toBe('closed');
    expect((await repo.db.selectFrom('items').select('id').execute()).length).toBe(1);
  });
});
