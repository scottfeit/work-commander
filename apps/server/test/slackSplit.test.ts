import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { addWorkItemFromUrl } from '../src/core/addByUrl.js';

const msg = (id: string, text: string, at: string, pu = false) => ({ id, author: { name: pu ? 'Me' : 'Jane' }, text, at, isFromPU: pu });
const CH = 'D0JANE00001';
const ids = (i: { data: { messages?: { id: string }[] } } | null) => (i?.data.messages ?? []).map((m) => m.id);

// Topic A: 1, 2, 3, 6   Topic B: 4, 5
const convo = [
  msg('1794500001.000001', 'A1', '2026-11-12T10:00:00Z', true),
  msg('1794500002.000002', 'A2', '2026-11-12T10:01:00Z'),
  msg('1794500003.000003', 'A3', '2026-11-12T10:02:00Z', true),
  msg('1794500004.000004', 'B1', '2026-11-12T10:03:00Z', true),
  msg('1794500005.000005', 'B2', '2026-11-12T10:04:00Z'),
  msg('1794500006.000006', 'A4', '2026-11-12T10:05:00Z'),
];

describe('splitting a Slack conversation across work streams', () => {
  let repo: Repo;
  let a: string;
  let b: string;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    a = (await repo.createStream({ title: 'Topic A', summary: '' })).id;
    b = (await repo.createStream({ title: 'Topic B', summary: '' })).id;
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: `${CH}:dm`, title: 'DM: Jane', data: { messages: convo, slack: { channel: CH, threadTs: '1794500001.000001' } }, streamId: a });
  });

  const split = async () => {
    const item = (await repo.slackFamily(CH))[0];
    return repo.placeSlackMessages({ channel: CH, toStreamId: b, messages: item.data.messages!.filter((m) => ['1794500004.000004', '1794500005.000005'].includes(m.id)), title: item.title });
  };

  it('moves chosen messages into their own item in the other stream', async () => {
    const r = await split();
    expect(ids(r.item)).toEqual(['1794500004.000004', '1794500005.000005']);
    expect(r.item!.streamId).toBe(b);
    const inA = (await repo.listItems(a)).filter((i) => i.source === 'slack');
    expect(inA).toHaveLength(1);
    expect(ids(inA[0])).toEqual(['1794500001.000001', '1794500002.000002', '1794500003.000003', '1794500006.000006']);
    expect(inA[0].title).toBe('DM: Jane');
  });

  it('a later poll of the whole conversation does not pull moved messages back, and new ones follow the latest message', async () => {
    await split();
    const poll = (more: ReturnType<typeof msg>[]) => repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: `${CH}:dm`, title: 'DM: Jane', data: { messages: [...convo, ...more], slack: { channel: CH, threadTs: '1794500001.000001' } } });
    const same = await poll([]);
    expect(same.changed).toBe(false);
    expect((await repo.slackFamily(CH)).map((i) => ids(i).length).sort()).toEqual([2, 4]);
    // the latest message (A4, 6.6) lives in stream A, so a new message carries on there
    const next = await poll([msg('1794500007.000007', 'A5', '2026-11-12T10:06:00Z')]);
    expect(next.newMessages.map((m) => m.id)).toEqual(['1794500007.000007']);
    expect(next.item.streamId).toBe(a);
    expect(ids(next.item)).toEqual(['1794500001.000001', '1794500002.000002', '1794500003.000003', '1794500006.000006', '1794500007.000007']);
    expect(ids((await repo.listItems(b))[0])).toEqual(['1794500004.000004', '1794500005.000005']);
  });

  it('moving everything out removes the emptied item and keeps the conversation together in the new place', async () => {
    const item = (await repo.slackFamily(CH))[0];
    await repo.placeSlackMessages({ channel: CH, toStreamId: b, messages: item.data.messages!, title: item.title });
    expect(await repo.listItems(a)).toHaveLength(0);
    expect(ids((await repo.listItems(b))[0])).toHaveLength(6);
    expect(await repo.slackFamily(CH)).toHaveLength(1);
  });

  it('can move messages out of every work stream (not relevant)', async () => {
    const item = (await repo.slackFamily(CH))[0];
    const r = await repo.placeSlackMessages({ channel: CH, toStreamId: null, messages: item.data.messages!.filter((m) => m.id === '1794500004.000004'), title: item.title });
    expect(r.item!.streamId).toBeNull();
    expect(ids(r.item)).toEqual(['1794500004.000004']);
  });

  it('keeps the other streams’ messages when asked to (a link’s later messages)', async () => {
    await split();
    const c = (await repo.createStream({ title: 'C', summary: '' })).id;
    const r = await repo.placeSlackMessages({ channel: CH, toStreamId: c, messages: convo.filter((m) => m.id >= '1794500004.000004'), title: 'DM: Jane', keepOtherStreams: true });
    expect(r.item).toBeNull(); // every one of them is held by another work stream, so nothing is taken
  });
});

describe('adding a Slack link takes the message and what follows it, not what came before', () => {
  it('from a DM already held by another stream', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const a = (await repo.createStream({ title: 'Approvers', summary: '' })).id;
    const b = (await repo.createStream({ title: 'Coupa', summary: '' })).id;
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: `${CH}:dm`, title: 'DM: Jane', data: { messages: convo, slack: { channel: CH, threadTs: '1794500001.000001' } }, streamId: a });
    const anchor = msg('1794500004.000004', 'B1', '2026-11-12T10:03:00Z', true);
    const hub = { api: async () => ({ getThread: async () => ({ source: 'slack', kind: 'slack_thread', externalId: `${CH}:4.4`, title: 'Slack DM: B1', data: { messages: [anchor], slack: { channel: CH, threadTs: '1794500004.000004' } }, eventId: 'x' }) }) } as any;
    const deps = { repo, hub, settings: async () => ({ slack: { mode: 'api' }, pu: { email: 'me@x.com' } }) as any, secret: async () => '' };
    const r = await addWorkItemFromUrl(deps, b, `https://x.slack.com/archives/${CH}/p1794500004000004`);
    expect(r.created).toBe(true);
    // 4.4 (the link), and the later messages the same item held (5.5, 6.6), are now here; 1.1–3.3 stay with Approvers
    expect(ids(r.item)).toEqual(['1794500004.000004', '1794500005.000005', '1794500006.000006']);
    expect(r.item.streamId).toBe(b);
    expect(ids((await repo.listItems(a))[0])).toEqual(['1794500001.000001', '1794500002.000002', '1794500003.000003']);
  });
});
