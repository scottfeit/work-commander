import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { MeetingWatcher, candidates, type Meeting } from '../src/core/meetings.js';
import type { Settings } from '@wc/shared';

const H = 3600_000;
const T0 = Date.parse('2026-11-16T15:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('calendar meetings', () => {
  let repo: Repo;
  let s: Settings;
  let events: Meeting[];
  let runs: { streamId: string; prompt: string; purpose?: string }[];
  let linkCalls: number;
  let pick: string | null;
  let w: MeetingWatcher;
  let budget: string;

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    s = defaultSettings();
    s.pu = { ...s.pu, name: 'Scott', email: 'scott@x.com' };
    events = [];
    runs = [];
    linkCalls = 0;
    budget = (await repo.createStream({ title: 'Q3 budget review', summary: 'Dana needs revised budget numbers' })).id;
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'b1', title: 'Budget', streamId: budget, data: { messages: [{ id: 'm1', author: { name: 'Dana', email: 'dana@x.com' }, to: ['scott@x.com'], text: 'numbers?', at: iso(T0 - 48 * H) }] } });
    pick = budget;
    w = new MeetingWatcher({
      repo,
      backend: { structured: async () => (linkCalls++, { streamId: pick, reason: 'r' }) } as any,
      settings: async () => s,
      calendar: async () => ({ list: async () => events }),
      run: (r) => void runs.push(r),
    });
  });

  const ev = (id: string, title: string, attendees: string[], start: number, mins = 30): Meeting => ({ id, title, start: iso(start), end: iso(start + mins * 60_000), attendees, url: `https://cal/${id}` });

  it('a meeting sharing people with a stream is checked once by the cheap model and linked as a tab; others cost nothing', async () => {
    events = [ev('e1', 'Budget sync', ['scott@x.com', 'dana@x.com'], T0 + 3 * H), ev('e2', 'Lunch', ['scott@x.com', 'pat@x.com'], T0 + 2 * H), ev('e3', 'Focus time', ['scott@x.com'], T0 + H)];
    await w.check(T0);
    expect(linkCalls).toBe(1);
    const item = (await repo.findItem('calendar', 'e1'))!;
    expect(item).toMatchObject({ streamId: budget, kind: 'event', title: 'Budget sync' });
    expect(item.data.meeting!.attendees).toEqual(['scott@x.com', 'dana@x.com']);
    await w.check(T0 + 60_000);
    expect(linkCalls).toBe(1); // not asked again
    expect(await repo.findItem('calendar', 'e2')).toBeNull();
  });

  it('the model can say no: then it is not linked and not asked again', async () => {
    pick = null;
    events = [ev('e1', 'Budget sync', ['scott@x.com', 'dana@x.com'], T0 + 3 * H)];
    await w.check(T0);
    await w.check(T0 + 60_000);
    expect(linkCalls).toBe(1);
    expect(await repo.findItem('calendar', 'e1')).toBeNull();
  });

  it('brief 30 minutes before (once), then a follow-up offer after it ends (once)', async () => {
    events = [ev('e1', 'Budget sync', ['scott@x.com', 'dana@x.com'], T0 + H)];
    await w.check(T0);
    expect(runs).toEqual([]);
    await w.check(T0 + 35 * 60_000);
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ streamId: budget, purpose: 'review' });
    expect(runs[0].prompt).toContain('[Meeting coming up] "Budget sync"');
    await w.check(T0 + 40 * 60_000);
    expect(runs.length).toBe(1);
    await w.check(T0 + 95 * 60_000);
    const chat = await repo.listChat(budget);
    const offer = chat.find((c) => c.role === 'suggestion')!;
    expect(offer.content).toContain('"Budget sync" just ended');
    expect((offer.meta as any).suggestion.instruction).toContain('Draft a short follow-up email from the PU to dana@x.com');
    await w.check(T0 + 100 * 60_000);
    expect((await repo.listChat(budget)).filter((c) => c.role === 'suggestion').length).toBe(1);
    expect((await repo.findItem('calendar', 'e1'))!.data.meeting).toMatchObject({ briefedAt: iso(T0 + 35 * 60_000), followedUpAt: iso(T0 + 95 * 60_000) });
  });

  it('"draft" follows up with a draft right away; off and all-day meetings do nothing', async () => {
    s.meetings = { enabled: true, briefMinutes: 0, followUp: 'draft' };
    events = [ev('e1', 'Budget sync', ['scott@x.com', 'dana@x.com'], T0 - H), { ...ev('e2', 'Budget offsite', ['scott@x.com', 'dana@x.com'], T0), start: '2026-11-16', end: '2026-11-17' }];
    await w.check(T0);
    expect(runs.map((r) => r.purpose)).toEqual(['draft']);
    expect(await repo.findItem('calendar', 'e2')).toBeNull();
    s.meetings = { enabled: false, briefMinutes: 30, followUp: 'offer' };
    events = [ev('e3', 'Budget sync 2', ['scott@x.com', 'dana@x.com'], T0 + 10 * 60_000)];
    await w.check(T0);
    expect(linkCalls).toBe(1);
  });

  it('candidates: shared attendee, or two meaningful title words; not generic words', async () => {
    const other = (await repo.createStream({ title: 'Weekly team sync notes', summary: 'meeting review' })).id;
    const got = async (e: Meeting) => (await candidates(repo, e, s.pu.email)).map((x) => x.id);
    expect(await got(ev('a', 'Chat', ['dana@x.com'], T0))).toEqual([budget]);
    expect(await got(ev('b', 'Revised budget numbers', ['zed@x.com'], T0))).toEqual([budget]);
    expect(await got(ev('c', 'Weekly team sync', ['zed@x.com'], T0))).not.toContain(other);
  });
});
