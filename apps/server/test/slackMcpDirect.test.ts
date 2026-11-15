import { describe, expect, it } from 'vitest';
import { parseSlackMessages, parseSlackSearch, pollSlackDirect, selfIdFromTools } from '../src/integrations/slackMcp.js';

// Layouts as Slack's hosted MCP server returns them (names carry zero-width spaces; Slack Connect users have ", external: …").
const history = (channel: string, label: string, msgs: { name: string; email: string; uid: string; ts: string; text: string; ext?: boolean; replies?: number }[]) =>
  JSON.stringify({
    messages:
      `Channel: ${label} (${channel})\n\n` +
      msgs.map((m) => `=== Message from ${m.name} <${m.email}> (${m.uid}${m.ext ? ', external: Other’s Workspace' : ''}) at 2026-11-10 22:22:41 PST === \nMessage TS: ${m.ts}\n${m.text}${m.replies ? `\nThread: ${m.replies} replies (latest: 2026-11-12 06:11:36 PST)` : ''}`).join('\n\n'),
    pagination_info: 'There are no more messages.',
  });
const thread = (msgs: { name: string; email: string; uid: string; ts: string; text: string }[]) =>
  JSON.stringify({
    messages: `=== THREAD PARENT MESSAGE ===\nFrom: ${msgs[0].name} <${msgs[0].email}> (${msgs[0].uid})\nTime: 2026-11-12 04:17:33 PST\nMessage TS: ${msgs[0].ts}\n${msgs[0].text}\n\n` + (msgs.length > 1 ? `=== THREAD REPLIES (${msgs.length - 1}) ===\n\n` + msgs.slice(1).map((m) => `From: ${m.name} <${m.email}> (${m.uid})\nTime: 2026-11-12 05:00:00 PST\nMessage TS: ${m.ts}\n${m.text}`).join('\n\n') : 'No thread messsages\n'),
    pagination_info: 'There are no more messages in this thread.',
  });
const search = (hits: { channel: string; label: string; ts: string; uid: string; thread?: string }[]) =>
  JSON.stringify({
    results:
      '# Search Results for: \n\n## Messages (' +
      hits.length +
      ' results)\n' +
      hits
        .map((h, i) => `### Result ${i + 1} of ${hits.length}\nChannel: ${h.label} (ID: ${h.channel})\nFrom:  (ID: ${h.uid}) \nTime: 2026-11-10 21:51:32 PST\nMessage_ts: ${h.ts}\nPermalink: [link](https:\\/\\/x.slack.com\\/archives\\/${h.channel}\\/p${h.ts.replace('.', '')}${h.thread ? `?thread_ts=${h.thread}` : ''})\nText: \nhello\n\n---\n`)
        .join('\n'),
    pagination_info: 'End of results - No more pages available.',
  });

const ME = { userId: 'UME', email: 'scott@x.com' };
const NOW = 1794400000;

describe('parsing Slack MCP output', () => {
  it('channel history: both people, Slack Connect users, zero-width names, reply counts', () => {
    const r = parseSlackMessages(
      history('D1', 'DM', [
        { name: 'scott.​feit', email: 'scott@x.com', uid: 'UME', ts: '1794378161.277929', text: 'Hi Chris' },
        { name: 'chris', email: 'chris@other.com', uid: 'UCHRIS', ts: '1794377801.441879', text: 'Good. And the reports?', ext: true, replies: 2 },
      ]),
      ME,
    );
    expect(r.channelLabel).toBe('DM');
    expect(r.messages.map((m) => [m.id, m.author.name, m.author.slackUserId, m.isFromPU, m.text, m.replies])).toEqual([
      ['1794377801.441879', 'chris', 'UCHRIS', false, 'Good. And the reports?', 2],
      ['1794378161.277929', 'scott.feit', 'UME', true, 'Hi Chris', undefined],
    ]);
  });
  it('a thread: parent and replies, oldest first', () => {
    const r = parseSlackMessages(
      thread([
        { name: 'Pat', email: 'pat@x.com', uid: 'UPAT', ts: '100.000001', text: 'Office network is down' },
        { name: 'Scott', email: 'scott@x.com', uid: 'UME', ts: '101.000001', text: 'Looking' },
      ]),
      ME,
    );
    expect(r.messages.map((m) => [m.id, m.text, m.isFromPU])).toEqual([
      ['100.000001', 'Office network is down', false],
      ['101.000001', 'Looking', true],
    ]);
  });
  it('search results, with the thread from the permalink', () => {
    const r = parseSlackSearch(search([{ channel: 'C9', label: '#ops', ts: '5.000002', uid: 'UPAT', thread: '4.000001' }]));
    expect(r.hits).toEqual([{ channel: 'C9', channelLabel: '#ops', ts: '5.000002', threadTs: '4.000001', url: 'https://x.slack.com/archives/C9/p5000002?thread_ts=4.000001', fromUserId: 'UPAT' }]);
  });
  it("finds the PU's user id in the tool descriptions", () => {
    expect(selfIdFromTools([{ description: 'x' }, { description: "Searches. Current logged in user's user_id is U0CGTACCTHA.\n" }])).toBe('U0CGTACCTHA');
  });
});

