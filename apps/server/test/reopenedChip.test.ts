import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';

const msg = (id: string, pu = false) => ({ id, author: pu ? { name: 'Me', email: 'me@x.com' } : { name: 'Dana', email: 'dana@x.com' }, text: pu ? 'on it' : 'any update?', at: new Date(Date.now() + Number(id.slice(1)) * 1000).toISOString(), isFromPU: pu });

describe('the "Reopened" marker', () => {
  it('set when new activity reopens a closed stream; cleared by your reply, Pending, or closing again; not by a manual reopen', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const s = defaultSettings();
    s.pu = { ...s.pu, name: 'Me', email: 'me@x.com' };
    const st = await repo.createStream({ title: 'Budget', summary: '' });
    const answer = { relevant: true, reason: 'r', stream: { action: 'existing', streamId: st.id, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null }, deadline: null };
    const triage = new TriagePipeline(repo, { structured: async () => answer } as any, { run: async () => undefined } as any, async () => s);
    const mail = (ids: string[], ev: string) => triage.handle({ source: 'gmail', kind: 'email_thread', externalId: 't', title: 'T', eventId: ev, data: { messages: ids.map((i) => msg(i, i.startsWith('p'))) } });
    await mail(['m1'], 'e1');
    expect((await repo.getStream(st.id))!.reopenedAt).toBeNull();

    await repo.updateStream(st.id, { status: 'closed' }, 'you');
    await mail(['m1', 'm2'], 'e2');
    const r = (await repo.getStream(st.id))!;
    expect(r.status).toBe('open');
    expect(r.reopenedAt).toBeTruthy();

    await mail(['m1', 'm2', 'p3'], 'e3'); // you replied
    expect((await repo.getStream(st.id))!.reopenedAt).toBeNull();

    await repo.updateStream(st.id, { reopened: true });
    await repo.updateStream(st.id, { pending: true }, 'you');
    expect((await repo.getStream(st.id))!.reopenedAt).toBeNull();
    await repo.updateStream(st.id, { reopened: true });
    await repo.updateStream(st.id, { status: 'closed' }, 'you');
    expect((await repo.getStream(st.id))!.reopenedAt).toBeNull();
    await repo.updateStream(st.id, { status: 'open' }, 'you'); // your own Reopen
    expect((await repo.getStream(st.id))!.reopenedAt).toBeNull();
  });
});
