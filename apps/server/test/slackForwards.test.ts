import { describe, expect, it } from 'vitest';
import { textWithForwards } from '@wc/shared';
import { forwardsOf } from '../src/integrations/slack.js';

const render = async (t: string) => t.replace('<@U2>', '@Dana');
const nameOf = async (id: string) => (id === 'U9' ? 'Sam Ortiz' : undefined);

describe('Slack forwards', () => {
  it('reads forwarded messages (and pasted message links) with who, where, when and files', async () => {
    const r = await forwardsOf(
      {
        attachments: [
          { is_share: true, author_id: 'U9', channel_id: 'C1', channel_name: 'ops', ts: '1763630000.000100', text: 'Prod is down, <@U2> on it', from_url: 'https://acme.slack.com/archives/C1/p1763630000000100', files: [{ id: 'F1', name: 'log.txt', mimetype: 'text/plain', url_private: 'https://files.slack.com/F1' }] },
          { is_msg_unfurl: true, author_name: 'Lee', channel_id: 'D5', text: 'from a DM' },
          { title: 'A link preview', text: 'not a message', title_link: 'https://example.com' },
        ],
      },
      render,
      nameOf,
    );
    expect(r.forwarded).toEqual([
      { author: 'Sam Ortiz', slackUserId: 'U9', channel: '#ops', at: new Date(1763630000000.1).toISOString(), text: 'Prod is down, @Dana on it', url: 'https://acme.slack.com/archives/C1/p1763630000000100', attachments: [{ id: 'F1', name: 'log.txt', mimeType: 'text/plain', size: undefined, ref: 'https://files.slack.com/F1' }] },
      { author: 'Lee', channel: 'a DM', text: 'from a DM' },
    ]);
    expect(await forwardsOf({ attachments: [{ title: 'x', text: 'y' }] }, render, nameOf)).toEqual({});
  });

  it('Claude reads the forward as part of the message', () => {
    expect(textWithForwards({ text: 'FYI', forwarded: [{ author: 'Sam', channel: '#ops', text: 'line 1\nline 2', attachments: [{ id: 'F', name: 'log.txt', mimeType: 'text/plain', ref: 'x' }] }] })).toBe(
      'FYI\n\n[Forwarded message from Sam in #ops]\n> line 1\n> line 2\n> [files: log.txt]',
    );
    expect(textWithForwards({ text: 'plain' })).toBe('plain');
  });
});
