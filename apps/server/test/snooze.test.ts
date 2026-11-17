import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { surfaceSnoozed } from '../src/core/reminders.js';
import { localNow, parseTime, zonedToUtc } from '../src/core/parseTime.js';

describe('snoozing a work stream until a date', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('stays in Pending until its time, then comes back unread and marked Back; the N-day reminder leaves it alone', async () => {
    const s = await repo.createStream({ title: 'Budget', summary: '' });
    await repo.updateStream(s.id, { unread: false });
    const until = new Date(Date.now() + 3600_000).toISOString();
    await repo.updateStream(s.id, { pending: true, snoozeUntil: until }, 'you');
    expect(await repo.getStream(s.id)).toMatchObject({ pending: true, snoozeUntil: until });
    expect(await repo.pendingStreamsDue(1, Date.now() + 30 * 86_400_000)).toEqual([]);
    expect(await surfaceSnoozed({ repo })).toEqual([]);
    expect(await surfaceSnoozed({ repo }, Date.now() + 2 * 3600_000)).toEqual([s.id]);
    const back = (await repo.getStream(s.id))!;
    expect(back).toMatchObject({ pending: false, snoozeUntil: null, unread: true });
    expect(back.backAt).toBeTruthy();
    // snoozing again (or new activity) answers the Back
    await repo.updateStream(s.id, { pending: true }, 'you');
    expect(await repo.getStream(s.id)).toMatchObject({ backAt: null, snoozeUntil: null, pending: true });
  });

  it('someone writing ends the snooze early; closing clears it', async () => {
    const s = await repo.createStream({ title: 'X', summary: '' });
    await repo.updateStream(s.id, { pending: true, snoozeUntil: new Date(Date.now() + 86_400_000).toISOString() }, 'you');
    await repo.updateStream(s.id, { touch: true, pending: false });
    expect(await repo.getStream(s.id)).toMatchObject({ pending: false, snoozeUntil: null });
    await repo.updateStream(s.id, { pending: true, snoozeUntil: new Date(Date.now() + 86_400_000).toISOString() }, 'you');
    await repo.updateStream(s.id, { status: 'closed' }, 'you');
    expect(await repo.getStream(s.id)).toMatchObject({ snoozeUntil: null, pending: false });
  });
});

describe('reading a typed time', () => {
  it('local time in a zone, across a daylight-saving change', () => {
    expect(zonedToUtc('2026-11-20T14:00', 'America/New_York')!.toISOString()).toBe('2026-11-20T19:00:00.000Z');
    expect(zonedToUtc('2026-07-20T14:00', 'America/New_York')!.toISOString()).toBe('2026-07-20T18:00:00.000Z');
    expect(localNow(new Date('2026-11-16T23:30:00Z'), 'America/Los_Angeles')).toBe('Monday 2026-11-16 15:30');
  });

  it('asks the cheap model with the local "now", and refuses past or missing times', async () => {
    const seen: { prompt: string; kind: string }[] = [];
    const backend = (local: string | null) => ({ structured: async (i: any) => (seen.push({ prompt: i.prompt, kind: i.usage.kind }), { local, note: null }) });
    const now = Date.parse('2026-11-16T17:00:00Z');
    expect(await parseTime(backend('2026-11-26T14:00') as any, 'the Thursday after next, 2pm', 'America/New_York', now)).toEqual({ at: '2026-11-26T19:00:00.000Z', note: null });
    expect(seen[0]).toMatchObject({ kind: 'dateParse' });
    expect(seen[0].prompt).toContain('Now: Monday 2026-11-16 12:00 (America/New_York)');
    expect((await parseTime(backend('2026-11-01T09:00') as any, 'last week', 'America/New_York', now)).at).toBeNull();
    expect((await parseTime(backend(null) as any, 'whenever', 'Not/AZone', now)).at).toBeNull();
  });
});
