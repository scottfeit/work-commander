import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';

describe('messages sent through an MCP server show in the conversation tab', () => {
  it('adds the sent message to the matching Slack item, then swaps it for the real copy from the next poll', async () => {
    const { db } = await openDatabase('sqlite::memory:');
    const repo = new Repo(db);
    const st = await repo.createStream({ title: 't', summary: 's' });
    const thread = (messages: any[]) => ({ source: 'slack' as const, kind: 'slack_thread' as const, externalId: 'D1:100.1', title: 'DM', data: { messages, slack: { channel: 'D1', threadTs: '100.1' } }, eventId: 'e', streamId: st.id });
    const chris = { id: '100.1', author: { name: 'Chris' }, text: "How's the app?", at: '2026-11-11T05:00:00Z' };
    await repo.upsertItem(thread([chris]));

    const item = await repo.recordSentMessage(st.id, 'slack', { channel: 'D1' }, 'It is done!', 'p_1', { name: 'Scott' });
    expect(item!.data.messages!.map((m) => m.text)).toEqual(["How's the app?", 'It is done!']);

    // Next poll brings Slack's own copy (different id, same text): the local copy is dropped, no duplicate.
    const real = { id: '200.2', author: { name: 'Scott' }, text: 'It is done!', at: '2026-11-11T06:00:00Z', isFromPU: true };
    const { item: after } = await repo.upsertItem(thread([chris, real]));
    expect(after.data.messages!.map((m) => m.id)).toEqual(['100.1', '200.2']);
  });

  it('does nothing when the stream has no matching conversation', async () => {
    const { db } = await openDatabase('sqlite::memory:');
    const repo = new Repo(db);
    const st = await repo.createStream({ title: 't', summary: 's' });
    expect(await repo.recordSentMessage(st.id, 'slack', { channel: 'D9' }, 'hi', 'p', {})).toBeNull();
  });
});
