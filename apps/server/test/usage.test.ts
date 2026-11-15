import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { UsageLog, localDay } from '../src/core/usage.js';
import { modelFor, usageEntries } from '../src/agent/backend.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { bus } from '../src/core/bus.js';
import type { Settings } from '@wc/shared';

const entry = (over: Partial<Parameters<UsageLog['record']>[0]> = {}) => ({
  kind: 'triage' as const,
  model: 'claude-haiku-5-5',
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 500,
  cacheWriteTokens: 0,
  costUsd: 0.002,
  durationMs: 900,
  ok: true,
  ...over,
});

describe('usage log', () => {
  let repo: Repo;
  let usage: UsageLog;
  let s: Settings;
  let emails: string[];
  beforeEach(async () => {
    const { db } = await openDatabase('sqlite::memory:');
    repo = new Repo(db);
    s = defaultSettings();
    emails = [];
    usage = new UsageLog(db, { settings: async () => s, sync: { get: (k) => repo.getSync(k), set: (k, v) => repo.setSync(k, v) }, emailSelf: async (subj) => void emails.push(subj) });
  });

  it('adds calls up by day, kind, model and stream', async () => {
    await usage.record(entry({ streamId: 'st1' }));
    await usage.record(entry({ streamId: 'st1', kind: 'agent', model: 'claude-sonnet-5-5', costUsd: 0.05 }));
    await usage.record(entry());
    const r = await usage.report(7);
    expect(r.today.calls).toBe(3);
    expect(r.today.inputTokens).toBe(3000);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].day).toBe(localDay());
    expect(r.days[0].byKind.triage!.calls).toBe(2);
    expect(r.byModel[0].model).toBe('claude-sonnet-5-5'); // most expensive first
    const st = await usage.forStream('st1');
    expect(st.triage.calls).toBe(1);
    expect(st.agent.calls).toBe(1);
    expect(st.total.costUsd).toBeCloseTo(0.052);
  });

  it('alerts once a day when the budget is passed, through the chosen channels', async () => {
    const seen: any[] = [];
    const off = bus.subscribe((e) => e.type === 'usage.alert' && seen.push(e));
    s.usage = { unit: 'tokens', dailyBudget: 2000, alertBanner: true, alertDesktop: true, alertEmail: true };
    await usage.record(entry()); // 1,600 tokens: under
    expect(seen).toHaveLength(0);
    await usage.record(entry()); // 3,200: over
    await usage.record(entry()); // still over: no second alert
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ banner: true, desktop: true });
    expect(emails).toHaveLength(1);
    expect((await usage.report(1)).alert).not.toBeNull();
    await usage.dismissAlert();
    expect((await usage.report(1)).alert).toBeNull();
  });

  it('measures the budget in dollars when that unit is chosen', async () => {
    const seen: any[] = [];
    const off = bus.subscribe((e) => e.type === 'usage.alert' && seen.push(e));
    s.usage = { unit: 'dollars', dailyBudget: 0.01, alertBanner: true, alertDesktop: false, alertEmail: false };
    for (let i = 0; i < 4; i++) await usage.record(entry()); // $0.008
    expect(seen).toHaveLength(0);
    await usage.record(entry()); // $0.010
    off();
    expect(seen).toHaveLength(1);
    expect(emails).toHaveLength(0);
  });

  it('keeps daily totals when old per-call records are pruned', async () => {
    await usage.record(entry());
    await repo.db.updateTable('usage_calls').set({ at: '2020-01-01T00:00:00.000Z' }).execute();
    await usage.prune();
    expect(await repo.db.selectFrom('usage_calls').selectAll().execute()).toHaveLength(0);
    expect((await usage.report(1)).today.calls).toBe(1);
  });
});

describe('recording a call', () => {
  const mu = (n: number) => ({ 'claude-sonnet-5-5': { inputTokens: n, outputTokens: n / 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: n / 1000 } });

  it('takes per-model totals from a fresh call', () => {
    const e = usageEntries({ modelUsage: mu(1000), duration_ms: 50 }, { kind: 'agent', streamId: 's' }, true);
    expect(e).toEqual([expect.objectContaining({ model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 100, costUsd: 1, streamId: 's', durationMs: 50 })]);
  });

  it('subtracts what a resumed session already counted', () => {
    const e = usageEntries({ modelUsage: mu(3000) }, { kind: 'agent' }, true, mu(1000), true);
    expect(e[0].inputTokens).toBe(2000);
    expect(e[0].costUsd).toBeCloseTo(2);
  });

  it("counts only this call's main-loop usage when a resumed session has no saved totals", () => {
    const e = usageEntries({ modelUsage: mu(5000), usage: { input_tokens: 400, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, { kind: 'agent' }, true, null, true);
    expect(e[0].inputTokens).toBe(400);
    expect(e[0].costUsd).toBeCloseTo((5 * 500) / 5500);
  });

  it('picks each background call its own model, and the main model for the agent', () => {
    const s = defaultSettings();
    s.claude.model = 'opus';
    expect(modelFor(s, 'triage')).toBe('haiku');
    expect(modelFor(s, 'newStream')).toBe('haiku');
    expect(modelFor(s, 'agent')).toBe('opus');
    s.claude.taskModels = { ...s.claude.taskModels!, topicSplit: 'main', mcpIngest: 'sonnet' };
    expect(modelFor(s, 'topicSplit')).toBe('opus');
    expect(modelFor(s, 'mcpIngest')).toBe('sonnet');
  });
});

describe('triage usage', () => {
  it('is credited to the work stream the item lands in', async () => {
    const { db } = await openDatabase('sqlite::memory:');
    const repo = new Repo(db);
    const s = defaultSettings();
    const usage = new UsageLog(db, { settings: async () => s, sync: { get: (k) => repo.getSync(k), set: (k, v) => repo.setSync(k, v) } });
    const yes = { relevant: true, reason: 'asks', stream: { action: 'new', streamId: null, title: 'Budget review', summary: 'Dana asks', labels: [] }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    const backend = {
      structured: async (i: any) => {
        expect(i.usage.kind).toBe('triage');
        i.usage.held.push({ kind: 'triage', model: 'haiku', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0001, durationMs: 1, ok: true });
        return yes;
      },
    };
    const t = new TriagePipeline(repo, backend as any, { run: async () => undefined } as any, async () => s, true, usage);
    await t.handle({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Budget', eventId: 'e1', data: { messages: [{ id: 'm1', author: { name: 'Dana', email: 'dana@x.com' }, text: 'Review please', at: '2026-11-14T10:00:00Z' }] } });
    const streamId = (await repo.listStreams(false))[0].id;
    expect((await usage.forStream(streamId)).triage.calls).toBe(1);
  });
});
