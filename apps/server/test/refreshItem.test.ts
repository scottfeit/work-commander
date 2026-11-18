import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { refreshItem } from '../src/core/refreshItem.js';

const msg = (id: string, text: string) => ({ id, author: { name: 'Dana', email: 'dana@x.com' }, text, at: new Date().toISOString() });

describe('refreshing a work item on demand', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });
  const hub = (mode: string, apis: Record<string, unknown>) => ({ systemMode: async () => mode, api: async (k: string) => apis[k] }) as any;

  it('Gmail: re-reads the thread and stores the new message, with no triage (no inbound event)', async () => {
    const s = await repo.createStream({ title: 'S', summary: '' });
    const it = (await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'T', streamId: s.id, data: { messages: [msg('m1', 'one')], gmail: { threadId: 't1' } } })).item;
    const email = { getThread: async (id: string) => ({ source: 'gmail', kind: 'email_thread', externalId: id, title: 'T', eventId: 'm2', data: { messages: [msg('m1', 'one'), msg('m2', 'two')], gmail: { threadId: id } } }) };
    const got = await refreshItem({ repo, hub: hub('api', { email }) }, it);
    expect(got.data.messages!.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(got.streamId).toBe(s.id);
    expect(await repo.listUnprocessedInbound(-60_000, 10)).toEqual([]);
    expect((await repo.db.selectFrom('inbound_events').selectAll().execute()).length).toBe(0);
  });

  it('Jira: re-reads the issue by key', async () => {
    const it = (await repo.upsertItem({ source: 'jira', kind: 'ticket', externalId: 'OPS-1', title: 'OPS-1', data: { ticket: { key: 'OPS-1', summary: 's', status: 'Open', flavor: 'jira', comments: [] } } })).item;
    let asked = '';
    const tickets = { getIssue: async (k: string) => ((asked = k), { source: 'jira', kind: 'ticket', externalId: k, title: k, eventId: 'e', data: { ticket: { key: k, summary: 's', status: 'Done', flavor: 'jira', comments: [] } } }) };
    const got = await refreshItem({ repo, hub: hub('api', { tickets }) }, it);
    expect(asked).toBe('OPS-1');
    expect(got.data.ticket!.status).toBe('Done');
  });

  it('says why when it cannot: MCP-connected systems, and kinds without a source to read', async () => {
    const it = (await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't9', title: 'T', data: { messages: [] } })).item;
    await expect(refreshItem({ repo, hub: hub('mcp', {}) }, it)).rejects.toThrow(/MCP/);
    const cal = (await repo.upsertItem({ source: 'calendar', kind: 'event', externalId: 'e1', title: 'M', data: {} })).item;
    await expect(refreshItem({ repo, hub: hub('api', {}) }, cal)).rejects.toThrow(/can't be refreshed/);
  });
});
