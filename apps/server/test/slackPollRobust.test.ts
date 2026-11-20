import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { SlackIngestor } from '../src/integrations/slack.js';

const gone = () => Object.assign(new Error('An API error occurred: thread_not_found'), { data: { error: 'thread_not_found' } });
const OVERLAP = 600;
const NOW = () => Date.now() / 1000;

describe('the Slack API poll', () => {
  let repo: Repo;
  let calls: { fn: string; args: any }[];
  let statuses: string[];
  let sunk: string[];
  const make = (
    opts: {
      tracked?: string[];
      replies?: (a: any) => any;
      /** DM channels with a message newer than any bookmark, as search reports them. */
      dmHits?: string[];
      searchFails?: boolean;
      listed?: string[];
      /** Watched channels, and which channels each of Slack's lists returns (name -> id). */
      watched?: string;
      member?: Record<string, string>;
      workspace?: Record<string, string>;
      /** Messages per channel id for the watched-channel history reads. */
      channelMsgs?: Record<string, any[]>;
    } = {},
  ) => {
    const slack: any = {
      selfUserId: async () => 'UME',
      search: async (q: string, max: number, page = 1) => {
        calls.push({ fn: 'search', args: { q, max, page } });
        if (q.startsWith('is:dm')) {
          if (opts.searchFails) throw new Error('missing_scope');
          return page === 1 ? (opts.dmHits ?? []).map((c) => ({ channel: c, ts: String(NOW() - 5) })) : [];
        }
        return [];
      },
      getThread: async (c: string, t: string) => ({ source: 'slack', kind: 'slack_thread', externalId: `${c}:${t}`, title: 't', data: { messages: [] }, eventId: `${c}:${t}` }),
      getDmConversation: async (c: string) => ({ source: 'slack', kind: 'slack_thread', externalId: `${c}:dm`, title: 'dm', data: { messages: [] }, eventId: `${c}:dm` }),
      web: {
        users: { conversations: async (a: any) => (calls.push({ fn: 'member', args: a }), { channels: Object.entries(opts.member ?? {}).map(([name, id]) => ({ id, name })) }) },
        conversations: {
          list: async (a: any) => (calls.push({ fn: 'list', args: a }), { channels: opts.workspace ? Object.entries(opts.workspace).map(([name, id]) => ({ id, name })) : (opts.listed ?? []).map((id) => ({ id })) }),
          history: async (a: any) => (calls.push({ fn: 'history', args: a }), { messages: opts.channelMsgs?.[a.channel] ?? [{ ts: String(NOW() - 5), user: 'U2' }] }),
          replies: async (a: any) => (calls.push({ fn: 'replies', args: a }), opts.replies ? opts.replies(a) : { messages: [{ ts: String(NOW() + 5), user: 'U2' }] }),
        },
      },
    };
    return new SlackIngestor(slack, { ingestion: 'polling', pollSeconds: 30, watchedChannels: opts.watched ?? '' } as any, null, repo, async () => new Set(opts.tracked ?? []), async (i) => void sunk.push(i.externalId), (ok, m) => statuses.push(`${ok}:${m}`));
  };
  const historyOldest = () => Number(calls.find((c) => c.fn === 'history')!.args.oldest) + 7 * 86_400; // a poll looks a week before its starting point
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    calls = [];
    statuses = [];
    sunk = [];
  });

  describe('where it starts', () => {
    it('after a switch from MCP, where MCP left off (less the overlap), not three days back', async () => {
      const mcpSince = new Date(Date.now() - 3600_000).toISOString();
      await repo.setSync('mcp.slack.since', mcpSince);
      await make({ dmHits: ['D1'] }).pollOnce();
      expect(historyOldest()).toBeCloseTo(Date.parse(mcpSince) / 1000 - OVERLAP, -1);
    });
    it('a saved bookmark (less the overlap) wins; with neither, a first run reads three days', async () => {
      await repo.setSync('slack.lastTs', '1700000000');
      await repo.setSync('mcp.slack.since', new Date().toISOString());
      await make({ dmHits: ['D1'] }).pollOnce();
      expect(historyOldest()).toBe(1700000000 - OVERLAP);
      calls = [];
      repo = new Repo((await openDatabase('sqlite::memory:')).db);
      await make({ dmHits: ['D1'] }).pollOnce();
      expect((NOW() - historyOldest()) / 86_400).toBeCloseTo(3, 1);
    });
    it('the bookmark saved is when the poll began, not the newest message it saw', async () => {
      const before = NOW();
      await make({ dmHits: ['D1'] }).pollOnce();
      const saved = Number(await repo.getSync('slack.lastTs'));
      expect(saved).toBeGreaterThanOrEqual(before - 1);
      expect(saved).toBeLessThan(NOW() + 1);
    });
  });

  describe('finding DMs', () => {
    it('reads the DMs and group DMs that search says have news, however many conversations exist', async () => {
      await make({ dmHits: ['D04DPN6NQHW', 'C0GROUP0001'], listed: Array.from({ length: 150 }, (_, i) => `D${i}`) }).pollOnce();
      expect(calls.filter((c) => c.fn === 'history').map((c) => c.args.channel).sort()).toEqual(['C0GROUP0001', 'D04DPN6NQHW']);
      expect(calls.some((c) => c.fn === 'list')).toBe(false); // the conversation list is not walked
      expect(sunk).toContain('D04DPN6NQHW:dm'); // a 1:1 DM is one conversation item
    });
    it('a group DM whose id starts with C is one conversation too, and your own messages alone update it', async () => {
      await make({ dmHits: ['C0GROUP0001'], channelMsgs: { C0GROUP0001: [{ ts: String(NOW() - 5), user: 'UME' }] } }).pollOnce();
      expect(sunk).toEqual(['C0GROUP0001:dm']);
    });
    it('asks search for DMs since the starting day', async () => {
      await repo.setSync('slack.lastTs', String(Date.parse('2026-11-18T12:00:00Z') / 1000));
      await make().pollOnce();
      expect(calls.find((c) => c.fn === 'search' && c.args.q.startsWith('is:dm'))!.args).toMatchObject({ q: 'is:dm after:2026-11-17', max: 100, page: 1 });
    });
    it('if search is unavailable, falls back to the conversation list', async () => {
      await make({ searchFails: true, listed: ['D7', 'C0GROUP0002'] }).pollOnce();
      expect(calls.filter((c) => c.fn === 'history').map((c) => c.args.channel).sort()).toEqual(['C0GROUP0002', 'D7']);
      expect(statuses[0]).toBe('true:Slack synced');
    });
  });

  describe('watched channels', () => {
    const msg = (user: string, text = 'hi') => ({ ts: String(NOW() - 5), user, text });
    it('finds a channel among the ones you are in, without walking the workspace list', async () => {
      await make({ watched: '#sys-eng, #helpdesk', member: { 'sys-eng': 'C0274PW81B6', helpdesk: 'C0CFGV9BFT3' }, channelMsgs: { C0274PW81B6: [msg('URF3APG1W')], C0CFGV9BFT3: [] } }).pollOnce();
      expect(calls.some((c) => c.fn === 'list')).toBe(false);
      expect(calls.filter((c) => c.fn === 'history').map((c) => c.args.channel)).toEqual(['C0274PW81B6', 'C0CFGV9BFT3']);
      expect(sunk.some((x) => x.startsWith('C0274PW81B6:'))).toBe(true); // Jaron's message was taken in
      expect(statuses[0]).toBe('true:Slack synced');
    });
    it('a channel you are not in is looked for in the workspace list', async () => {
      await make({ watched: 'announcements-global', member: { 'sys-eng': 'C0274PW81B6' }, workspace: { 'announcements-global': 'C024FDXFL' }, channelMsgs: { C024FDXFL: [msg('U2')] } }).pollOnce();
      expect(calls.some((c) => c.fn === 'list')).toBe(true);
      expect(calls.some((c) => c.fn === 'history' && c.args.channel === 'C024FDXFL')).toBe(true);
    });
    it('your own messages in a watched channel are not new work', async () => {
      await make({ watched: 'sys-eng', member: { 'sys-eng': 'C0274PW81B6' }, channelMsgs: { C0274PW81B6: [msg('UME', 'my own note')] } }).pollOnce();
      expect(sunk).toEqual([]);
    });
    it('a name found nowhere is said so in the status, and is looked for again next poll', async () => {
      const ing = make({ watched: 'ghost, sys-eng', member: { 'sys-eng': 'C0274PW81B6' }, workspace: {}, channelMsgs: { C0274PW81B6: [] } });
      await ing.pollOnce();
      expect(statuses[0]).toBe('true:Slack synced (could not find watched channel(s): #ghost)');
      const lists = calls.filter((c) => c.fn === 'member').length;
      await ing.pollOnce();
      expect(calls.filter((c) => c.fn === 'member').length).toBe(lists + 1);
    });
    it('once every name is found, they are remembered for a while', async () => {
      const ing = make({ watched: 'sys-eng', member: { 'sys-eng': 'C0274PW81B6' }, channelMsgs: { C0274PW81B6: [] } });
      await ing.pollOnce();
      await ing.pollOnce();
      expect(calls.filter((c) => c.fn === 'member')).toHaveLength(1);
    });
  });

  describe('failures', () => {
    it('one thread Slack cannot find does not stop the others or the bookmark', async () => {
      await make({
        tracked: ['C1:111.1', 'C1:222.2', 'C1:333.3'],
        replies: (a) => {
          if (a.ts === '222.2') throw gone();
          return { messages: [{ ts: String(NOW() + 5), user: 'U2' }] };
        },
      }).pollOnce();
      expect(calls.filter((c) => c.fn === 'replies').map((c) => c.args.ts)).toEqual(['111.1', '222.2', '333.3']);
      expect(sunk.sort()).toEqual(['C1:111.1', 'C1:333.3']);
      expect(await repo.getSync('slack.lastTs')).toBeTruthy();
      expect(statuses[0]).toMatch(/^true:Slack synced \(skipped 1 thread\(s\) Slack could not read: C1:222\.2\)/);
    });
    it('a DM item ("<channel>:dm") is not a thread and is not asked for as one', async () => {
      await make({ tracked: ['C0GROUP001:dm', 'D0ONE000001:dm@abc', 'C1:111.1'] }).pollOnce();
      expect(calls.filter((c) => c.fn === 'replies').map((c) => c.args.ts)).toEqual(['111.1']);
      expect(statuses[0]).toBe('true:Slack synced');
    });
    it('any other failure still stops the poll and leaves the bookmark where it was', async () => {
      await make({ tracked: ['C1:111.1'], replies: () => { throw new Error('ratelimited'); } }).pollOnce();
      expect(await repo.getSync('slack.lastTs')).toBeNull();
      expect(statuses[0]).toMatch(/^false:Slack: ratelimited/);
    });
  });
});
