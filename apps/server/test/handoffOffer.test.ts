import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { TRIAGE_RULES, STREAM_AGENT_RULES } from '../src/agent/prompts.js';

const setup = async (type: 'handoff' | 'draft', canHandoff = true) => {
  const repo = new Repo((await openDatabase('sqlite::memory:')).db);
  const runs: any[] = [];
  const decision = { relevant: true, reason: 'Nicole asks for the Gong recording to be made viewable.', stream: { action: 'new', streamId: null, title: 'Make Gong recording viewable', summary: 's', labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type, instruction: 'Change the sharing on the Gong recording https://gong.example/x so the CAS team can view it.', offerLabel: 'Nicole wants a recording made viewable: work for Claude Code.' } };
  const t = new TriagePipeline(repo, { structured: async () => decision } as any, { run: async (r: any) => void runs.push(r) } as any, async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, name: 'Scott Feit', email: 's@x.com' } }), canHandoff);
  await t.handle({ source: 'slack', kind: 'slack_thread', externalId: 'C1ABCDEF:1.1', title: 'Nicole', eventId: 'e1', data: { messages: [{ id: '1.1', author: { name: 'Nicole' }, text: 'can you make the quarterly CAS Gong recording viewable?', at: new Date().toISOString() }] } });
  const streamId = (await repo.listStreams(false))[0].id;
  return { repo, runs, chat: await repo.listChat(streamId) };
};

describe('work for Claude Code: ask instead of auto-drafting an acknowledgement', () => {
  it('triage "handoff" posts a one-click question and does not start Claude drafting', async () => {
    const { runs, chat } = await setup('handoff');
    expect(runs).toHaveLength(0);
    const offer = chat.find((m) => m.meta.handoffOffer);
    expect(offer?.role).toBe('suggestion');
    expect(offer!.meta.handoffOffer).toEqual({ task: expect.stringContaining('Gong recording'), done: [] });
    expect(offer!.content).toContain('Claude Code');
  });
  it('when hand-off is not available (hosted), it falls back to an ordinary offer', async () => {
    const { runs, chat } = await setup('handoff', false);
    expect(runs).toHaveLength(0);
    expect(chat.some((m) => m.meta.handoffOffer)).toBe(false);
    expect(chat.some((m) => m.role === 'suggestion')).toBe(true);
  });
  it('an ordinary "draft" still drafts automatically', async () => {
    const { runs } = await setup('draft');
    expect(runs).toHaveLength(1);
  });
  it('the rules tell the models to use it, and not to draft the acknowledgement themselves', () => {
    expect(TRIAGE_RULES).toMatch(/"handoff"/);
    expect(TRIAGE_RULES).toMatch(/Never use "draft" for a mere "I'll look into it"/);
    expect(STREAM_AGENT_RULES).toMatch(/offer_handoff/);
    expect(STREAM_AGENT_RULES).toMatch(/Do NOT draft an "I'm looking into it"/);
  });
});
