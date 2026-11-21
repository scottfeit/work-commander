import { describe, expect, it } from 'vitest';
import { threadOf } from '../src/integrations/slack.js';
import { buildQuickReply } from '../src/core/quickReply.js';
import { defaultSettings } from '../src/core/settings.js';

const s = { ...defaultSettings(), slack: { ...defaultSettings().slack, mode: 'api' as const } };
const dm = (msgs: any[]) => ({ id: 'i', source: 'slack', kind: 'slack_thread', externalId: 'D1:dm', title: 'DM with Lee', data: { messages: msgs, slack: { channel: 'D1', threadTs: msgs[0].id } } }) as any;

describe('Slack threads for replies', () => {
  it('a message records the thread it is in or starts', () => {
    expect(threadOf({ ts: '2', thread_ts: '1' })).toEqual({ threadTs: '1' });
    expect(threadOf({ ts: '1', reply_count: 3 })).toEqual({ threadTs: '1' });
    expect(threadOf({ ts: '1' })).toEqual({});
  });

  it('Quick Reply: in the thread when the latest message is a thread reply; otherwise in the conversation', () => {
    const inThread = buildQuickReply(dm([{ id: '1', author: { name: 'Lee' }, text: 'a', at: '2026-11-20T10:00:00Z' }, { id: '2', author: { name: 'Lee' }, text: 'b', at: '2026-11-20T10:05:00Z', threadTs: '1' }]), s);
    expect(inThread.payload.thread_ts).toBe('1');
    const flat = buildQuickReply(dm([{ id: '1', author: { name: 'Lee' }, text: 'a', at: '2026-11-20T10:00:00Z' }]), s);
    expect(flat.payload.thread_ts).toBeUndefined();
  });
});
