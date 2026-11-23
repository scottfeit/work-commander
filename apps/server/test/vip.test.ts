import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { managerialLineage } from '../src/core/vip.js';
import type { InboundItem } from '../src/integrations/types.js';

const person = (name: string, email: string, managerEmail?: string) => ({ name, email, managerEmail });
const ORG = [person('Me', 'me@x.com', 'boss@x.com'), person('Boss', 'boss@x.com', 'vp@x.com'), person('VP', 'vp@x.com', 'ceo@x.com'), person('CEO', 'ceo@x.com'), person('Peer', 'peer@x.com', 'boss@x.com')];
const at = (k: number) => new Date(Date.UTC(2026, 10, 20, 9, k)).toISOString();
const m = (id: string, email: string, k: number, isFromPU = false) => ({ id, author: { name: email.split('@')[0], email }, text: 'Can you look at this?', at: at(k), isFromPU });

describe('VIPs', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('the managerial lineage runs up the chain, and stops on a loop', () => {
    const people = ORG.map((p, i) => ({ id: String(i), source: 'file' as const, ...p }));
    expect(managerialLineage(people, ['ME@x.com']).map((p) => p.name)).toEqual(['Boss', 'VP', 'CEO']);
    const loop = [...people.filter((p) => p.name !== 'CEO'), { id: 'c', source: 'file' as const, ...person('CEO', 'ceo@x.com', 'vp@x.com') }];
    expect(managerialLineage(loop, ['me@x.com']).map((p) => p.name)).toEqual(['Boss', 'VP', 'CEO']);
  });

  it('the lineage button makes the chain VIPs, keeps hand-made changes, and adds new managers later', async () => {
    await repo.replacePeople('file', ORG);
    await repo.vips.set('peer@x.com', true);
    await repo.vips.set('vp@x.com', false); // removed by hand before the button
    expect((await repo.vips.followLineage(['me@x.com'])).sort()).toEqual(['boss@x.com', 'ceo@x.com']);
    const vip = async () => [...(await repo.vips.index()).emails].sort();
    expect(await vip()).toEqual(['boss@x.com', 'ceo@x.com', 'peer@x.com']);
    // a re-org: a new manager appears between Me and Boss; Boss leaves the chain but stays VIP
    repo.onPeopleChanged = () => repo.vips.syncLineage(['me@x.com']);
    await repo.replacePeople('file', [person('Me', 'me@x.com', 'new@x.com'), person('New', 'new@x.com', 'ceo@x.com'), person('Boss', 'boss@x.com', 'ceo@x.com'), person('CEO', 'ceo@x.com')]);
    expect(await vip()).toEqual(['boss@x.com', 'ceo@x.com', 'new@x.com', 'peer@x.com']);
    // un-ticking a lineage VIP sticks through later syncs
    await repo.vips.set('new@x.com', false);
    await repo.vips.syncLineage(['me@x.com']);
    expect(await vip()).not.toContain('new@x.com');
  });

  it("without the button, managers aren't added", async () => {
    await repo.replacePeople('file', ORG);
    expect(await repo.vips.syncLineage(['me@x.com'])).toEqual([]);
  });

  it('the VIP chip stays (read or not) until someone else replied after the VIP and the stream was read', async () => {
    await repo.vips.set('boss@x.com', true);
    const s = await repo.createStream({ title: 'T', summary: '' });
    const vipChip = async () => (await repo.getStream(s.id))!.vip;
    const put = (messages: any[]) => repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g1', title: 't', streamId: s.id, data: { messages } } as any);
    await put([m('1', 'peer@x.com', 1)]);
    expect(await vipChip()).toBe(false);
    await put([m('1', 'peer@x.com', 1), m('2', 'boss@x.com', 2)]);
    expect(await vipChip()).toBe(true);
    await repo.updateStream(s.id, { unread: false });
    expect(await vipChip()).toBe(true); // read, but nobody has answered the VIP
    await repo.updateStream(s.id, { unread: true });
    await put([m('1', 'peer@x.com', 1), m('2', 'boss@x.com', 2), m('3', 'peer@x.com', 3)]);
    expect(await vipChip()).toBe(true); // someone else replied, but it's unread
    await repo.updateStream(s.id, { unread: false });
    expect(await vipChip()).toBe(false); // replied after and read: cleared
    await repo.updateStream(s.id, { unread: true });
    expect(await vipChip()).toBe(false); // stays cleared
    await put([m('1', 'peer@x.com', 1), m('2', 'boss@x.com', 2), m('3', 'peer@x.com', 3), m('4', 'boss@x.com', 4)]);
    expect(await vipChip()).toBe(true); // the VIP wrote again
  });

  describe('triage', () => {
    const notWork = { relevant: false, reason: 'FYI only', stream: { action: 'none', streamId: null, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    const work = { ...notWork, relevant: true, reason: 'asks', stream: { action: 'new', streamId: null, title: 'Look at this', summary: 'S', labels: [] } };
    const run = async (from: string, answer: unknown) => {
      const s = defaultSettings();
      s.pu = { ...s.pu, name: 'Me', email: 'me@x.com' };
      s.triage = { ...s.triage, newStreams: 'ask' };
      const t = new TriagePipeline(repo, { structured: async () => answer } as any, { run: async () => undefined } as any, async () => s);
      const inbound: InboundItem = { source: 'gmail', kind: 'email_thread', externalId: `t-${from}`, title: 'A note', eventId: `t-${from}:1`, data: { messages: [m('1', from, 1)] } };
      await t.handle(inbound);
      return repo.findItem('gmail', `t-${from}`);
    };

    it("what a VIP starts becomes a work stream straight away, even when triage thinks it isn't work", async () => {
      await repo.vips.set('boss@x.com', true);
      const it = await run('boss@x.com', notWork);
      expect(it!.streamId).toBeTruthy();
      expect(it!.data.proposedStream).toBeUndefined();
    });

    it('others still go through "Ask me first"', async () => {
      await repo.vips.set('boss@x.com', true);
      const it = await run('peer@x.com', work);
      expect(it!.streamId).toBeNull();
      expect(it!.data.proposedStream?.title).toBe('Look at this');
    });
  });
});
