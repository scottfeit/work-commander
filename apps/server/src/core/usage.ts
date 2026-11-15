/**
 * Token and cost accounting for every Claude call (and Laya call) Work Commander makes.
 *
 * Each call is kept for a year in usage_calls; usage_daily keeps per day / kind / model / stream totals for good,
 * so reports and per-stream figures survive the pruning. Costs are the SDK's estimates at API list prices, not a bill:
 * with a Claude Code login the PU pays by subscription.
 */
import { sql } from 'kysely';
import type { Settings, StreamUsage, UsageKind, UsageReport, UsageTotals } from '@wc/shared';
import { formatUsage, totalTokens } from '@wc/shared';
import type { Database } from '../db/index.js';
import { now } from '../db/index.js';
import { bus } from './bus.js';

export interface UsageEntry {
  kind: UsageKind;
  model: string;
  streamId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  ok: boolean;
}

const KEEP_CALLS_DAYS = 365;
const TRIAGE_KINDS: UsageKind[] = ['triage', 'topicSplit', 'slackContext', 'mcpIngest', 'newStream', 'overview', 'laya'];

/** The local calendar day, YYYY-MM-DD. */
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const zeroTotals = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
const add = (a: UsageTotals, r: { calls: number | string; input_tokens: number | string; output_tokens: number | string; cache_read_tokens: number | string; cache_write_tokens: number | string; cost_usd: number | string }): UsageTotals => ({
  calls: a.calls + Number(r.calls),
  inputTokens: a.inputTokens + Number(r.input_tokens),
  outputTokens: a.outputTokens + Number(r.output_tokens),
  cacheReadTokens: a.cacheReadTokens + Number(r.cache_read_tokens),
  cacheWriteTokens: a.cacheWriteTokens + Number(r.cache_write_tokens),
  costUsd: a.costUsd + Number(r.cost_usd),
});

export interface UsageLogDeps {
  settings: () => Promise<Settings>;
  sync: { get(k: string): Promise<string | null | undefined>; set(k: string, v: string): Promise<void> };
  /** Sends the budget alert to the PU's own address. Throws when email can't be sent. */
  emailSelf?: (subject: string, body: string) => Promise<void>;
  log?: (msg: string) => void;
}

export class UsageLog {
  private lastPrune = 0;
  constructor(
    private db: Database,
    private d: UsageLogDeps,
  ) {}

  async record(e: UsageEntry) {
    const day = localDay();
    const row = {
      day,
      kind: e.kind,
      model: e.model || 'unknown',
      input_tokens: Math.max(0, Math.round(e.inputTokens)),
      output_tokens: Math.max(0, Math.round(e.outputTokens)),
      cache_read_tokens: Math.max(0, Math.round(e.cacheReadTokens)),
      cache_write_tokens: Math.max(0, Math.round(e.cacheWriteTokens)),
      cost_usd: Math.max(0, e.costUsd || 0),
    };
    await this.db
      .insertInto('usage_calls')
      .values({ ...row, at: now(), stream_id: e.streamId ?? null, duration_ms: Math.max(0, Math.round(e.durationMs)), ok: e.ok ? 1 : 0 })
      .execute();
    await this.db
      .insertInto('usage_daily')
      .values({ ...row, stream_id: e.streamId ?? '', calls: 1 })
      .onConflict((oc) =>
        oc.columns(['day', 'kind', 'model', 'stream_id']).doUpdateSet({
          calls: sql`usage_daily.calls + 1`,
          input_tokens: sql`usage_daily.input_tokens + ${row.input_tokens}`,
          output_tokens: sql`usage_daily.output_tokens + ${row.output_tokens}`,
          cache_read_tokens: sql`usage_daily.cache_read_tokens + ${row.cache_read_tokens}`,
          cache_write_tokens: sql`usage_daily.cache_write_tokens + ${row.cache_write_tokens}`,
          cost_usd: sql`usage_daily.cost_usd + ${row.cost_usd}`,
        }),
      )
      .execute();
    await this.checkBudget(day).catch((err) => this.d.log?.(`usage budget check: ${err.message}`));
    if (Date.now() - this.lastPrune > 6 * 3600_000) await this.prune().catch(() => undefined);
  }

  /** Drop per-call records older than a year (daily totals stay). */
  async prune() {
    this.lastPrune = Date.now();
    const cutoff = new Date(Date.now() - KEEP_CALLS_DAYS * 86_400_000).toISOString();
    await this.db.deleteFrom('usage_calls').where('at', '<', cutoff).execute();
  }

