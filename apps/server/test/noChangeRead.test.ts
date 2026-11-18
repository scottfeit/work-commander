import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { conversationParts } from '../src/agent/mcpIngest.js';
import { planTrackedSlackReads } from '../src/agent/mcpIngest.js';

const msg = (ts: string, text = 't') => ({ id: ts, author: { name: 'A' }, text, at: new Date(Number(ts) * 1000).toISOString() });
const dm = (messages: ReturnType<typeof msg>[], extra: any = {}) => ({ source: 'slack' as const, kind: 'slack_thread' as const, externalId: 'D0JARON001:dm', title: 'DM: Jaron', data: { messages, slack: { channel: 'D0JARON001', threadTs: messages[0].id } }, ...extra });
const wait = () => new Promise((r) => setTimeout(r, 5));

describe('reading something again that has not changed', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('is not activity: no update, same "updated" time', async () => {
    const first = await repo.upsertItem(dm([msg('1794955300.000100'), msg('1794955325.000200')]));
    await wait();
    const again = await repo.upsertItem(dm([msg('1794955300.000100'), msg('1794955325.000200')]));
    expect(again.changed).toBe(false);
    expect(again.item.id).toBe(first.item.id);
    expect((await repo.getItem(first.item.id))!.updatedAt).toBe(first.item.updatedAt);
  });

  it('a new message still updates it', async () => {
    const first = await repo.upsertItem(dm([msg('1794955300.000100')]));
    await wait();
    const next = await repo.upsertItem(dm([msg('1794955300.000100'), msg('1794955400.000200')]));
    expect(next.changed).toBe(true);
    expect(next.newMessages.map((m) => m.id)).toEqual(['1794955400.000200']);
    expect((await repo.getItem(first.item.id))!.updatedAt > first.item.updatedAt).toBe(true);
  });

  it('a Declined skipped item stays declined through re-reads, and comes back only for a newer message', async () => {
    const it = await repo.upsertItem(dm([msg('1794955300.000100'), msg('1794955325.000200')]));
    await repo.dismissSkipped(it.item.id);
    await wait();
    await repo.upsertItem(dm([msg('1794955300.000100'), msg('1794955325.000200')])); // a poll reads it again
    expect(await repo.listSkipped(36500)).toHaveLength(0);
    const future = Date.now() / 1000 + 60;
    await repo.upsertItem(dm([msg('1794955300.000100'), msg('1794955325.000200'), msg(future.toFixed(6))]));
    expect(await repo.listSkipped(36500)).toHaveLength(1);
  });
});

describe('the read point of a DM split across work streams', () => {
  it('counts the messages held outside the streams, so they are not fetched again every poll', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const stream = (await repo.createStream({ title: 'Backlog cleanup', summary: '' })).id;
    const a = await repo.upsertItem(dm([msg('1794900000.000100')], { streamId: stream }));
    await repo.placeSlackMessages({ channel: 'D0JARON001', toStreamId: null, messages: [msg('1794955300.000100')], title: 'DM: Jaron', flat: true });
    const inStreams = await repo.listItems(stream);
    expect(planTrackedSlackReads(inStreams).conversations[0].after).toBe(new Date(1794900000 * 1000).toISOString()); // the old behaviour: too early
    const all = [...inStreams, ...(await conversationParts(repo, inStreams))];
    expect(all).toHaveLength(2);
    expect(planTrackedSlackReads(all).conversations).toEqual([{ channel: 'D0JARON001', after: new Date(1794955300 * 1000).toISOString() }]);
    expect(a.item.id).toBe(inStreams[0].id);
  });
});
