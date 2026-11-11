import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';

const decision = { relevant: true, reason: 'Chris follows up', stream: { action: 'existing', streamId: null, title: null, summary: null, labels: null }, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
const backend = { structured: async () => decision } as any;
const runner = { run: async () => undefined } as any;

describe('new activity on a closed stream', () => {
  let repo: Repo;
  let db: any;
  let n = 0;
  const msg = (text: string) => ({ id: `m${++n}`, author: { name: 'Chris', email: 'chris@x.com' }, text, at: new Date().toISOString(), isFromPU: false });
  const inbound = (text: string) => ({ source: 'gmail' as const, kind: 'email_thread' as const, externalId: 'thread-1', title: 'Need help with IRS audit', data: { messages: [msg(text)] }, eventId: `e${n + 1}` });
  const triage = (days: number) => new TriagePipeline(repo, backend, runner, async () => ({ ...defaultSettings(), claude: { ...defaultSettings().claude, reopenClosedWithinDays: days } }));

  beforeEach(async () => {
    ({ db } = await openDatabase('sqlite::memory:'));
    repo = new Repo(db);
  });

  /** Thread in a stream that was closed `daysAgo` days ago. */
  const closedStream = async (daysAgo: number) => {
    const st = await repo.createStream({ title: 'IRS audit request', summary: 's' });
    const { item } = await repo.upsertItem({ ...inbound('first'), streamId: st.id });
    await repo.updateStream(st.id, { status: 'closed' });
    await db.updateTable('streams').set({ closed_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() }).where('id', '=', st.id).execute();
    return { st, item };
  };

  it('reopens it when it closed within the window', async () => {
    const { st, item } = await closedStream(3);
    await triage(14).handle({ ...inbound('any update?') });
    expect((await repo.getStream(st.id))!.status).toBe('open');
    expect((await repo.getItem(item.id))!.streamId).toBe(st.id);
  });

  it('starts a new stream (and moves the thread) when it closed longer ago', async () => {
    const { st, item } = await closedStream(20);
    await triage(14).handle({ ...inbound('new request') });
    expect((await repo.getStream(st.id))!.status).toBe('closed');
    const moved = (await repo.getItem(item.id))!.streamId!;
    expect(moved).not.toBe(st.id);
    const fresh = (await repo.getStream(moved))!;
    expect(fresh.status).toBe('open');
    expect(fresh.summary).toContain('Follow-up to "IRS audit request"');
  });

  it('respects a custom window', async () => {
    const { st } = await closedStream(20);
    await triage(30).handle({ ...inbound('still relevant') });
    expect((await repo.getStream(st.id))!.status).toBe('open');
  });
});
