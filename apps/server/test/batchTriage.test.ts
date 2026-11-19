import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { IntegrationHub } from '../src/integrations/hub.js';
import type { InboundItem } from '../src/integrations/types.js';
import type { Settings } from '@wc/shared';

const at = (k: number) => new Date(Date.UTC(2026, 10, 16, 9, k)).toISOString();
const msg = (id: string, k: number, text = 'Can you look at this?') => ({ id, author: { name: 'Dana', email: 'dana@x.com' }, text, at: at(k) });
const mail = (thread: string, ids: [string, number][], title = `Thread ${thread}`): InboundItem => ({
  source: 'gmail',
  kind: 'email_thread',
  externalId: thread,
  title,
  eventId: `${thread}:${ids[ids.length - 1][0]}`,
  data: { messages: ids.map(([id, k]) => msg(id, k)) },
});
const decision = (key: string, title: string | null, extra: object = {}) => ({
  key,
  relevant: true,
  reason: 'asks',
  stream: { action: 'new', streamId: null, title, summary: 'S', labels: [] },
  relatedItemIds: null,
  updatedSummary: null,
  notify: null,
  next: { type: 'none', instruction: '', offerLabel: null },
  sameNewStreamAs: null,
  ...extra,
});

describe('batch triage after a catch-up', () => {
  let repo: Repo;
  let s: Settings;
  let triage: TriagePipeline;
  let calls: { prompt: string; batch: boolean }[];
  let batchAnswer: (prompt: string) => unknown;

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    s = defaultSettings();
    s.pu = { ...s.pu, name: 'Scott', email: 'scott@x.com' };
    s.playbooks = 'PLAYBOOK-MARKER';
    calls = [];
    batchAnswer = () => ({ decisions: [] });
    const backend = {
      structured: async (i: { prompt: string }) => {
        const batch = i.prompt.includes('=== Update u1 ===');
        calls.push({ prompt: i.prompt, batch });
        if (batch) return batchAnswer(i.prompt);
        const { key, sameNewStreamAs, ...one } = decision('x', 'Single') as any;
        return one;
      },
    };
    triage = new TriagePipeline(repo, backend as any, { run: async () => undefined } as any, async () => s);
  });

  it('several updates are decided in one call, with the shared context (PU, playbooks, streams) sent once', async () => {
    batchAnswer = () => ({ decisions: [decision('u1', 'Alpha'), decision('u2', 'Beta'), decision('u3', 'Gamma')] });
    await triage.sinkBatch([mail('a', [['a1', 1]]), mail('b', [['b1', 2]]), mail('c', [['c1', 3]])]);
    expect(calls.length).toBe(1);
    expect(calls[0].batch).toBe(true);
    expect(calls[0].prompt.split('PLAYBOOK-MARKER').length - 1).toBe(1);
    expect(calls[0].prompt).toContain('=== Update u3 ===');
    expect((await repo.listStreams(false)).map((x) => x.title).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    for (const t of ['a', 'b', 'c']) expect((await repo.findItem('gmail', t))!.streamId).not.toBeNull();
  });

  it('a burst on one conversation is judged once, with all its new messages, and every event is marked done', async () => {
    batchAnswer = (p) => ({ decisions: [decision('u1', 'Burst'), ...(p.includes('=== Update u2 ===') ? [decision('u2', 'Other')] : [])] });
    await triage.sinkBatch([mail('t', [['t1', 1]]), mail('t', [['t1', 1], ['t2', 2]]), mail('o', [['o1', 3]])]);
    expect(calls.length).toBe(1);
    const updates = calls[0].prompt.split('=== Update ').length - 1;
    expect(updates).toBe(2);
    const u1 = calls[0].prompt.slice(calls[0].prompt.indexOf('=== Update u1'), calls[0].prompt.indexOf('=== Update u2'));
    expect(u1.match(/NEW activity:[\s\S]*/)![0].split('<message').length - 1).toBe(2); // both of t's messages are new
    expect(await repo.listUnprocessedInbound(-60_000, 50)).toEqual([]);
  });

  it('updates that start the same new piece of work share one new stream', async () => {
    batchAnswer = () => ({ decisions: [decision('u1', 'Outage'), decision('u2', null, { sameNewStreamAs: 'u1' })] });
    await triage.sinkBatch([mail('p', [['p1', 1]]), mail('q', [['q1', 2]])]);
    const streams = await repo.listStreams(false);
    expect(streams.map((x) => x.title)).toEqual(['Outage']);
    expect((await repo.findItem('gmail', 'q'))!.streamId).toBe(streams[0].id);
  });

  it('an update the batch answer left out is decided on its own; a single update is triaged as usual', async () => {
    batchAnswer = () => ({ decisions: [decision('u1', 'Only one')] });
    await triage.sinkBatch([mail('m', [['m1', 1]]), mail('n', [['n1', 2]])]);
    expect(calls.map((c) => c.batch)).toEqual([true, false]);
    expect((await repo.findItem('gmail', 'n'))!.streamId).not.toBeNull();
    calls = [];
    await triage.sinkBatch([mail('z', [['z1', 3]])]);
    expect(calls.map((c) => c.batch)).toEqual([false]);
  });

  it('Resume hands the catch-up to triage as one batch', async () => {
    const batches: string[][] = [];
    let push: (i: InboundItem) => Promise<void> = async () => undefined;
    const queue: InboundItem[] = [];
    const hub = new IntegrationHub({ publicUrl: 'http://x' } as any, { get: async () => s, onChange: () => undefined } as any, {} as any, repo, {
      apis: {},
      ingestors: (sink) => {
        push = sink;
        return [{ start: async () => undefined, stop: async () => undefined, pollOnce: async () => { for (const q of queue.splice(0)) await sink(q); } }];
      },
    });
    await hub.start(async () => undefined, async (items) => void batches.push(items.map((i) => i.externalId)));
    await hub.pause('manual');
    await push(mail('held', [['h1', 1]]));
    queue.push(mail('x', [['x1', 2]]), mail('y', [['y1', 3]]));
    await hub.resume();
    await expect.poll(() => hub.pollingState.catchingUp).toBe(false);
    expect(batches).toEqual([['x', 'y', 'held']]);
    await hub.stop();
  });
});

