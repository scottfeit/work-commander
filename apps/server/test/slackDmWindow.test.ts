import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { SlackWorkspace } from '../src/integrations/slack.js';
import { refreshItem } from '../src/core/refreshItem.js';

const NOW = Math.floor(Date.now() / 1000);
const ts = (daysAgo: number) => `${NOW - daysAgo * 86_400}.000100`;

/** A Slack workspace whose DM has months of history, a thread with an old and a new reply, and one message from today. */
const workspace = () => {
  const w: any = new SlackWorkspace('xoxp-test');
  const history = [
    { ts: ts(200), user: 'U2', text: 'old chat in April' },
    { ts: ts(30), user: 'U2', text: 'IT-75214 came up last month' },
    { ts: ts(2), user: 'U2', text: 'a thread', reply_count: 2, latest_reply: ts(0.01), thread_ts: ts(2) },
    { ts: ts(0.02), user: 'U2', text: 'new message today' },
  ];
  const replies = [history[2], { ts: ts(1), user: 'U1', text: 'old reply', thread_ts: ts(2) }, { ts: ts(0.01), user: 'U2', text: 'new reply', thread_ts: ts(2) }];
  w.uid = 'U1';
  w.names.set('U1', { name: 'Scott' });
  w.names.set('U2', { name: 'Martin' });
  w.web = { conversations: { history: async () => ({ messages: [...history].reverse() }), replies: async () => ({ messages: replies }), info: async () => ({ channel: { user: 'U2' } }) } };
  w.channelName = async () => 'DM with Martin';
  w.render = async (t: string) => t;
  return w as SlackWorkspace;
};

describe('a DM read by the Slack API poll', () => {
  it('brings only what is newer than the poll’s starting point, including newer thread replies', async () => {
    const got = await workspace().getDmConversation('D1', undefined, NOW - 43_200);
    expect(got.data.messages!.map((m) => m.text)).toEqual(['new message today', 'new reply']); // oldest first
  });
  it('without a starting point (an explicit read) it is the whole recent conversation, as before', async () => {
    const got = await workspace().getDmConversation('D1');
    expect(got.data.messages!.map((m) => m.text)).toContain('old chat in April');
  });
});

describe('refreshing a DM item', () => {
  it('only brings in what is newer than what the item holds', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const stream = (await repo.createStream({ title: 'S', summary: '' })).id;
    const held = { id: ts(2), author: { name: 'Martin' }, text: 'a thread', at: new Date((NOW - 2 * 86_400) * 1000).toISOString() };
    const item = (await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'D1:dm', title: 'DM', data: { messages: [held], slack: { channel: 'D1', threadTs: held.id } }, streamId: stream })).item;
    const w = workspace();
    const hub: any = { systemMode: async () => 'api', api: async () => w };
    const out = await refreshItem({ repo, hub }, item);
    expect(out.data.messages!.map((m) => m.text)).not.toContain('old chat in April');
    expect(out.data.messages!.map((m) => m.text)).toContain('new message today');
  });
});

describe('linking a conversation to a ticket’s stream by what it has just said', () => {
  let repo: Repo;
  let closedId: string;
  let t: TriagePipeline;
  const decision = { relevant: false, reason: 'r', stream: { action: 'none', streamId: null, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
  const dm = (messages: { id: string; text: string; at: string }[]) => ({ source: 'slack' as const, kind: 'slack_thread' as const, externalId: 'D1:dm', title: 'DM with Martin', eventId: `e${messages.length}${messages[messages.length - 1].id}`, data: { messages: messages.map((m) => ({ ...m, author: { name: 'Martin' } })), slack: { channel: 'D1', threadTs: messages[0].id } } });
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    t = new TriagePipeline(repo, { structured: async () => decision } as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), claude: { ...defaultSettings().claude, splitSlackByTopic: false } }));
    closedId = (await repo.createStream({ title: 'IT-75214 LDAP attribute', summary: 'fix' })).id;
    await repo.upsertItem({ source: 'jsm', kind: 'ticket', externalId: 'IT-75214', title: 'IT-75214: LDAP', data: { ticket: { key: 'IT-75214', flavor: 'jsm', status: 'Closed', summary: 's', comments: [] } }, streamId: closedId } as any);
    await repo.updateStream(closedId, { status: 'closed' });
  });
  const at = (d: number) => new Date((NOW - d * 86_400) * 1000).toISOString();

  it('an old mention in months of history does not pull a new DM into the closed stream', async () => {
    // the DM is known (unattached), and its old history mentions IT-75214
    await repo.upsertItem(dm([{ id: ts(30), text: 'IT-75214 came up last month', at: at(30) }]));
    await t.handle(dm([{ id: ts(30), text: 'IT-75214 came up last month', at: at(30) }, { id: ts(0.02), text: 'unrelated: Okta alert', at: at(0.02) }]));
    expect((await repo.findItem('slack', 'D1:dm'))!.streamId).toBeNull();
  });
  it('a mention in what it has just said does link it', async () => {
    await repo.upsertItem(dm([{ id: ts(30), text: 'hello', at: at(30) }]));
    await t.handle(dm([{ id: ts(30), text: 'hello', at: at(30) }, { id: ts(0.02), text: 'any news on IT-75214?', at: at(0.02) }]));
    expect((await repo.findItem('slack', 'D1:dm'))!.streamId).toBe(closedId);
  });
});
