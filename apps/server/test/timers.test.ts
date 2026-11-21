import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { TimerService } from '../src/core/timers.js';

const local = (ms: number) => new Date(ms).toISOString().slice(0, 16); // UTC "YYYY-MM-DDTHH:mm"

async function setup() {
  const repo = new Repo((await openDatabase('sqlite::memory:')).db);
  const st = await repo.createStream({ title: 'T', summary: '' });
  const runs: any[] = [];
  let at = Date.now() + 30 * 60_000;
  const backend = { structured: async () => ({ local: local(at), note: null }) } as any;
  const svc = new TimerService({ repo, backend, run: async (r) => void runs.push(r), tz: () => 'UTC' });
  return { repo, st, runs, svc, setAt: (ms: number) => (at = ms) };
}

describe('timed instructions', () => {
  it('set: shows in the chat and on the stream; runs on time as the PU, then the stream is Open and unread', async () => {
    const { repo, st, runs, svc } = await setup();
    const t = await svc.create(st.id, 'in 30 minutes', 'check for tickets on this topic');
    expect((await repo.listChat(st.id)).find((m) => m.meta.timer)?.meta.timer).toMatchObject({ instruction: 'check for tickets on this topic', status: 'waiting' });
    expect((await repo.getStream(st.id))!.timers).toEqual([expect.objectContaining({ id: t.id, status: 'waiting' })]);
    await repo.updateStream(st.id, { status: 'closed' });
    await svc.tick(Date.now()); // not yet
    expect(runs).toHaveLength(0);
    await svc.tick(Date.parse(t.at) + 30_000);
    await expect.poll(async () => (await repo.getStream(st.id))!.status).toBe('open');
    expect(runs[0]).toMatchObject({ streamId: st.id, origin: 'user', allowDrafts: true, prompt: expect.stringContaining('check for tickets on this topic') });
    const s = (await repo.getStream(st.id))!;
    expect(s).toMatchObject({ unread: true, pending: false, timers: [] });
    expect((await repo.listChat(st.id)).find((m) => m.meta.timer)?.meta.timer?.status).toBe('done');
  });

  it('missed while WC was off: waits with Run now / Cancel (stream back in Open, unread); Run now runs it', async () => {
    const { repo, st, runs, svc } = await setup();
    const t = await svc.create(st.id, 'in 30 minutes', 'see if Lee replied');
    await repo.updateStream(st.id, { pending: true });
    await svc.tick(Date.parse(t.at) + 2 * 3600_000);
    expect(runs).toHaveLength(0);
    expect((await repo.getStream(st.id))!).toMatchObject({ status: 'open', pending: false, unread: true, timers: [expect.objectContaining({ status: 'missed' })] });
    expect(await svc.runNow(t.id)).toBe(true);
    await expect.poll(() => runs.length).toBe(1);
    expect(runs[0].prompt).toMatch(/ran late/);
  });

  it('cancel: it never runs', async () => {
    const { repo, st, runs, svc } = await setup();
    const t = await svc.create(st.id, 'in 30 minutes', 'x');
    expect(await svc.cancel(t.id)).toBe(true);
    await svc.tick(Date.parse(t.at) + 30_000);
    expect(runs).toHaveLength(0);
    expect((await repo.getStream(st.id))!.timers).toEqual([]);
    expect((await repo.listChat(st.id)).find((m) => m.meta.timer)?.meta.timer?.status).toBe('cancelled');
  });

  it('a time in the past or no time at all is refused', async () => {
    const { st, svc, setAt } = await setup();
    setAt(Date.now() - 3600_000);
    await expect(svc.create(st.id, 'an hour ago', 'x')).rejects.toThrow(/passed/);
  });
});