describe('catching up reads until nothing new turns up', () => {
  it('several rounds, a failed read retried, then one batch; progress is reported along the way', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const s = defaultSettings();
    const rounds: InboundItem[][] = [[mail('a', [['a1', 1]]), mail('b', [['b1', 2]])], [mail('c', [['c1', 3]])], []];
    let n = 0;
    let fail = true;
    const hub = new IntegrationHub({ publicUrl: 'http://x' } as any, { get: async () => s, onChange: () => undefined } as any, {} as any, repo, {
      apis: {},
      ingestors: (sink) => [
        {
          start: async () => undefined,
          stop: async () => undefined,
          pollOnce: async () => {
            if (n === 1 && fail) {
              fail = false; // the second round fails once, and is retried
              (hub as any).report('slack')(false, 'rate limited');
              return;
            }
            for (const i of rounds[n++] ?? []) await sink(i);
            (hub as any).report('slack')(true, 'ok');
          },
        },
      ],
    });
    hub.retryDelay = () => 1;
    const seen: string[] = [];
    const { bus } = await import('../src/core/bus.js');
    const off = bus.subscribe((e: any) => e.type === 'polling.changed' && e.polling.progress && seen.push(`${e.polling.progress.phase}:${e.polling.progress.found}:${e.polling.progress.done}/${e.polling.progress.total}${e.polling.progress.retrying ? ':retry' : ''}`));
    const batches: string[][] = [];
    await hub.start(async () => undefined, async (items, done) => {
      batches.push(items.map((i) => i.externalId));
      for (const _ of items) done?.();
    });
    await hub.pause('manual');
    await hub.resume();
    await expect.poll(() => hub.pollingState.catchingUp).toBe(false);
    off?.();
    expect(batches).toEqual([['a', 'b', 'c']]);
    expect(seen).toContain('reading:2:0/0');
    expect(seen.some((x) => x.endsWith(':retry'))).toBe(true);
    expect(seen).toContain('triaging:3:3/3');
    expect(hub.pollingState.progress).toBeUndefined();
    await hub.stop();
  });
});
