import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';

const CH = 'D0JANE00001';
const msg = (n: number, text: string, pu = false) => ({ id: `17945000${n}0.000001`, author: { name: pu ? 'Me' : 'Jane', email: pu ? 'me@x.com' : 'jane@x.com' }, text, at: new Date(Date.UTC(2026, 10, 12, 10, n)).toISOString(), isFromPU: pu });
const id = (n: number) => `17945000${n}0.000001`;
const ids = (i: { data: { messages?: { id: string }[] } } | undefined | null) => (i?.data.messages ?? []).map((m) => m.id);

/** A fake model: assigns by what the test says, and answers ordinary triage with the next queued decision. */
function setup() {
  const calls: { kind: 'split' | 'triage'; prompt: string }[] = [];
  const state = { split: {} as Record<string, string>, triage: [] as any[] };
  const backend = {
    structured: async (a: any) => {
      if (/NEW message id/.test(a.prompt)) {
        calls.push({ kind: 'split', prompt: a.prompt });
        return { assignments: Object.entries(state.split).map(([id, where]) => ({ id, where })) };
      }
      calls.push({ kind: 'triage', prompt: a.prompt });
      return state.triage.shift();
    },
  };
  return { calls, state, backend };
}
const decision = (streamId: string | null, extra: any = {}) => ({
  relevant: true,
  reason: 'r',
  stream: streamId ? { action: 'existing', streamId, title: null, summary: null, labels: null } : { action: 'new', streamId: null, title: 'Topic B', summary: 'About B', labels: null },
  relatedItemIds: null,
  updatedSummary: null,
  notify: null,
  next: { type: 'none', instruction: '', offerLabel: null },
  ...extra,
});

describe('automatic topic splitting of a Slack DM', () => {
  let repo: Repo;
  let a: string;
  let fake: ReturnType<typeof setup>;
  let t: TriagePipeline;
  const poll = (messages: ReturnType<typeof msg>[], eventId: string) => t.handle({ source: 'slack', kind: 'slack_thread', externalId: `${CH}:dm`, title: 'DM: Jane', eventId, data: { messages, slack: { channel: CH, threadTs: id(1) } } });

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    fake = setup();
    t = new TriagePipeline(repo, fake.backend as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, name: 'Me', email: 'me@x.com' } }));
    a = (await repo.createStream({ title: 'Topic A', summary: 'About A' })).id;
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: `${CH}:dm`, title: 'DM: Jane', data: { messages: [msg(1, 'A1', true), msg(2, 'A2'), msg(3, 'A3', true)], slack: { channel: CH, threadTs: id(1) } }, streamId: a });
  });

  it('a new topic (the PU starts it, the other person answers) leaves the first stream alone and ends up in a new stream', async () => {
    const first = [msg(1, 'A1', true), msg(2, 'A2'), msg(3, 'A3', true)];
    fake.state.split = { [id(4)]: 'other', [id(5)]: 'other' };
    fake.state.triage = [decision(null)];
    await poll([...first, msg(4, 'B1', true), msg(5, 'B2')], 'e1'); // B1 (PU) and B2 arrive together
    const streams = await repo.listStreams(false);
    const b = streams.find((s) => s.title === 'Topic B')!;
    expect(b).toBeTruthy();
    expect(ids((await repo.listItems(a))[0])).toEqual([id(1), id(2), id(3)]);
    expect(ids((await repo.listItems(b.id))[0])).toEqual([id(4), id(5)]);
    expect(fake.calls.filter((c) => c.kind === 'triage')).toHaveLength(1); // the stream that stayed had nothing new to triage
  });

  it('a late message on the first topic goes back to its own stream, not the one holding the latest message', async () => {
    const b = (await repo.createStream({ title: 'Topic B', summary: 'About B' })).id;
    const fam = (await repo.slackFamily(CH))[0];
    await repo.placeSlackMessages({ channel: CH, toStreamId: b, messages: [msg(4, 'B1', true), msg(5, 'B2')], title: fam.title });
    const known = [msg(1, 'A1', true), msg(2, 'A2'), msg(3, 'A3', true), msg(4, 'B1', true), msg(5, 'B2')];
    fake.state.split = { [id(6)]: a };
    fake.state.triage = [decision(a)];
    await poll([...known, msg(6, 'A4')], 'e2');
    expect(ids((await repo.listItems(a))[0])).toEqual([id(1), id(2), id(3), id(6)]);
    expect(ids((await repo.listItems(b))[0])).toEqual([id(4), id(5)]);
    const triage = fake.calls.filter((c) => c.kind === 'triage');
    expect(triage).toHaveLength(1);
    expect(triage[0].prompt).toContain(`ALREADY attached to stream ${a}`);
  });

  it('keeps messages together when the model fails or says stay', async () => {
    fake.state.triage = [decision(a)];
    await poll([msg(1, 'A1', true), msg(2, 'A2'), msg(3, 'A3', true), msg(4, 'A4')], 'e3');
    expect(ids((await repo.listItems(a))[0])).toHaveLength(4);
    const t2 = new TriagePipeline(repo, { structured: async () => { throw new Error('boom'); } } as any, { run: async () => undefined } as any, async () => defaultSettings());
    await expect(t2.handle({ source: 'slack', kind: 'slack_thread', externalId: `${CH}:dm`, title: 'DM: Jane', eventId: 'e4', data: { messages: [msg(5, 'A5')], slack: { channel: CH, threadTs: id(1) } } })).rejects.toThrow(); // the triage call itself fails; the split step did not lose the message
    expect(ids((await repo.listItems(a))[0])).toHaveLength(5);
  });

  it('can be turned off in settings', async () => {
    const off = new TriagePipeline(repo, fake.backend as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), claude: { ...defaultSettings().claude, splitSlackByTopic: false } }));
    fake.state.split = { [id(4)]: 'other' };
    fake.state.triage = [decision(a)];
    await off.handle({ source: 'slack', kind: 'slack_thread', externalId: `${CH}:dm`, title: 'DM: Jane', eventId: 'e5', data: { messages: [msg(4, 'B1')], slack: { channel: CH, threadTs: id(1) } } });
    expect(fake.calls.some((c) => c.kind === 'split')).toBe(false);
    expect(ids((await repo.listItems(a))[0])).toContain(id(4));
  });
});
