import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { updateWaitingOn, waitingCandidates } from '../src/core/waitingOn.js';

const s = { ...defaultSettings(), pu: { ...defaultSettings().pu, name: 'Alex', email: 'alex@x.com', aliases: [] } };
const m = (id: string, name: string, at: string, extra: Record<string, unknown> = {}) => ({ id, author: { name, email: `${name.toLowerCase().split(' ')[0]}@x.com` }, text: 'hi', at, ...extra });
const item = (source: string, data: any) => ({ id: source, source, kind: 'x', externalId: source, title: 't', data } as any);

describe('who a Pending stream is waiting on', () => {
  it('an email: whoever your last message went to (named from the thread)', () => {
    const c = waitingCandidates([item('gmail', { messages: [m('1', 'Lee Wong', '2026-11-17T10:00:00Z'), m('2', 'Alex', '2026-11-18T09:00:00Z', { isFromPU: true, to: ['lee@x.com', 'alex@x.com'] })] })], s);
    expect(c).toEqual({ since: '2026-11-18T09:00:00Z', people: ['Lee Wong'], context: expect.any(String) });
  });

  it('a Slack DM: the other person; a ticket: its requester', () => {
    expect(waitingCandidates([item('slack', { messages: [m('1', 'Priya Shah', '2026-11-17T10:00:00Z'), m('2', 'Alex', '2026-11-18T09:00:00Z', { isFromPU: true })] })], s)!.people).toEqual(['Priya Shah']);
    expect(waitingCandidates([item('jsm', { ticket: { key: 'OPS-1', requester: 'priya@x.com', comments: [m('c1', 'Priya Shah', '2026-11-17T10:00:00Z'), m('c2', 'Alex', '2026-11-18T09:00:00Z', { isFromPU: true })] } })], s)!.people).toEqual(['Priya Shah']);
  });

  it("you haven't written: nobody", () => {
    expect(waitingCandidates([item('slack', { messages: [m('1', 'Priya Shah', '2026-11-17T10:00:00Z')] })], s)).toBeNull();
  });

  it('one person: no model call; several: the cheap model picks, and only from those named', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const st = await repo.createStream({ title: 'T', summary: '' });
    await repo.updateStream(st.id, { pending: true });
    const calls: any[] = [];
    const backend = { structured: async (i: any) => (calls.push(i), { who: 'Marco Diaz' }) } as any;
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C1:1', title: 't', streamId: st.id, data: { messages: [m('1', 'Priya Shah', '2026-11-17T10:00:00Z'), m('2', 'Alex', '2026-11-18T09:00:00Z', { isFromPU: true })] } } as any);
    expect(await updateWaitingOn({ repo, backend, settings: async () => s }, st.id)).toEqual({ who: 'Priya Shah', since: '2026-11-18T09:00:00Z' });
    expect(calls).toHaveLength(0);
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C1:1', title: 't', streamId: st.id, data: { messages: [m('1', 'Priya Shah', '2026-11-17T10:00:00Z'), m('3', 'Marco Diaz', '2026-11-17T11:00:00Z'), m('2', 'Alex', '2026-11-18T09:00:00Z', { isFromPU: true })] } } as any);
    expect(await updateWaitingOn({ repo, backend, settings: async () => s }, st.id)).toEqual({ who: 'Marco Diaz', since: '2026-11-18T09:00:00Z' });
    expect(calls[0]).toMatchObject({ usage: { kind: 'waitingOn' }, prompt: expect.stringContaining('People: Priya Shah, Marco Diaz') });
    expect((await repo.getStream(st.id))!.waitingOn).toEqual({ who: 'Marco Diaz', since: '2026-11-18T09:00:00Z' });
    await repo.updateStream(st.id, { pending: false });
    expect((await repo.getStream(st.id))!.waitingOn).toBeNull();
  });
});
