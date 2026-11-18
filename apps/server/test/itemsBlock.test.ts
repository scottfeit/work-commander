import { describe, expect, it } from 'vitest';
import { itemsBlock, STREAM_AGENT_RULES } from '../src/agent/prompts.js';

const mail = (id: string, title: string, at: string, from: string, text: string) =>
  ({ id, source: 'gmail', kind: 'email_thread', externalId: id, title, streamId: 's', updatedAt: at, data: { gmail: { threadId: id }, messages: [{ id: `${id}-1`, author: { name: from }, text, at }] } }) as any;

describe('the agent’s list of a stream’s items', () => {
  const same = '[ACTION REQUIRED] Verify why this user was suspended';
  const items = [
    mail('a', same, '2026-11-18T18:30:30.000Z', 'Helpdesk', 'User anand@x.com with ID 111355 was just suspended'),
    mail('b', same, '2026-11-18T20:41:35.000Z', 'Helpdesk', 'User mansi.d@x.com with ID 111422 was just suspended'),
    mail('c', 'Vinod urgent offboarding request', '2026-11-18T17:00:00.000Z', 'Vinod', 'Please offboard today'),
  ];
  it('tells items that share a title apart by when and from whom they started', () => {
    const lines = itemsBlock(items).split('\n');
    expect(lines[1]).toContain('(first message 2026-11-18 18:30 UTC from Helpdesk)');
    expect(lines[2]).toContain('(first message 2026-11-18 20:41 UTC from Helpdesk)');
    expect(lines[2]).toContain('mansi.d@x.com with ID 111422'); // the preview of what it says is still there
  });
  it('leaves items with a title of their own alone', () => {
    expect(itemsBlock(items).split('\n')[3]).not.toContain('first message');
  });
  it('the rules say to look in the stream before saying something is missing, and what to do with "there already is one"', () => {
    expect(STREAM_AGENT_RULES).toMatch(/Before you say something has not arrived/);
    expect(STREAM_AGENT_RULES).toMatch(/at most three, newest first/);
    expect(STREAM_AGENT_RULES).toMatch(/there already is one/);
    expect(STREAM_AGENT_RULES).toMatch(/Do not answer about playbooks/);
  });
});
