import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { IntegrationHub } from '../src/integrations/hub.js';
import type { InboundItem, InboundSink } from '../src/integrations/types.js';

const mail = (id: string, state: { unread: boolean; inbox: boolean; trash: boolean }, fromPU = false): InboundItem => ({
  source: 'gmail',
  kind: 'email_thread',
  externalId: id,
  title: id,
  eventId: `${id}-m`,
  data: { messages: [{ id: `${id}-m`, author: { name: 'Dana' }, text: 'hi', at: new Date().toISOString(), isFromPU: fromPU }], gmail: { threadId: id, state } },
});
const inbox = { unread: true, inbox: true, trash: false };

describe('pausing polling and triage after a gap', () => {
  let repo: Repo;
  let hub: IntegrationHub;
  let polls: number;
  let push: InboundSink;
  let triaged: string[];
  let queue: InboundItem[];
  const start = async (lastSeen?: number) => {
    if (lastSeen) await repo.setSync('poll.lastSeen', String(lastSeen));
    const s = defaultSettings();
    hub = new IntegrationHub({ publicUrl: 'http://x' } as any, { get: async () => s, onChange: () => undefined } as any, {} as any, repo, {
      apis: {},
      ingestors: (sink) => {
        push = sink;
        return [{ start: async () => undefined, stop: async () => undefined, pollOnce: async () => { polls++; for (const q of queue.splice(0)) await sink(q); } }];
      },
    });
    await hub.start(async (i) => void triaged.push(i.externalId));
  };

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    polls = 0;
    triaged = [];
    queue = [];
  });

  it('a gap longer than the setting (2 hours by default) pauses before anything is polled; Resume catches up', async () => {
    await start(Date.now() - 3 * 3600_000);
    await hub.pollAll();
    expect(polls).toBe(0);
    expect(hub.pollingState.paused).toMatchObject({ reason: 'gap' });
    // still paused after a restart
    await hub.stop();
    await start();
    expect(hub.isPaused).toBe(true);

    queue.push(mail('t1', inbox));
    await hub.resume();
    await expect.poll(() => hub.pollingState.catchingUp).toBe(false);
    expect(polls).toBe(2); // a second pass confirms nothing more turned up
    expect(triaged).toEqual(['t1']);
    await hub.stop();
  });

  it('a short gap (or the very first run) does not pause', async () => {
    await start(Date.now() - 30 * 60_000);
    await hub.pollAll();
    expect(polls).toBe(1);
    expect(hub.isPaused).toBe(false);
    await hub.stop();
    await start();
    expect(hub.alive(Date.now() + 3 * 3600_000)).toBe(false); // the computer slept for three hours
    expect(hub.isPaused).toBe(true);
    await hub.stop();
  });

  it('while paused, live updates are held (newest per conversation) and handled on Resume; cleaned-up email is skipped', async () => {
    await start();
    await hub.pause('manual');
    await push(mail('keep', inbox));
    await push(mail('keep', inbox));
    await push(mail('deleted', { ...inbox, inbox: false, trash: true }));
    expect(hub.pollingState.held).toBe(2);
    expect(triaged).toEqual([]);

    queue.push(mail('archived', { ...inbox, inbox: false }), mail('my-reply', { ...inbox, inbox: false }, true), mail('fresh', inbox));
    await hub.resume();
    await expect.poll(() => hub.pollingState.catchingUp).toBe(false);
    expect(triaged.sort()).toEqual(['fresh', 'keep', 'my-reply']);
    expect(hub.pollingState).toEqual({ paused: null, held: 0, catchingUp: false });

    // after the catch-up, updates are handled as normal again
    await push(mail('later', { ...inbox, inbox: false }));
    expect(triaged).toContain('later');
    await hub.stop();
  });

  it('0 hours means never pause', async () => {
    await start();
    (hub as any).gapMs = 0;
    expect(hub.alive(Date.now() + 48 * 3600_000)).toBe(true);
    await hub.stop();
  });
});
