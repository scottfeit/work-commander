import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';

const mail = (id: string, subject: string, text: string, from = 'camille@x.com') => ({
  source: 'gmail' as const,
  kind: 'email_thread' as const,
  externalId: id,
  title: subject,
  eventId: `${id}@1`,
  data: { messages: [{ id: `${id}-1`, author: { name: 'Camille', email: from }, text, at: new Date().toISOString() }] },
});

describe('a follow-up to work that closed recently', () => {
  let repo: Repo;
  let closedId: string;
  let prompts: string[];
  let reply: (streamIdSeen: string) => any;
  let t: TriagePipeline;
  const decision = (streamId: string | null, relevant = true) => ({
    relevant,
    reason: 'r',
    stream: streamId ? { action: 'existing', streamId, title: null, summary: null, labels: null } : { action: 'new', streamId: null, title: 'New stream', summary: 's', labels: null },
    relatedItemIds: null,
    updatedSummary: null,
    notify: null,
    next: { type: 'none', instruction: '', offerLabel: null },
  });
  const closeStream = async (id: string, daysAgo: number) => {
    await repo.updateStream(id, { status: 'closed' });
    await repo.db.updateTable('streams').set({ closed_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() }).where('id', '=', id).execute();
  };
  const streams = async () => repo.listStreams(true);

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    prompts = [];
    reply = () => decision(null);
    t = new TriagePipeline(repo, { structured: async (a: any) => (prompts.push(a.prompt), reply(a.prompt)) } as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, name: 'Scott', email: 's@x.com' } }));
    closedId = (await repo.createStream({ title: 'IT-75653 phone lines not working', summary: 'Teams voice licenses revoked' })).id;
    await repo.upsertItem({ source: 'jsm', kind: 'ticket', externalId: 'IT-75653', title: 'IT-75653: phone lines no longer works', data: { ticket: { key: 'IT-75653', flavor: 'jsm', status: 'Closed', summary: 's', comments: [] } }, streamId: closedId } as any);
    await closeStream(closedId, 0);
  });

  it('an email about the same ticket joins the closed stream, and it reopens when the activity needs the PU', async () => {
    reply = () => decision(closedId, true);
    await t.handle(mail('t1', '[JIRA] (IT-75653) phone lines no longer works', 'Please do not close IT-75653 yet. What was the root cause?'));
    expect((await streams()).map((s) => s.title)).toEqual(['IT-75653 phone lines not working']); // no second stream
    expect((await repo.getStream(closedId))!.status).toBe('open');
    expect((await repo.listItems(closedId)).map((i) => i.externalId).sort()).toEqual(['IT-75653', 't1']);
  });

  it('...and stays closed when the activity needs nothing', async () => {
    reply = () => decision(closedId, false);
    await t.handle(mail('t2', '[JIRA] (IT-75653) update', 'FYI the ticket was closed.'));
    expect((await repo.getStream(closedId))!.status).toBe('closed');
    expect((await repo.listItems(closedId)).map((i) => i.externalId)).toContain('t2');
    expect((await streams())).toHaveLength(1);
  });

  it('with no ticket key to go by, the model is told about the closed stream and may file the item there (reopening it)', async () => {
    reply = () => decision(closedId, true);
    await t.handle(mail('t3', 'Phone outage follow-up', 'Can we talk about the French lines? Not closed yet.'));
    expect(prompts[0]).toContain('Recently closed work streams');
    expect(prompts[0]).toContain(`[${closedId}] IT-75653 phone lines not working`);
    expect((await repo.getStream(closedId))!.status).toBe('open');
    expect(await streams()).toHaveLength(1);
  });

  it('a stream closed longer ago than the reopen window is not offered, and does not capture a ticket-key mention', async () => {
    await closeStream(closedId, 30);
    reply = () => decision(null, true);
    await t.handle(mail('t4', '[JIRA] (IT-75653) follow-up', 'Another question about IT-75653.'));
    expect(prompts[0]).not.toContain('Recently closed work streams');
    expect(await streams()).toHaveLength(2); // a new stream
    expect((await repo.getStream(closedId))!.status).toBe('closed');
  });

  it('two recently closed streams that both track the ticket are ambiguous: left to the model', async () => {
    const other = (await repo.createStream({ title: 'IT-75653 licence renewal', summary: 'Renew' })).id;
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'old', title: 'About IT-75653', data: { messages: [{ id: 'o1', author: { name: 'x' }, text: 'IT-75653 renewal', at: new Date().toISOString() }] }, streamId: other });
    await closeStream(other, 1);
    reply = () => decision(null, true);
    await t.handle(mail('t5', '[JIRA] (IT-75653) again', 'IT-75653 question'));
    const att = await repo.findItem('gmail', 't5');
    expect(att!.streamId).not.toBe(closedId);
    expect(att!.streamId).not.toBe(other);
  });
});