  async totalsFor(day: string): Promise<UsageTotals> {
    const rows = await this.db.selectFrom('usage_daily').selectAll().where('day', '=', day).execute();
    return rows.reduce(add, zeroTotals());
  }

  /** Over budget today? Alert once per day through the channels the PU chose. */
  async checkBudget(day = localDay()) {
    const s = await this.d.settings();
    const u = s.usage;
    if (!u || !(u.dailyBudget > 0)) return;
    if (await this.d.sync.get(`usage.alerted.${day}`)) return;
    const t = await this.totalsFor(day);
    const used = u.unit === 'dollars' ? t.costUsd : totalTokens(t);
    if (used < u.dailyBudget) return;
    await this.d.sync.set(`usage.alerted.${day}`, now());
    const budget = u.unit === 'dollars' ? `$${u.dailyBudget}` : `${u.dailyBudget.toLocaleString('en-US')} tokens`;
    const message = `Today's Claude usage is ${formatUsage(t, u.unit)}, over your daily budget of ${budget}.${u.unit === 'dollars' ? ' (Estimated at API prices.)' : ''}`;
    bus.publish({ type: 'usage.alert', day, message, desktop: !!u.alertDesktop, banner: !!u.alertBanner });
    if (u.alertEmail) {
      try {
        if (!this.d.emailSelf) throw new Error('email is not available');
        await this.d.emailSelf('Work Commander: daily usage budget passed', `${message}\n\nSee Settings → Usage in Work Commander for the breakdown. Nothing has been paused.`);
      } catch (err: any) {
        this.d.log?.(`usage alert email failed: ${err.message}`);
      }
    }
  }

  async dismissAlert(day = localDay()) {
    await this.d.sync.set(`usage.dismissed.${day}`, now());
  }

  async report(days = 30): Promise<UsageReport> {
    const from = localDay(new Date(Date.now() - (days - 1) * 86_400_000));
    const rows = await this.db.selectFrom('usage_daily').selectAll().where('day', '>=', from).orderBy('day').execute();
    const byDay = new Map<string, { byKind: Partial<Record<UsageKind, UsageTotals>>; total: UsageTotals }>();
    const byModel = new Map<string, UsageTotals>();
    const byKind = new Map<UsageKind, UsageTotals>();
    for (const r of rows) {
      const k = r.kind as UsageKind;
      const d = byDay.get(r.day) ?? { byKind: {}, total: zeroTotals() };
      d.byKind[k] = add(d.byKind[k] ?? zeroTotals(), r);
      d.total = add(d.total, r);
      byDay.set(r.day, d);
      byModel.set(r.model, add(byModel.get(r.model) ?? zeroTotals(), r));
      byKind.set(k, add(byKind.get(k) ?? zeroTotals(), r));
    }
    const today = localDay();
    const s = await this.d.settings();
    const alerted = await this.d.sync.get(`usage.alerted.${today}`);
    const dismissed = await this.d.sync.get(`usage.dismissed.${today}`);
    const todayTotals = byDay.get(today)?.total ?? zeroTotals();
    return {
      days: [...byDay.entries()].map(([day, v]) => ({ day, ...v })),
      byModel: [...byModel.entries()].map(([model, totals]) => ({ model, totals })).sort((a, b) => b.totals.costUsd - a.totals.costUsd),
      byKind: [...byKind.entries()].map(([kind, totals]) => ({ kind, totals })).sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals)),
      today: todayTotals,
      alert: alerted && !dismissed && s.usage?.alertBanner ? { day: today, message: `Today's Claude usage (${formatUsage(todayTotals, s.usage.unit)}) is over your daily budget.` } : null,
    };
  }

  async forStream(streamId: string): Promise<StreamUsage> {
    const rows = await this.db.selectFrom('usage_daily').selectAll().where('stream_id', '=', streamId).execute();
    const out: StreamUsage = { unit: (await this.d.settings()).usage?.unit ?? 'tokens', triage: zeroTotals(), agent: zeroTotals(), total: zeroTotals() };
    for (const r of rows) {
      if (TRIAGE_KINDS.includes(r.kind as UsageKind)) out.triage = add(out.triage, r);
      else out.agent = add(out.agent, r);
      out.total = add(out.total, r);
    }
    return out;
  }
}

/**
 * Where a call's usage goes. Triage runs before it knows the work stream, so it collects its entries in `held`
 * and records them once routing has decided (see TriagePipeline).
 */
export interface UsageTag {
  kind: UsageKind;
  streamId?: string | null;
  held?: UsageEntry[];
}
