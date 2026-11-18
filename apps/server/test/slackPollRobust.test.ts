import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { SlackIngestor } from '../src/integrations/slack.js';

const gone = () => Object.assign(new Error('An API error occurred: thread_not_found'), { data: { error: 'thread_not_found' } });

describe('the Slack API poll', () => {
  let repo: Repo;
  let calls: { fn: string; args: any }[];
  let statuses: string[];
  let sunk: string[];
  const make = (opts: { tracked?: string[]; replies?: (a: any) => any } = {}) => {
    const slack: any = {
      selfUserId: async () => 'UME',
      search: async () => [],
      getThread: async (c: string, t: string) => ({ source: 'slack', kind: 'slack_thread', externalId: `${c}:${t}`, title: 't', data: { messages: [] }, eventId: `${c}:${t}` }),
      web: {
        conversations: {
          list: async () => ({ channels: [{ id: 'G1', is_im: false }] }),
          history: async (a: any) => (calls.push({ fn: 'history', args: a }), { messages: [] }),
          replies: async (a: any) => (calls.push({ fn: 'replies', args: a }), opts.replies ? opts.replies(a) : { messages: [{ ts: String(Date.now() / 1000 + 5), user: 'U2' }] }),
        },
      },
    };
    return new SlackIngestor(slack, { ingestion: 'polling', pollSeconds: 30, watchedChannels: '' } as any, null, repo, async () => new Set(opts.tracked ?? []), async (i) => void sunk.push(i.externalId), (ok, m) => statuses.push(`${ok}:${m}`));
  };
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    calls = [];
    statuses = [];
    sunk = [];
  });

  it('after a switch from MCP, starts where MCP left off, not three days back', async () => {
    const mcpSince = new Date(Date.now() - 3600_000).toISOString();
    await repo.setSync('mcp.slack.since', mcpSince);
    await make().pollOnce();
    const oldest = Number(calls.find((c) => c.fn === 'history')!.args.oldest) + 7 * 86_400; // the poll looks a week before its starting point
    expect(oldest).toBeCloseTo(Date.parse(mcpSince) / 1000 - 600, -1);
  });
  it('a saved bookmark wins; with neither, a first run reads three days', async () => {
    await repo.setSync('slack.lastTs', '1700000000');
    await repo.setSync('mcp.slack.since', new Date().toISOString());
    await make().pollOnce();
    expect(Number(calls.find((c) => c.fn === 'history')!.args.oldest) + 7 * 86_400).toBe(1700000000);
    calls = [];
    const fresh = new Repo((await openDatabase('sqlite::memory:')).db);
    repo = fresh;
    await make().pollOnce();
    const days = (Date.now() / 1000 - (Number(calls.find((c) => c.fn === 'history')!.args.oldest) + 7 * 86_400)) / 86_400;
    expect(days).toBeCloseTo(3, 1);
  });

  it('one thread Slack cannot find does not stop the others or the bookmark', async () => {
    await make({
      tracked: ['C1:111.1', 'C1:222.2', 'C1:333.3'],
      replies: (a) => {
        if (a.ts === '222.2') throw gone();
        return { messages: [{ ts: String(Date.now() / 1000 + 5), user: 'U2' }] };
      },
    }).pollOnce();
    expect(calls.filter((c) => c.fn === 'replies').map((c) => c.args.ts)).toEqual(['111.1', '222.2', '333.3']); // all three were tried
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
