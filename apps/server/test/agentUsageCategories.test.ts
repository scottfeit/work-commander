import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { UsageLog } from '../src/core/usage.js';
import { StreamAgentRunner } from '../src/agent/runner.js';
import { usageCategoryOf } from '@wc/shared';

describe("an agent turn's usage is filed under what it did", () => {
  let repo: Repo;
  let usage: UsageLog;
  let runner: StreamAgentRunner;
  let streamId: string;
  let drafts = false;
  beforeEach(async () => {
    const { db } = await openDatabase('sqlite::memory:');
    repo = new Repo(db);
    const s = defaultSettings();
    usage = new UsageLog(db, { settings: async () => s, sync: { get: (k) => repo.getSync(k), set: (k, v) => repo.setSync(k, v) } });
    streamId = (await repo.createStream({ title: 'Budget', summary: '' })).id;
    drafts = false;
    // Stands in for Claude: reports a turn's usage like the real backend does, and optionally drafts something.
    const backend = {
      async turn(i: any) {
        i.usage.held.push({ kind: i.usage.kind, model: 'claude-sonnet', streamId, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25, durationMs: 1, ok: true });
        if (drafts) {
          const reply = i.tools.find((t: any) => t.name === 'propose_ticket_comment');
          await reply.handler({ key: 'OPS-1', body: 'On it', visibility: 'public', rationale: 'asked' });
        }
        return { text: 'done', sessionId: null };
      },
    } as any;
    const hub = { systemMode: async () => 'api', api: async () => ({}) } as any;
    const toolDeps = { repo, hub, grants: {} as any, executor: {} as any, settings: async () => s };
    runner = new StreamAgentRunner(repo, backend, hub, { onRunSettled: null } as any, {} as any, async () => s, toolDeps as any, usage);
  });
  const kinds = async () => (await usage.forStream(streamId)).byCategory;

  it('your messages are chat; Claude acting on its own keeps the stream up to date', async () => {
    await runner.run({ streamId, prompt: 'what is left?', origin: 'user' });
    await runner.run({ streamId, prompt: '[new item]', origin: 'system' });
    const c = await kinds();
    expect(c.chat?.costUsd).toBeCloseTo(0.25);
    expect(c.review?.costUsd).toBeCloseTo(0.25);
  });
  it('a turn that drafted something is drafting, whoever started it; a hand-off coming back is a hand-off', async () => {
    drafts = true;
    await runner.run({ streamId, prompt: 'reply to them', origin: 'user' });
    drafts = false;
    await runner.run({ streamId, prompt: '[Claude Code finished]', origin: 'system', purpose: 'handoff' });
    const c = await kinds();
    expect(c.drafting?.costUsd).toBeCloseTo(0.25);
    expect(c.handoff?.costUsd).toBeCloseTo(0.25);
    expect(c.chat).toBeUndefined();
  });
  it('every kind of call has a category', () => {
    expect(usageCategoryOf('mcpIngest')).toBe('reading');
    expect(usageCategoryOf('topicSplit')).toBe('triage');
    expect(usageCategoryOf('agent')).toBe('other'); // recorded before turns were told apart
  });
});