describe('a direct poll (no Claude)', () => {
  it('collects mentions, DMs, watched channels and tracked threads as items', async () => {
    const calls: [string, any][] = [];
    const fake = async (tool: string, a: any) => {
      calls.push([tool, a]);
      if (tool === 'slack_search_public_and_private') {
        if (a.keywords?.[0] === '<@UME>') return search([{ channel: 'C9', label: '#ops', ts: `${NOW + 50}.000002`, uid: 'UPAT', thread: `${NOW + 10}.000001` }]);
        if (a.channel_types === 'im,mpim') return search([{ channel: 'D1', label: 'DM', ts: `${NOW + 20}.000001`, uid: 'UCHRIS' }, { channel: 'D1', label: 'DM', ts: `${NOW - 99999}.000001`, uid: 'UCHRIS' }]);
        return search([]);
      }
      if (tool === 'slack_search_channels') return JSON.stringify({ result: '### #sys-eng\n- **ID:** C777777777\n' });
      if (tool === 'slack_read_channel' && a.channel_id === 'D1') return history('D1', 'DM', [{ name: 'Chris', email: 'chris@o.com', uid: 'UCHRIS', ts: `${NOW + 20}.000001`, text: 'Any news?' }, { name: 'Chris', email: 'chris@o.com', uid: 'UCHRIS', ts: `${NOW - 500}.000001`, text: 'old' }]);
      if (tool === 'slack_read_channel' && a.channel_id === 'C777777777') return history('C777777777', '#sys-eng', [{ name: 'Jo', email: 'jo@x.com', uid: 'UJO', ts: `${NOW + 30}.000001`, text: 'Deploy broke', replies: 1 }]);
      if (tool === 'slack_read_thread') {
        if (a.channel_id === 'C9') return thread([{ name: 'Pat', email: 'pat@x.com', uid: 'UPAT', ts: `${NOW + 10}.000001`, text: 'Can you check?' }, { name: 'Pat', email: 'pat@x.com', uid: 'UPAT', ts: `${NOW + 50}.000002`, text: '<@UME> ping' }]);
        if (a.channel_id === 'C777777777') return thread([{ name: 'Jo', email: 'jo@x.com', uid: 'UJO', ts: `${NOW + 30}.000001`, text: 'Deploy broke' }]);
        if (a.channel_id === 'C5') return thread([{ name: 'Al', email: 'al@x.com', uid: 'UAL', ts: `${NOW - 900}.000001`, text: 'nothing new here' }]);
      }
      throw new Error(`unexpected ${tool} ${JSON.stringify(a)}`);
    };
    const r = await pollSlackDirect(fake, { since: NOW, puEmail: 'scott@x.com', me: 'UME', watched: ['sys-eng'], conversations: [], threads: [{ channel: 'C5', ts: `${NOW - 900}.000001` }] });
    const byId = Object.fromEntries(r.items.map((i) => [i.externalId, i]));
    expect(Object.keys(byId).sort()).toEqual([`C777777777:${NOW + 30}.000001`, `C9:${NOW + 10}.000001`, 'D1:dm']);
    expect(byId['D1:dm']).toMatchObject({ title: 'DM with Chris', data: { slack: { channel: 'D1' } } });
    expect(byId['D1:dm'].data.messages!.map((m) => m.text)).toEqual(['Any news?']); // only what's new
    expect(byId[`C9:${NOW + 10}.000001`]).toMatchObject({ title: '#ops: Can you check?', eventId: `C9:${NOW + 10}.000001@${NOW + 50}.000002`, data: { slack: { channel: 'C9', threadTs: `${NOW + 10}.000001` } } });
    // The tracked thread had nothing new, so nothing is passed on for it; the DM was read once although search found it twice.
    expect(calls.filter(([t, a]) => t === 'slack_read_channel' && a.channel_id === 'D1')).toHaveLength(1);
    expect(r.reads).toBe(calls.length);
  });
  it('a tracked DM is read from the newest message already held', async () => {
    const seen: any[] = [];
    await pollSlackDirect(
      async (tool, a) => {
        seen.push([tool, a]);
        return tool === 'slack_read_channel' ? history('D2', 'DM', []) : search([]);
      },
      { since: NOW, puEmail: 'scott@x.com', me: 'UME', watched: [], conversations: [{ channel: 'D2', after: new Date((NOW - 3600) * 1000).toISOString() }], threads: [] },
    );
    expect(seen.find(([t]) => t === 'slack_read_channel')[1]).toMatchObject({ channel_id: 'D2', oldest: String(NOW - 3600) });
  });
});

describe('checks that still use Claude', () => {
  it('are told which messages are already held, so they are not copied out again', async () => {
    const { openDatabase } = await import('../src/db/index.js');
    const { Repo } = await import('../src/core/repo.js');
    const { defaultSettings } = await import('../src/core/settings.js');
    const { McpPollIngestor } = await import('../src/agent/mcpIngest.js');
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'thread-1', title: 'Budget', data: { messages: [{ id: 'm1', author: { name: 'Dana' }, text: 'x', at: new Date().toISOString() }, { id: 'm2', author: { name: 'Dana' }, text: 'y', at: new Date(Date.now() + 1000).toISOString() }] } });
    const s = defaultSettings();
    s.google = { ...s.google, mode: 'mcp', mcp: { transport: 'http', url: 'https://mcp.example/mcp', readOnlyPatterns: ['read'] } as any };
    const prompts: string[] = [];
    const backend = { structured: async (i: any) => (prompts.push(i.prompt), { items: [] }) } as any;
    const ing = new McpPollIngestor('google', backend, async () => s, { get: async () => '' } as any, repo, async () => undefined, () => undefined);
    await ing.pollOnce();
    expect(prompts[0]).toMatch(/Already collected[\s\S]*- thread-1: up to message m2/);
  });
});
