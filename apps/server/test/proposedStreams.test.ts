import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import type { Settings } from '@wc/shared';

const decision = (stream: any, next: any = { type: 'offer', instruction: 'Review the budget', offerLabel: 'Review it?' }) => ({
  relevant: true,
  reason: 'Dana asks for a budget review',
  stream,
  relatedItemIds: null,
  updatedSummary: null,
  notify: null,
  next,
});

describe('triage: new work streams need the PU to accept them ("Ask me first")', () => {
  let repo: Repo;
  let s: Settings;
  let answer: any;
  let calls = 0;
  let n = 0;
  const pipeline = () => new TriagePipeline(repo, { structured: async () => (calls++, answer) } as any, { run: async () => undefined } as any, async () => s);
  const message = (title = 'Budget review') => {
    n++;
    return { source: 'gmail' as const, kind: 'email_thread' as const, externalId: `t${n}`, title, eventId: `e${n}`, data: { messages: [{ id: `m${n}`, author: { name: 'Dana', email: 'dana@x.com' }, text: 'Please review', at: new Date().toISOString() }] } };
  };

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    s = defaultSettings();
    s.pu = { ...s.pu, name: 'Scott', email: 'scott@x.com' };
    s.triage = { ...s.triage, newStreams: 'ask' };
    calls = 0;
    answer = decision({ action: 'new', streamId: null, title: 'Q3 budget review', summary: 'Dana wants the Q3 budget reviewed.', labels: ['budget'] });
  });

  it('creates new work streams itself by default', async () => {
    expect(defaultSettings().triage.newStreams).toBe('create');
    s.triage.newStreams = 'create';
    await pipeline().handle(message());
    expect((await repo.listStreams(false)).map((x) => x.title)).toEqual(['Q3 budget review']);
  });

  it('proposes the new stream instead, and accepting creates it from that decision without asking the model again', async () => {
    const t = pipeline();
    const m = message();
    await t.handle(m);
    expect(await repo.listStreams(false)).toHaveLength(0);
    const item = (await repo.findItem('gmail', m.externalId))!;
    const [listed] = await repo.listSkipped();
    expect(listed).toMatchObject({ id: item.id, proposed: { title: 'Q3 budget review', summary: 'Dana wants the Q3 budget reviewed.' }, reason: 'Dana asks for a budget review', dismissed: false });

    const before = calls;
    const streamId = await t.acceptProposed(item.id);
    expect(calls).toBe(before);
    const st = (await repo.getStream(streamId!))!;
    expect(st).toMatchObject({ title: 'Q3 budget review', summary: 'Dana wants the Q3 budget reviewed.', labels: ['budget'] });
    const after = (await repo.getItem(item.id))!;
    expect(after.streamId).toBe(streamId);
    expect(after.data.proposedStream).toBeUndefined();
    // The next step triage chose still happens.
    expect((await repo.listChat(streamId)).some((c) => c.role === 'suggestion' && c.meta.suggestion?.instruction === 'Review the budget')).toBe(true);
    expect(await repo.listSkipped()).toHaveLength(0);
  });

  it('still adds activity to existing work streams without asking', async () => {
    const home = await repo.createStream({ title: 'Budget', summary: 'b' });
    answer = decision({ action: 'existing', streamId: home.id, title: null, summary: null, labels: null });
    const m = message();
    await pipeline().handle(m);
    expect((await repo.findItem('gmail', m.externalId))!.streamId).toBe(home.id);
  });

  it('declining hides it until new activity brings a fresh proposal', async () => {
    const t = pipeline();
    const m = message();
    await t.handle(m);
    const id = (await repo.findItem('gmail', m.externalId))!.id;
    await t.declineProposed(id);
    expect(await repo.listSkipped()).toHaveLength(0);
    expect((await repo.listSkipped(14, true))[0]).toMatchObject({ id, dismissed: true, proposed: { title: 'Q3 budget review' } });
    await new Promise((r) => setTimeout(r, 5));
    await t.handle({ ...m, eventId: 'later', data: { messages: [...m.data.messages, { id: 'm-later', author: { name: 'Dana', email: 'dana@x.com' }, text: 'Any update?', at: new Date().toISOString() }] } });
    expect((await repo.listSkipped())[0]).toMatchObject({ id, dismissed: false });
    expect(await repo.listStreams(false)).toHaveLength(0);
  });

  it('dragging a proposed item onto a work stream settles the proposal', async () => {
    const home = await repo.createStream({ title: 'Budget', summary: 'b' });
    const m = message();
    await pipeline().handle(m);
    const id = (await repo.findItem('gmail', m.externalId))!.id;
    await repo.moveItem(id, home.id);
    expect((await repo.getItem(id))!.data.proposedStream).toBeUndefined();
  });

  it('"Accept" on an ordinary skipped item (retriage with force) never asks', async () => {
    answer = { ...decision({ action: 'none', streamId: null, title: null, summary: null, labels: null }), relevant: false };
    const t = pipeline();
    const m = message();
    await t.handle(m);
    const id = (await repo.findItem('gmail', m.externalId))!.id;
    const r = await t.retriage(id, true);
    expect(r.streamId).not.toBeNull();
  });
});
