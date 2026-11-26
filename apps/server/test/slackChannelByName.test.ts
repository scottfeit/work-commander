import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { Executor } from '../src/core/executor.js';
import { SlackWorkspace } from '../src/integrations/slack.js';

describe('a Slack channel typed as a name', () => {
  let calls: { fn: string; args: any }[];
  const make = (opts: { member?: Record<string, string>; workspace?: Record<string, string> } = {}) => {
    const ws = new SlackWorkspace('xoxp-test');
    (ws as any).uid = 'UME';
    (ws as any).web = {
      users: { conversations: async (a: any) => (calls.push({ fn: 'member', args: a }), { channels: Object.entries(opts.member ?? {}).map(([name, id]) => ({ id, name })) }) },
      conversations: {
        list: async (a: any) => (calls.push({ fn: 'list', args: a }), { channels: Object.entries(opts.workspace ?? {}).map(([name, id]) => ({ id, name })) }),
        replies: async (a: any) => (calls.push({ fn: 'replies', args: a }), a.channel.startsWith('C') ? { messages: [{ ts: a.ts, user: 'UME', text: 'hi' }] } : Promise.reject(Object.assign(new Error('channel_not_found'), { data: { error: 'channel_not_found' } }))),
        info: async () => ({ channel: { name: 'biztech-user-coordination' } }),
      },
      chat: {
        postMessage: async (a: any) => (calls.push({ fn: 'postMessage', args: a }), { ok: true, ts: '100.000001', channel: a.channel.startsWith('C') ? a.channel : 'CFROMSLACK1' }),
        getPermalink: async (a: any) => (calls.push({ fn: 'permalink', args: a }), { permalink: `https://x.slack.com/archives/${a.channel}/p1` }),
      },
      users2: {},
    };
    (ws as any).user = async () => ({ name: 'Scott' });
    (ws as any).render = async (t: string) => t;
    return ws;
  };
  beforeEach(() => {
    calls = [];
  });

  it('is looked up among your channels, then the workspace; ids are left alone', async () => {
    const ws = make({ member: { general: 'C0GEN0001' }, workspace: { 'biztech-user-coordination': 'C01GLRN9SL8' } });
    expect(await ws.resolveChannel('C0ABCDEF1')).toBe('C0ABCDEF1');
    expect(await ws.resolveChannel('#general')).toBe('C0GEN0001');
    expect(await ws.resolveChannel('#BizTech-User-Coordination')).toBe('C01GLRN9SL8'); // found in the workspace list, whatever the case
    expect(await ws.resolveChannel('#nowhere')).toBeNull();
  });

  it('a post to "#name" goes to the id, and the result carries the id (so reading it back and its link work)', async () => {
    const r = await make({ member: { 'biztech-user-coordination': 'C01GLRN9SL8' } }).postMessage({ channel: '#biztech-user-coordination', text: 'hi' });
    expect(calls.find((c) => c.fn === 'postMessage')!.args.channel).toBe('C01GLRN9SL8');
    expect(r.channel).toBe('C01GLRN9SL8');
    expect(calls.find((c) => c.fn === 'permalink')!.args.channel).toBe('C01GLRN9SL8');
  });

  it('a name that cannot be found is still posted as typed, and the id Slack answers with is used', async () => {
    const r = await make().postMessage({ channel: '#private-one', text: 'hi' });
    expect(calls.find((c) => c.fn === 'postMessage')!.args.channel).toBe('#private-one');
    expect(r.channel).toBe('CFROMSLACK1');
  });

  it('reading a thread by name finds the channel too', async () => {
    const t = await make({ member: { 'biztech-user-coordination': 'C01GLRN9SL8' } }).getThread('#biztech-user-coordination', '100.000001');
    expect(t.externalId).toBe('C01GLRN9SL8:100.000001');
  });
});

describe('a sent message that cannot be shown in the stream yet', () => {
  it('says so in the stream\'s chat, and the draft is still reported as sent', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const streamId = (await repo.createStream({ title: 's', summary: '' })).id;
    const chat = { postMessage: async () => ({ channel: 'C1', ts: '1.1' }), getThread: async () => { throw new Error('channel_not_found'); } };
    const ex = new Executor(repo, { api: async () => chat } as any, {} as any, async () => defaultSettings(), {} as any, () => async () => '');
    const p = await repo.createProposal({ streamId, runId: 'run1', kind: 'slack_post', system: 'slack', title: 'q', rationale: '', payload: { channel: '#x', text: 'hello' }, editable: [] } as any);
    const done = await ex.approve(p.id, { channel: '#x', text: 'hello' });
    expect(done.status).toBe('executed');
    expect((await repo.listChat(streamId)).some((m) => /It was sent, but I could not add it to this work stream yet \(channel_not_found\)/.test(m.content))).toBe(true);
  });
});
