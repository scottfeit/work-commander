import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { slackBaseOf, slackMessageUrl } from '../src/integrations/slackUrl.js';

const msg = (ts: string, text = 't') => ({ id: ts, author: { name: 'A' }, text, at: new Date(Number(ts) * 1000).toISOString() });
const dm = (messages: ReturnType<typeof msg>[], extra: any = {}) => ({ source: 'slack' as const, kind: 'slack_thread' as const, externalId: 'C0GROUP001:dm', title: 'Group DM', data: { messages, slack: { channel: 'C0GROUP001', threadTs: messages[0].id } }, ...extra });

describe('Open-in-Slack links for DM and group DM items', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('builds a message link and reads the workspace from any Slack link', () => {
    expect(slackMessageUrl('https://bv.slack.com/', 'C0A', '1794928254.827089')).toBe('https://bv.slack.com/archives/C0A/p1794928254827089');
    expect(slackBaseOf('https://bv.slack.com/archives/C0A/p1')).toBe('https://bv.slack.com');
    expect(slackBaseOf('https://example.com/x')).toBeNull();
    expect(slackBaseOf('nonsense')).toBeNull();
  });

  it('a DM gets a link to its latest message once the workspace is known, and the link follows new messages', async () => {
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0CHAN0001:1700000000.000100', title: '#chan: hi', url: 'https://bv.slack.com/archives/C0CHAN0001/p1700000000000100', data: { messages: [msg('1700000000.000100')] } });
    const first = await repo.upsertItem(dm([msg('1794928254.827089')]));
    expect(first.item.url).toBe('https://bv.slack.com/archives/C0GROUP001/p1794928254827089');
    const next = await repo.upsertItem(dm([msg('1794928254.827089'), msg('1794928300.000200')]));
    expect(next.item.url).toBe('https://bv.slack.com/archives/C0GROUP001/p1794928300000200');
    expect((await repo.getItem(next.item.id))!.url).toBe(next.item.url);
  });

  it('a channel thread keeps the link it was given', async () => {
    const r = await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0CHAN0001:1700000000.000100', title: 'x', url: 'https://bv.slack.com/archives/C0CHAN0001/p1700000000000100', data: { messages: [msg('1700000000.000100'), msg('1700000100.000100')] } });
    expect(r.item.url).toBe('https://bv.slack.com/archives/C0CHAN0001/p1700000000000100');
  });

  it('a link in a DM item’s own hit teaches the workspace, and moved messages keep the item linked', async () => {
    const a = (await repo.createStream({ title: 'A', summary: '' })).id;
    const b = (await repo.createStream({ title: 'B', summary: '' })).id;
    const it = await repo.upsertItem(dm([msg('1794928254.827089'), msg('1794928300.000200')], { url: 'https://bv.slack.com/archives/C0GROUP001/p1794928254827089', streamId: a }));
    expect(it.item.url).toBe('https://bv.slack.com/archives/C0GROUP001/p1794928300000200');
    const moved = await repo.placeSlackMessages({ channel: 'C0GROUP001', toStreamId: b, messages: [msg('1794928300.000200')], title: 'Group DM' });
    expect(moved.item!.url).toBe('https://bv.slack.com/archives/C0GROUP001/p1794928300000200');
    expect((await repo.listItems(a))[0].url).toBe('https://bv.slack.com/archives/C0GROUP001/p1794928254827089'); // what stayed behind points at its own latest message
  });

  it('fills in links for items stored before, once the workspace is known', async () => {
    await repo.upsertItem(dm([msg('1794928254.827089')])); // no workspace known yet: no link
    expect((await repo.slackFamily('C0GROUP001'))[0].url).toBeUndefined();
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0CHAN0001:1700000000.000100', title: 'x', url: 'https://bv.slack.com/archives/C0CHAN0001/p1700000000000100', data: { messages: [msg('1700000000.000100')] } });
    expect(await repo.fillSlackUrls()).toBe(1);
    expect((await repo.slackFamily('C0GROUP001'))[0].url).toBe('https://bv.slack.com/archives/C0GROUP001/p1794928254827089');
    expect(await repo.fillSlackUrls()).toBe(0);
  });
});

describe('the local copy of a message the PU sent gives way to the real one', () => {
  it('even when the real message is worded differently, because the copy is named after it', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const base = { source: 'slack' as const, kind: 'slack_thread' as const, externalId: 'D0ONE00001:dm', title: 'DM' };
    await repo.upsertItem({ ...base, data: { messages: [msg('1700000000.000100'), { ...msg('1700000100.000200', 'Hi Tina, 14 days.'), id: 'sent-1700000100.000200', isFromPU: true }] } });
    const r = await repo.upsertItem({ ...base, data: { messages: [msg('1700000000.000100'), { ...msg('1700000100.000200', 'Hi Tina, 14 days.\n\n(rendered a little differently)\n*Sent using* Work Commander'), isFromPU: true }] } });
    expect(r.item.data.messages!.map((m) => m.id)).toEqual(['1700000000.000100', '1700000100.000200']);
    expect(r.newMessages).toHaveLength(0); // an echo of its own send is not news
  });
});
