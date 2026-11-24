import { beforeEach, describe, expect, it } from 'vitest';
import { SlackWorkspace } from '../src/integrations/slack.js';

describe('sending a Slack message with files', () => {
  let calls: { fn: string; args: any }[];
  const make = (opts: { shares?: any; history?: any[]; uploadFails?: Error } = {}) => {
    const ws = new SlackWorkspace('xoxp-test');
    (ws as any).web = {
      chat: {
        postMessage: async (a: any) => (calls.push({ fn: 'postMessage', args: a }), { ts: '100.000001' }),
        getPermalink: async () => ({ permalink: 'https://x.slack.com/archives/D1/p100' }),
      },
      files: {
        uploadV2: async (a: any) => {
          calls.push({ fn: 'uploadV2', args: a });
          if (opts.uploadFails) throw opts.uploadFails;
          return { ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] };
        },
        info: async () => ({ file: { shares: opts.shares ?? {} } }),
      },
      conversations: {
        history: async (a: any) => (calls.push({ fn: 'history', args: a }), { messages: opts.history ?? [] }),
        replies: async (a: any) => (calls.push({ fn: 'replies', args: a }), { messages: opts.history ?? [] }),
      },
    };
    return ws;
  };
  const files = [{ data: Buffer.from('x'), filename: 'shot.png' }] as any;
  beforeEach(() => {
    calls = [];
  });

  it('text only is one ordinary message', async () => {
    const r = await make().postMessage({ channel: 'D1', text: 'hi' });
    expect(calls.map((c) => c.fn)).toEqual(['postMessage']);
    expect(r.ts).toBe('100.000001');
  });

  it('text and a file are one message: the text is the upload\'s comment, and no thread is started', async () => {
    const r = await make({ shares: { private: { D1: [{ ts: '200.000002' }] } } }).postMessage({ channel: 'D1', text: 'look at this', files });
    expect(calls.map((c) => c.fn)).toEqual(['uploadV2']); // no separate chat message
    expect(calls[0].args).toMatchObject({ channel_id: 'D1', initial_comment: 'look at this' });
    expect(calls[0].args.thread_ts).toBeUndefined();
    expect(r.ts).toBe('200.000002'); // the message Slack made for it
  });

  it('in a thread, the upload goes in that thread', async () => {
    await make({ shares: { public: { C1: [{ ts: '300.000003' }] } } }).postMessage({ channel: 'C1', text: 'here', threadTs: '50.000001', files });
    expect(calls[0].args).toMatchObject({ channel_id: 'C1', initial_comment: 'here', thread_ts: '50.000001' });
  });

  it('when Slack has not listed the share yet, the message is found in the conversation', async () => {
    const r = await make({ history: [{ ts: '5.1', files: [{ id: 'other' }] }, { ts: '400.000004', files: [{ id: 'F1' }] }] }).postMessage({ channel: 'D1', text: 'x', files });
    expect(r.ts).toBe('400.000004');
  });

  it('a failed upload says so, with the files:write hint when the scope is missing', async () => {
    await expect(make({ uploadFails: Object.assign(new Error('x'), { data: { error: 'missing_scope' } }) }).postMessage({ channel: 'D1', text: 'x', files })).rejects.toThrow(/files:write/);
  });
});
