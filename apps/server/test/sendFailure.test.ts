import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { Executor } from '../src/core/executor.js';

describe('a draft that could not be sent', () => {
  let repo: Repo;
  let streamId: string;
  let postFails: Error | null;
  let readBackFails: boolean;
  let posts: number;
  const chat = () => ({
    postMessage: async () => {
      if (postFails) throw postFails;
      posts++;
      return { channel: 'C1', ts: '100.000001' };
    },
    getThread: async (c: string, t: string) => {
      if (readBackFails) throw new Error('Slack read failed');
      return { source: 'slack', kind: 'slack_thread', externalId: `${c}:${t}`, title: '#x', eventId: `${c}:${t}`, data: { messages: [{ id: t, author: { name: 'Me' }, text: 'hi', at: new Date().toISOString(), isFromPU: true }], slack: { channel: c, channelName: '#x', threadTs: t } } };
    },
  });
  const executor = () => new Executor(repo, { api: async () => chat() } as any, {} as any, async () => defaultSettings(), {} as any, () => async () => '');
  const draft = () => repo.createProposal({ streamId, runId: 'quick-1', kind: 'slack_post', system: 'slack', title: 'q', rationale: '', payload: { channel: 'C1', text: 'hello', quick: true }, editable: [], quick: true } as any);

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    streamId = (await repo.createStream({ title: 's', summary: '' })).id;
    postFails = null;
    readBackFails = false;
    posts = 0;
  });

  it('goes back to waiting with the reason, so it can be sent again', async () => {
    const ex = executor();
    const p = await draft();
    postFails = new Error('Slack did not answer within 20 seconds');
    const after = await ex.approve(p.id, { channel: 'C1', text: 'hello', quick: true });
    expect(after.status).toBe('pending');
    expect(after.error).toMatch(/did not answer/);
    expect(posts).toBe(0);
    // the second attempt works, and the old reason is gone
    postFails = null;
    const again = await ex.approve(p.id, { channel: 'C1', text: 'hello, edited', quick: true });
    expect(again.status).toBe('executed');
    expect(again.error).toBeNull();
    expect(posts).toBe(1);
  });

  it('a message that went out is never reported as failed because showing it in the stream failed (a retry would send it twice)', async () => {
    readBackFails = true;
    const ex = executor();
    const p = await draft();
    const after = await ex.approve(p.id, { channel: 'C1', text: 'hello', quick: true });
    expect(after.status).toBe('executed');
    expect(posts).toBe(1);
  });
});
