import { describe, expect, it } from 'vitest';
import { SlackWorkspace } from '../src/integrations/slack.js';

function fake(history: { ts: string }[], lastRead: string, err?: string) {
  const sl = new SlackWorkspace('xoxp-test');
  const marked: any[] = [];
  const fail = () => {
    if (err) throw Object.assign(new Error(err), { data: { error: err } });
  };
  (sl as any).web = {
    conversations: {
      info: async ({ channel }: any) => (fail(), { channel: { last_read: lastRead, is_im: channel.startsWith('D'), is_mpim: channel.startsWith('G') } }),
      history: async ({ limit }: any) => (fail(), { messages: history.slice(0, limit) }),
      mark: async (a: any) => (fail(), void marked.push(a)),
    },
  };
  return { sl, marked };
}

describe('Slack read/unread for a conversation', () => {
  it('reads the state from the read marker and the latest message', async () => {
    expect(await fake([{ ts: '200.000002' }], '100.000001').sl.readState('D1')).toMatchObject({ unread: true });
    expect(await fake([{ ts: '200.000002' }], '200.000002').sl.readState('D1')).toMatchObject({ unread: false });
  });

  it('marks read on the latest message, and unread on the one before it', async () => {
    const { sl, marked } = fake([{ ts: '300.000003' }, { ts: '200.000002' }], '0');
    expect(await sl.markConversation('C1', true)).toEqual({ unread: false });
    expect(await sl.markConversation('C1', false)).toEqual({ unread: true });
    expect(marked).toEqual([{ channel: 'C1', ts: '300.000003' }, { channel: 'C1', ts: '200.000002' }]);
  });

  it('a conversation with one message is marked unread just before it; a missing scope says what to do', async () => {
    const { sl, marked } = fake([{ ts: '300.000003' }], '0');
    await sl.markConversation('G1', false);
    expect(marked[0]).toEqual({ channel: 'G1', ts: '300.000002' });
    await expect(fake([], '0', 'missing_scope').sl.markConversation('C1', true)).rejects.toThrow(/channels:write.*reinstall/);
  });

  it('says what kind of conversation it is (a group DM is one conversation)', async () => {
    expect((await fake([{ ts: '2.0' }], '1.0').sl.readState('D1')).kind).toBe('im');
    expect((await fake([{ ts: '2.0' }], '1.0').sl.readState('G1')).kind).toBe('mpim');
    expect((await fake([{ ts: '2.0' }], '1.0').sl.readState('C1')).kind).toBe('channel');
  });
});
