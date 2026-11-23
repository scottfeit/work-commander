import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { Executor } from '../src/core/executor.js';
import { buildQuickReply } from '../src/core/quickReply.js';

const NAME = '#mpdm-mohan.p--scott.feit--jaron.brass-1';
const msg = (id: string, who: string, at: string, pu = false) => ({ id, author: { name: who }, text: `from ${who}`, at, isFromPU: pu });

describe('a group DM is one conversation', () => {
  let repo: Repo;
  let streamId: string;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    streamId = (await repo.createStream({ title: 's', summary: '' })).id;
    // As WC first held it: keyed by the first message, though nobody replied in a thread.
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0GRP:100.000001', title: `${NAME}: hi`, data: { messages: [msg('100.000001', 'Mohan', '2026-11-23T15:29:10Z'), msg('101.000001', 'Jaron', '2026-11-23T20:58:10Z')], slack: { channel: 'C0GRP', channelName: NAME, threadTs: '100.000001' } }, streamId });
  });

  it('is recognised by its name, though its id starts with C and its item is keyed by a message', async () => {
    const family = await repo.slackFamily('C0GRP');
    expect(Repo.slackIsFlat('C0GRP', family)).toBe(true);
    expect(Repo.slackIsFlat('C0CHAN', [{ ...family[0], data: { ...family[0].data, slack: { channel: 'C0CHAN', channelName: '#sys-eng', threadTs: '' } } }])).toBe(false);
  });

  it('Quick Reply on it does not start a thread', async () => {
    const item = (await repo.listItems(streamId))[0];
    const d = buildQuickReply(item, { ...defaultSettings(), slack: { ...defaultSettings().slack, mode: 'api' as const } } as any);
    expect(d.payload.thread_ts).toBeUndefined();
    expect(d.payload.channel).toBe('C0GRP');
  });

  it('a message posted into it (no thread) joins its existing item instead of making a new one', async () => {
    const sentTs = '102.000001';
    const chat = {
      postMessage: async () => ({ channel: 'C0GRP', ts: sentTs }),
      getThread: async (c: string, t: string) => ({ source: 'slack', kind: 'slack_thread', externalId: `${c}:${t}`, title: `${NAME}: sent`, eventId: `${c}:${t}`, data: { messages: [msg(t, 'Scott', '2026-11-23T21:48:14Z', true)], slack: { channel: c, channelName: NAME, threadTs: t } } }),
      getDmConversation: async (c: string) => ({ source: 'slack', kind: 'slack_thread', externalId: `${c}:dm`, title: NAME, eventId: `${c}:dm`, data: { messages: [msg(sentTs, 'Scott', '2026-11-23T21:48:14Z', true)], slack: { channel: c, channelName: NAME, threadTs: sentTs } } }),
    };
    const hub = { api: async () => chat } as any;
    const ex = new Executor(repo, hub, {} as any, async () => defaultSettings(), {} as any, () => async () => '');
    const p = await repo.createProposal({ streamId, runId: 'quick-1', kind: 'slack_post', system: 'slack', title: 'q', rationale: '', payload: { channel: 'C0GRP', text: 'hello', quick: true }, editable: [], quick: true } as any);
    await ex.approve(p.id, { channel: 'C0GRP', text: 'hello', quick: true });
    await new Promise((r) => setTimeout(r, 50));
    const items = await repo.listItems(streamId);
    expect(items).toHaveLength(1);
    expect(items[0].data.messages!.map((m) => m.id)).toEqual(['100.000001', '101.000001', sentTs]);
  });
});
