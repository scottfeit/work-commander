import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { SlackWorkspace } from '../src/integrations/slack.js';

const msg = (id: string, reactions?: { name: string; count: number; mine: boolean }[]) => ({ id, author: { name: 'Dana', slackUserId: 'UD' }, text: 'x', at: new Date().toISOString(), ...(reactions ? { reactions } : {}) });

describe('keeping Slack reactions in step', () => {
  let repo: Repo;
  let itemId: string;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    itemId = (await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0DEPLOY1:1.1', title: 'T', data: { slack: { channel: 'C0DEPLOY1', threadTs: '1.1' }, messages: [msg('1.1', [{ name: 'tada', count: 1, mine: true }]), msg('1.2')] } })).item.id;
  });
  const reactions = async (i: number) => (await repo.getItem(itemId))!.data.messages![i].reactions;

  it('events: removed in Slack by the PU takes theirs back; others add and remove; nothing else changes', async () => {
    await repo.applySlackReactions('C0DEPLOY1', { ts: '1.1', name: 'tada', added: false, byPU: true });
    expect(await reactions(0)).toBeUndefined();
    await repo.applySlackReactions('C0DEPLOY1', { ts: '1.2', name: 'eyes', added: true, byPU: false });
    await repo.applySlackReactions('C0DEPLOY1', { ts: '1.2', name: 'eyes', added: true, byPU: false });
    expect(await reactions(1)).toEqual([{ name: 'eyes', count: 2, mine: false }]);
    await repo.applySlackReactions('C0DEPLOY1', { ts: '1.2', name: 'eyes', added: false, byPU: false });
    expect(await reactions(1)).toEqual([{ name: 'eyes', count: 1, mine: false }]);
    expect((await repo.getItem(itemId))!.data.unread).toBeUndefined(); // not new activity
  });

  it("WC's own reaction echoed back by Slack isn't counted twice", async () => {
    await repo.applySlackReactions('C0DEPLOY1', { ts: '1.1', name: 'tada', added: true, byPU: true });
    expect(await reactions(0)).toEqual([{ name: 'tada', count: 1, mine: true }]);
    await repo.applySlackReactions('C0DEPLOY1', { ts: '1.2', name: 'tada', added: false, byPU: true }); // not there: no-op
    expect(await reactions(1)).toBeUndefined();
  });

  it('a sync replaces the reactions with what Slack has now, and says whether anything changed', async () => {
    expect(await repo.applySlackReactions('C0DEPLOY1', { set: new Map([['1.1', []], ['1.2', [{ name: 'rocket', count: 1, mine: false }]]]) })).toEqual([itemId]);
    expect(await reactions(0)).toBeUndefined();
    expect(await reactions(1)).toEqual([{ name: 'rocket', count: 1, mine: false }]);
    expect(await repo.applySlackReactions('C0DEPLOY1', { set: new Map([['1.2', [{ name: 'rocket', count: 1, mine: false }]]]) })).toEqual([]);
  });

  it("Slack: one replies call for a thread; the history call for what the thread doesn't hold", async () => {
    const calls: string[] = [];
    const sl = new SlackWorkspace('xoxp-test');
    (sl as any).uid = 'UME';
    sl.web = {
      conversations: {
        replies: async () => (calls.push('replies'), { messages: [{ ts: '1.1', reactions: [{ name: 'eyes', count: 1, users: ['UME'] }] }] }),
        history: async (a: any) => (calls.push(`history ${a.oldest}-${a.latest}`), { messages: [{ ts: '2.5', reactions: [] }] }),
      },
    } as any;
    const got = await sl.reactionsFor('C1', '1.1', ['1.1', '2.5']);
    expect(calls).toEqual(['replies', 'history 2.5-2.5']);
    expect([...got]).toEqual([
      ['1.1', [{ name: 'eyes', count: 1, mine: true }]],
      ['2.5', []],
    ]);
  });
});
