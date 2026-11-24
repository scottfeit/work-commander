import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { TimerService } from '../src/core/timers.js';
import { buildTools, timerAskedFor } from '../src/agent/tools.js';
import { defaultSettings } from '../src/core/settings.js';

const local = (ms: number) => new Date(ms).toISOString().slice(0, 16);

async function setup(result: { ok: boolean; error?: string } = { ok: true }) {
  const repo = new Repo((await openDatabase('sqlite::memory:')).db);
  const st = await repo.createStream({ title: 'T', summary: '' });
  const runs: any[] = [];
  const at = Date.now() + 30 * 60_000;
  const backend = { structured: async () => ({ local: local(at), note: null }) } as any;
  const svc = new TimerService({ repo, backend, run: async (r) => (runs.push(r), result), tz: () => 'UTC' });
  return { repo, st, runs, svc };
}

describe('timers need the PU', () => {
  it('only a PU message that asks for something later counts as asking', () => {
    for (const m of ['in 30 minutes, check for tickets on this', 'remind me at 3pm', 'tomorrow morning see if Lee replied', 'check again on Friday', 'ping me at 4:30', 'set a timer for an hour']) expect(timerAskedFor(m), m).toBe(true);
    for (const m of ['check the ticket status', 'draft a reply to Priya', 'what did Lee say?', undefined]) expect(timerAskedFor(m as any), String(m)).toBe(false);
  });

  it('set_timer without the PU asking only suggests: nothing counts down until Set timer', async () => {
    const { repo, st, runs, svc } = await setup();
    const tools = await buildTools({ streamId: st.id, runId: 'r1' }, { repo, hub: { systemMode: async () => 'api', api: async () => ({}) } as any, grants: {} as any, executor: {} as any, settings: async () => defaultSettings(), setTimer: (s: string, w: string, i: string, r?: string, suggest?: boolean) => svc.create(s, w, i, r, suggest) } as any);
    const out = await tools.find((t) => t.name === 'set_timer')!.handler({ when: 'in 30 minutes', instruction: 'check the ticket again' });
    expect(out).toMatch(/Not set/);
    const t = (await repo.listChat(st.id)).find((m) => m.meta.timer)!.meta.timer!;
    expect(t.status).toBe('suggested');
    expect((await repo.getStream(st.id))!.timers).toEqual([]); // no chip
    await svc.tick(Date.parse(t.at) + 30_000);
    expect(runs).toHaveLength(0); // never runs unapproved
    expect(await svc.approve(t.id, Date.parse(t.at) - 60_000)).toBe(true);
    expect((await repo.getStream(st.id))!.timers).toEqual([expect.objectContaining({ id: t.id, status: 'waiting' })]);
  });

  it('asked for in the chat: set right away', async () => {
    const { repo, st, svc } = await setup();
    const tools = await buildTools({ streamId: st.id, runId: 'r1', puMessage: 'in 30 minutes, check for tickets on this topic' }, { repo, hub: { systemMode: async () => 'api', api: async () => ({}) } as any, grants: {} as any, executor: {} as any, settings: async () => defaultSettings(), setTimer: (s: string, w: string, i: string, r?: string, suggest?: boolean) => svc.create(s, w, i, r, suggest) } as any);
    expect(await tools.find((t) => t.name === 'set_timer')!.handler({ when: 'in 30 minutes', instruction: 'check for tickets' })).toMatch(/Timer set/);
    expect((await repo.getStream(st.id))!.timers).toEqual([expect.objectContaining({ status: 'waiting' })]);
  });

  it('No thanks: never set; a suggestion whose time has gone cannot be approved', async () => {
    const { repo, st, svc } = await setup();
    const a = await svc.create(st.id, 'in 30 minutes', 'x', undefined, true);
    expect(await svc.cancel(a.id)).toBe(true);
    expect((await repo.listChat(st.id)).find((m) => m.meta.timer?.id === a.id)!.meta.timer!.status).toBe('cancelled');
    const b = await svc.create(st.id, 'in 30 minutes', 'y', undefined, true);
    await expect(svc.approve(b.id, Date.parse(b.at) + 1000)).rejects.toThrow(/already passed/);
  });
});

describe('timer complete chip', () => {
  it('done: a green chip until the stream is opened', async () => {
    const { repo, st, svc } = await setup();
    const t = await svc.create(st.id, 'in 30 minutes', 'check for tickets');
    await svc.tick(Date.parse(t.at) + 30_000);
    await expect.poll(async () => (await repo.getStream(st.id))!.timerDone).toMatchObject({ instruction: 'check for tickets', ok: true });
    await repo.clearTimerDone(st.id);
    expect((await repo.getStream(st.id))!.timerDone).toBeNull();
  });

  it('a run that fails: marked failed (red chip)', async () => {
    const { repo, st, svc } = await setup({ ok: false, error: 'boom' });
    const t = await svc.create(st.id, 'in 30 minutes', 'check for tickets');
    await svc.tick(Date.parse(t.at) + 30_000);
    await expect.poll(async () => (await repo.getStream(st.id))!.timerDone?.ok).toBe(false);
    expect((await repo.listChat(st.id)).find((m) => m.meta.timer)!.meta.timer!.status).toBe('failed');
  });
});
