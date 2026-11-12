import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { lastResponder, surfaceDueReminders } from '../src/core/reminders.js';

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const m = (id: string, name: string, at: string, pu = false) => ({ id, author: { name, email: `${name.toLowerCase()}@x.com` }, text: `${name} says ${id}`, at, isFromPU: pu });

describe('Pending reminders', () => {
  let repo: Repo;
  let runs: { streamId: string; prompt: string }[];
  const deps = (days = 3) => ({ repo, settings: async () => ({ reminders: { pendingDays: days } }), run: (r: any) => void runs.push(r) });
  const backdate = (id: string, days: number) => sql`UPDATE streams SET last_activity_at = ${iso(days * DAY)}, pending_at = ${iso(days * DAY)} WHERE id = ${id}`.execute(repo.db);

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    runs = [];
  });

  const pendingStream = async (title: string) => {
    const id = (await repo.createStream({ title, summary: '' })).id;
    await repo.updateStream(id, { pending: true, unread: false });
    return id;
  };

  it('surfaces a pending stream untouched for the number of days: top of Open, Reminder, stream unread, items not', async () => {
    const id = await pendingStream('Old');
    const other = (await repo.createStream({ title: 'Newer', summary: '' })).id;
    const { item } = await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Thread', data: { messages: [m('1', 'Priya', iso(5 * DAY))] }, streamId: id });
    await backdate(id, 4);
    expect(await surfaceDueReminders(deps(3))).toEqual([id]);
    const s = (await repo.getStream(id))!;
    expect(s.pending).toBe(false);
    expect(s.reminderAt).toBeTruthy();
    expect(s.unread).toBe(true);
    expect((await repo.listStreams(false))[0].id).toBe(id); // top of the list
    expect((await repo.getItem(item.id))!.data.unread).toBeFalsy(); // work items stay as they were
    expect((await repo.getStream(other))!.reminderAt).toBeFalsy();
  });
  it('leaves streams alone that are not old enough, not pending, or when the setting is 0', async () => {
    const fresh = await pendingStream('Fresh');
    await backdate(fresh, 2);
    const notPending = (await repo.createStream({ title: 'Open', summary: '' })).id;
    await backdate(notPending, 30);
    expect(await surfaceDueReminders(deps(3))).toEqual([]);
    const old = await pendingStream('Old');
    await backdate(old, 30);
    expect(await surfaceDueReminders(deps(0))).toEqual([]); // 0 = never
    expect((await repo.getStream(old))!.pending).toBe(true);
    expect(runs).toHaveLength(0);
  });
  it('the clock starts when it was marked pending, not at its last activity', async () => {
    const id = (await repo.createStream({ title: 'Quiet for ages, snoozed just now', summary: '' })).id;
    await sql`UPDATE streams SET last_activity_at = ${iso(30 * DAY)} WHERE id = ${id}`.execute(repo.db);
    await repo.updateStream(id, { pending: true });
    expect(await surfaceDueReminders(deps(3))).toEqual([]);
  });
  it('does not fire twice, and snoozing again clears the Reminder and restarts the clock', async () => {
    const id = await pendingStream('S');
    await backdate(id, 4);
    await surfaceDueReminders(deps(3));
    expect(await surfaceDueReminders(deps(3))).toEqual([]);
    await repo.updateStream(id, { pending: true });
    const s = (await repo.getStream(id))!;
    expect(s.reminderAt).toBeFalsy();
    expect(s.pending).toBe(true);
    expect(await surfaceDueReminders(deps(3))).toEqual([]);
  });
  it('closing the stream, or new activity un-pending it, clears the Reminder', async () => {
    const a = await pendingStream('A');
    await backdate(a, 4);
    await surfaceDueReminders(deps(3));
    await repo.updateStream(a, { status: 'closed' });
    expect((await repo.getStream(a))!.reminderAt).toBeFalsy();
    const b = await pendingStream('B');
    await backdate(b, 4);
    await surfaceDueReminders(deps(3));
    await repo.updateStream(b, { pending: false, touch: true }); // what triage does when someone writes
    expect((await repo.getStream(b))!.reminderAt).toBeFalsy();
  });
  it('asks Claude to draft to whoever responded last, other than the PU, across all items', async () => {
    const id = await pendingStream('S');
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Email', data: { messages: [m('1', 'Priya', iso(6 * DAY)), m('2', 'Me', iso(5 * DAY), true)] }, streamId: id });
    await repo.upsertItem({
      source: 'jira',
      kind: 'ticket',
      externalId: 'IT-1',
      title: 'Ticket',
      data: { ticket: { key: 'IT-1', summary: 's', status: 'Open', flavor: 'jira', comments: [m('c1', 'Lee', iso(5.5 * DAY)), m('c2', 'Me', iso(4.5 * DAY), true)] } },
      streamId: id,
    });
    await backdate(id, 4);
    await surfaceDueReminders(deps(3));
    expect(runs).toHaveLength(1);
    expect(runs[0].streamId).toBe(id);
    expect(runs[0].prompt).toContain('Lee'); // 5.5 days ago beats Priya's 6 days; the PU's own later messages don't count
    expect(runs[0].prompt).not.toContain('Priya says');
    expect(runs[0].prompt).toContain('propose_ticket_comment');
  });
  it('lastResponder ignores the PU and WC\'s own sent copies; none when nobody else wrote', () => {
    const item = (msgs: any[]) => ({ id: 'i', source: 'slack', title: 't', data: { messages: msgs } }) as any;
    expect(lastResponder([item([m('1', 'Me', iso(DAY), true), m('sent-2', 'Other', iso(1000))])])).toBeNull();
    expect(lastResponder([item([m('1', 'Ann', iso(2 * DAY)), m('2', 'Bob', iso(DAY))])])!.name).toBe('Bob');
  });
  it('a database from before this feature is upgraded in place', async () => {
    const file = `${(await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'wc-rem-'))}/o.sqlite`;
    const first = await openDatabase(`sqlite:${file}`);
    const id = (await new Repo(first.db).createStream({ title: 'kept', summary: '' })).id;
    await sql`ALTER TABLE streams DROP COLUMN pending_at`.execute(first.db);
    await sql`ALTER TABLE streams DROP COLUMN reminder_at`.execute(first.db);
    await first.db.destroy();
    const again = new Repo((await openDatabase(`sqlite:${file}`)).db);
    expect((await again.getStream(id))!.title).toBe('kept');
    expect((await again.getStream(id))!.reminderAt).toBeFalsy();
  });
});
