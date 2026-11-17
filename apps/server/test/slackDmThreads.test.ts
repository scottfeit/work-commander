import { describe, expect, it } from 'vitest';
import { parseSlackClock, parseSlackMessages, pollSlackDirect } from '../src/integrations/slackMcp.js';

const D = 'D029V2EH0JJ';
const PARENT = '1794931682.681309'; // Tina, 08:08 PST
const MINE = '1794940596.385709'; // Scott's reply in the thread, 10:36 PST
const FOLLOWUP = '1794948486.632319'; // Tina's reply in the thread, 12:48 PST

const history = (latest: string, replies = 2) =>
  JSON.stringify({ messages: `Channel: DM (${D})\n\n=== Message from Tina Brown <tina@x.com> (UTINA) at 2026-11-17 08:08:02 PST === \nMessage TS: ${PARENT}\nHi Scott, when is the onboarding email sent?\nThread: ${replies} replies (latest: ${latest})`, pagination_info: 'There are no more messages.' });
const thread = JSON.stringify({
  messages:
    `=== THREAD PARENT MESSAGE ===\nFrom: Tina Brown <tina@x.com> (UTINA)\nTime: 2026-11-17 08:08:02 PST\nMessage TS: ${PARENT}\nHi Scott, when is the onboarding email sent?\n\n=== THREAD REPLIES (2 total) ===\n\n` +
    `--- Reply 1 of 2 ---\nFrom: Scott Feit <scott@x.com> (UME)\nTime: 2026-11-17 10:36:36 PST\nMessage TS: ${MINE}\n14 days before.\n\n` +
    `--- Reply 2 of 2 ---\nFrom: Tina Brown <tina@x.com> (UTINA)\nTime: 2026-11-17 12:48:06 PST\nMessage TS: ${FOLLOWUP}\nCan I assume the same happened for the other three?`,
});

const poll = async (opts: { after: string; latest: string; hits?: boolean }) => {
  const calls: { tool: string; args: any }[] = [];
  const out = await pollSlackDirect(
    async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'slack_read_channel') return history(opts.latest);
      if (tool === 'slack_read_thread') return thread;
      return JSON.stringify({ results: '# Search Results\n\nNo results found.\n', pagination_info: 'End of results.' });
    },
    { since: Date.parse('2026-11-17T18:30:00Z') / 1000, puEmail: 'scott@x.com', me: 'UME', watched: [], conversations: [{ channel: D, after: opts.after }], threads: [] },
  );
  return { items: out.items, calls };
};

describe('replies in a DM thread', () => {
  it('reads the clock Slack prints', () => {
    expect(parseSlackClock('2026-11-17 12:48:06 PST')).toBe(Date.parse('2026-11-17T20:48:06Z') / 1000);
    expect(parseSlackClock('2026-07-01 12:00:00 PDT')).toBe(Date.parse('2026-07-01T19:00:00Z') / 1000);
    expect(parseSlackClock('soon')).toBeUndefined();
  });
  it('the history shows only the parent, with its reply count and latest time', () => {
    const [m] = parseSlackMessages(history('2026-11-17 12:48:06 PST'), { userId: 'UME' }).messages;
    expect(m.replies).toBe(2);
    expect(m.repliesLatest).toBe(Date.parse('2026-11-17T20:48:06Z') / 1000);
  });

  it('a follow-up in an older thread is read and added to the conversation, and only what is new', async () => {
    const { items, calls } = await poll({ after: '2026-11-17T18:36:37.000Z', latest: '2026-11-17 12:48:06 PST' });
    expect(calls.some((c) => c.tool === 'slack_read_thread' && c.args.message_ts === PARENT)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe(`${D}:dm`);
    expect(items[0].data.messages!.map((m) => m.id)).toEqual([FOLLOWUP]);
    expect(items[0].data.messages![0].text).toContain('other three');
  });

  it('a thread with nothing newer than the last check is not read', async () => {
    const { items, calls } = await poll({ after: '2026-11-17 21:00:00Z'.replace(' ', 'T'), latest: '2026-11-17 12:48:06 PST' });
    expect(calls.some((c) => c.tool === 'slack_read_thread')).toBe(false);
    expect(items).toHaveLength(0);
  });

  it('the history is read from before the last check, so older parents are visible', async () => {
    const { calls } = await poll({ after: '2026-11-17T18:36:37.000Z', latest: '2026-11-17 12:48:06 PST' });
    const read = calls.find((c) => c.tool === 'slack_read_channel')!;
    expect(Number(read.args.oldest)).toBeLessThan(Date.parse('2026-11-17T18:36:36Z') / 1000 - 6 * 86_400);
  });

  it('a reply time in a zone it cannot read does not mean re-reading every old thread', async () => {
    const { calls } = await poll({ after: '2026-11-25T00:00:00.000Z', latest: '2026-11-17 12:48:06 JST' }); // the parent is 8 days older than the last check
    expect(calls.some((c) => c.tool === 'slack_read_thread')).toBe(false);
  });
  it('knows common US and European zones', () => {
    expect(parseSlackClock('2026-11-17 12:48:06 CET')).toBe(Date.parse('2026-11-17T11:48:06Z') / 1000);
    expect(parseSlackClock('2026-11-17 12:48:06 EST')).toBe(Date.parse('2026-11-17T17:48:06Z') / 1000);
  });
});
