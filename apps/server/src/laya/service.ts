/**
 * Laya for triage: learns from Claude's triage decisions (and the PU's corrections), shadows Claude, and takes over
 * each part of triage only after it agrees often enough and the PU confirms.
 *
 * Three parts, each judged and switched separately:
 *   relevance  "Does this need the PU?"                         (yes/no)
 *   stream     "Same work as this candidate stream?"            (yes/no per shortlisted stream; none = new stream)
 *   next       "What next: nothing, a reply, an offer, a hand-off?" (choice)
 *
 * Laya's own "auto"/"review" routing decides whether it is sure. Unsure answers never decide anything: Claude does.
 */
import { nanoid } from 'nanoid';
import type { LayaPart, LayaPartState, LayaPartStatus, LayaStatus, Settings, StreamItem, ThreadMessage, WorkStream } from '@wc/shared';
import { LAYA_PARTS } from '@wc/shared';
import type { Database } from '../db/index.js';
import { now, pj } from '../db/index.js';
import type { Repo } from '../core/repo.js';
import { bus } from '../core/bus.js';
import type { InboundItem } from '../integrations/types.js';
import { stripQuoted } from '../integrations/types.js';
import type { LayaManager } from './manager.js';
import { shortlistStreams } from './shortlist.js';

export type NextStep = 'none' | 'draft' | 'offer' | 'handoff';

export const QUESTIONS: Record<LayaPart, Record<string, any>> = {
  relevance: {
    needs_pu: {
      type: 'noul',
      instructions: 'Does this new activity need the primary user (PU) to do, decide, answer, review or follow up on something, now or later? Automated notices, newsletters and messages that need nothing from the PU are no.',
    },
  },
  stream: {
    same_work: { type: 'noul', instructions: 'Is the new activity about the same piece of work as the candidate work stream (the same request, project, problem or conversation)?' },
  },
  next: {
    next_step: {
      type: 'choice',
      instructions: 'What should happen next for the primary user (PU)?',
      criteria: {
        none: 'nothing to do now: information only, an acknowledgement, or already handled',
        draft: 'the PU should reply or respond: an email, a Slack message or a ticket comment',
        offer: 'there is work to do that the PU should decide on before anything is drafted',
        handoff: 'a coding, scripting or building task for a programmer',
      },
    },
  },
};
const QID: Record<LayaPart, string> = { relevance: 'needs_pu', stream: 'same_work', next: 'next_step' };
/** Shown until the helper has said how many examples a part needs (Laya's own rule; these are its values for these questions). */
const DEFAULT_NEEDED: Record<LayaPart, number> = { relevance: 20, stream: 20, next: 30 };
const MAX_TRAIN_ROWS = 3000;
/** A live part is checked against the PU's corrections once it has made this many decisions. */
const MIN_LIVE_FOR_NUDGE = 20;

interface PartRecord {
  state: LayaPartState;
  version: number;
  trainedAt: string | null;
  /** Comparisons with an id at or below this don't count (set when the PU says "not yet"). */
  windowAfter: number;
  message?: string;
}

/** What Laya said about one message. `sure` = Laya routed it "auto". */
export interface Assessment {
  relevance?: { yes: boolean; p: number; sure: boolean };
  stream?: { pick: string | 'new' | null; candidates: { id: string; p: number; sure: boolean }[] };
  next?: { step: NextStep; p: number; sure: boolean };
  /** Parts that were live when this was assessed. */
  live: LayaPart[];
}

export interface LayaContext {
  itemId: string;
  title: string;
  inbound: InboundItem;
  fresh: ThreadMessage[];
  existingStreamId: string | null;
  candidates: WorkStream[];
  state: string;
}

/** The decision triage needs, in the shape Claude returns it. */
export interface ClaudeLike {
  relevant: boolean;
  stream: { action: 'existing' | 'new' | 'none'; streamId: string | null };
  next: { type: NextStep };
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
const who = (m: ThreadMessage) => `${m.author.name ?? ''} <${m.author.email ?? m.author.slackUserId ?? m.author.accountId ?? ''}>`.trim();

export function messageState(s: Settings, inbound: InboundItem, fresh: ThreadMessage[], max = 2400) {
  const all = inbound.data.messages ?? inbound.data.ticket?.comments ?? [];
  const earlier = all.filter((m) => !fresh.includes(m)).slice(-2);
  const t = inbound.data.ticket;
  const lines = [
    `Primary user (PU): ${s.pu.name} <${s.pu.email}>${s.pu.orgFunction ? `, ${s.pu.orgFunction}` : ''}`,
    `Source: ${inbound.source} ${inbound.kind}`,
    `Title: ${inbound.title}`,
    t ? `Ticket ${t.key}, status ${t.status}, assignee ${t.assignee ?? 'unassigned'}` : '',
    ...fresh.map((m) => `From: ${who(m)}${m.to?.length ? `\nTo: ${m.to.join(', ')}` : ''}${m.cc?.length ? `\nCc: ${m.cc.join(', ')}` : ''}\n${clip(stripQuoted(m.text), Math.floor(max / Math.max(1, fresh.length)))}`),
    earlier.length ? `Earlier in the conversation:\n${earlier.map((m) => `${who(m)}: ${clip(stripQuoted(m.text), 300)}`).join('\n')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
const candidateState = (msg: string, c: { title: string; summary: string }) => `${clip(msg, 1600)}\n\nCandidate work stream: ${c.title}\nIts overview: ${clip(c.summary.replace(/\s+/g, ' '), 500)}`;

export class LayaService {
  private training: Partial<Record<LayaPart, boolean>> = {};
  private trainMessage = '';

  constructor(
    private db: Database,
    private repo: Repo,
    readonly manager: LayaManager,
    private settings: () => Promise<Settings>,
    private canRun: boolean,
  ) {}

  /** Laya is chosen for triage and allowed here (local hosting). Examples are collected from then on, even before it is installed. */
  async active(s?: Settings) {
    const cfg = s ?? (await this.settings());
    return this.canRun && cfg.triage?.engine === 'laya';
  }
  /** Installed, so it can answer and train. */
  get installed() {
    return this.manager.install.state === 'installed';
  }

  // ---------- part records ----------

  private async part(p: LayaPart): Promise<PartRecord> {
    return pj(await this.repo.getSync(`laya.part.${p}`), { state: 'collecting', version: 0, trainedAt: null, windowAfter: 0 } as PartRecord);
  }
  private async setPart(p: LayaPart, r: PartRecord) {
    await this.repo.setSync(`laya.part.${p}`, JSON.stringify(r));
  }
  private async needed(p: LayaPart) {
    const v = Number(await this.repo.getSync(`laya.needed.${p}`));
    return v > 0 ? v : DEFAULT_NEEDED[p];
  }

  // ---------- per message ----------

  async context(itemId: string, inbound: InboundItem, fresh: ThreadMessage[], existingStreamId: string | null, s: Settings): Promise<LayaContext> {
    const item = await this.repo.getItem(itemId);
    const candidates = existingStreamId
      ? []
      : await shortlistStreams(this.repo, { title: inbound.title, messages: fresh, puIds: [s.pu.email, ...(s.pu.aliases ?? [])].filter(Boolean), exclude: item?.data.notRelevantTo ?? [] });
    return { itemId, title: inbound.title, inbound, fresh, existingStreamId, candidates, state: messageState(s, inbound, fresh) };
  }

  /** Ask Laya about every trained part. Never throws: a failure means Claude decides, as before. */
  async assess(ctx: LayaContext): Promise<Assessment | null> {
    if (!this.installed) return null;
    try {
      const out: Assessment = { live: [] };
      for (const { id: p } of LAYA_PARTS) {
        const rec = await this.part(p);
        if (rec.state === 'collecting' || rec.version === 0) continue;
        if (rec.state === 'live') out.live.push(p);
        const heads = this.manager.headsDir(p, rec.version);
        if (p === 'relevance') {
          const a = await this.ask(heads, ctx.state, p);
          out.relevance = { yes: a.noul >= 0.5, p: a.noul, sure: a.route === 'auto' };
        } else if (p === 'next') {
          const a = await this.ask(heads, ctx.state, p);
          out.next = { step: a.choice as NextStep, p: a.answer_confidence ?? 0, sure: a.route === 'auto' };
        } else if (!ctx.existingStreamId) {
          const cands = [];
          for (const c of ctx.candidates) {
            const a = await this.ask(heads, candidateState(ctx.state, c), p);
            cands.push({ id: c.id, p: a.noul, sure: a.route === 'auto' });
          }
          const allSure = cands.every((c) => c.sure);
          const yes = cands.filter((c) => c.p >= 0.5);
          out.stream = { candidates: cands, pick: !allSure ? null : yes.length === 0 ? 'new' : yes.length === 1 ? yes[0].id : null };
        }
      }
      return out;
    } catch (e: any) {
      console.error('[laya] assess:', e.message);
      return null;
    }
  }

  private async ask(heads: string, state: string, p: LayaPart) {
    const r = await this.manager.call<{ answers: Record<string, any> }>('/predict', { heads, state, questions: QUESTIONS[p] });
    const a = r.answers[QID[p]];
    if (!a) throw new Error(`no answer for ${p}`);
    return a;
  }

  /**
   * What Laya can decide on its own, using live parts it is sure about. Returns null when Claude is needed.
   * `needsNewStream`: Laya decided this starts a new stream, which Claude still names and summarises.
   */
  decideAlone(a: Assessment | null, ctx: LayaContext): (ClaudeLike & { needsNewStream: boolean; confidence: number }) | null {
    if (!a?.relevance || !a.live.includes('relevance') || !a.relevance.sure) return null;
    if (!a.relevance.yes)
      return { relevant: false, stream: ctx.existingStreamId ? { action: 'existing', streamId: ctx.existingStreamId } : { action: 'none', streamId: null }, next: { type: 'none' }, needsNewStream: false, confidence: 1 - a.relevance.p };
    let stream: ClaudeLike['stream'];
    if (ctx.existingStreamId) stream = { action: 'existing', streamId: ctx.existingStreamId };
    else if (a.live.includes('stream') && a.stream?.pick) stream = a.stream.pick === 'new' ? { action: 'new', streamId: null } : { action: 'existing', streamId: a.stream.pick };
    else return null;
    if (!a.live.includes('next') || !a.next?.sure) return null;
    return { relevant: true, stream, next: { type: a.next.step }, needsNewStream: stream.action === 'new', confidence: a.relevance.p };
  }

  /** Record what Laya decided by itself (live). Corrections the PU makes later are counted against these. */
  async recordLive(ctx: LayaContext, a: Assessment, d: ClaudeLike) {
    const parts: LayaPart[] = ['relevance'];
    if (d.relevant && !ctx.existingStreamId) parts.push('stream');
    if (d.relevant) parts.push('next');
    for (const p of parts) {
      const rec = await this.part(p);
      await this.db
        .insertInto('laya_compare')
        .values({ at: now(), part: p, item_id: ctx.itemId, title: ctx.title, version: rec.version, laya: JSON.stringify(this.layaValue(p, a, d)), claude: 'null', agree: null, live: 1, corrected: 0 })
        .execute();
    }
    await this.audit('laya.decided', { itemId: ctx.itemId, relevant: d.relevant, stream: d.stream, next: d.next.type });
    this.changed();
  }

  private layaValue(p: LayaPart, a: Assessment, d?: ClaudeLike) {
    if (p === 'relevance') return a.relevance ? a.relevance.yes : null;
    if (p === 'next') return a.next ? a.next.step : null;
    if (d) return d.stream.action === 'new' ? 'new' : d.stream.streamId;
    return a.stream?.pick ?? null;
  }

  /** After Claude decided: store training examples from its decision and compare Laya's answers with it. */
  async learn(ctx: LayaContext, a: Assessment | null, d: ClaudeLike) {
    try {
      await this.example('relevance', ctx.itemId, '', ctx.state, d.relevant, 'claude');
      if (d.relevant) await this.example('next', ctx.itemId, '', ctx.state, d.next.type, 'claude');
      const streamChoice = d.relevant && !ctx.existingStreamId && d.stream.action !== 'none' ? (d.stream.action === 'new' ? 'new' : d.stream.streamId) : undefined;
      if (streamChoice !== undefined) {
        const cands = [...ctx.candidates];
        if (streamChoice !== 'new' && streamChoice && !cands.some((c) => c.id === streamChoice)) {
          const chosen = await this.repo.getStream(streamChoice);
          if (chosen) cands.push(chosen);
        }
        for (const c of cands) await this.example('stream', ctx.itemId, c.id, candidateState(ctx.state, c), c.id === streamChoice, 'claude');
      }
      if (a) {
        const pairs: [LayaPart, unknown, unknown, boolean][] = [];
        if (a.relevance) pairs.push(['relevance', a.relevance.yes, d.relevant, a.relevance.sure]);
        if (a.next && d.relevant) pairs.push(['next', a.next.step, d.next.type, a.next.sure]);
        if (a.stream && streamChoice !== undefined) pairs.push(['stream', a.stream.pick, streamChoice, a.stream.pick !== null]);
        for (const [p, lv, cv, sure] of pairs) {
          const rec = await this.part(p);
          await this.db
            .insertInto('laya_compare')
            .values({ at: now(), part: p, item_id: ctx.itemId, title: ctx.title, version: rec.version, laya: JSON.stringify(lv), claude: JSON.stringify(cv), agree: sure ? (lv === cv ? 1 : 0) : null, live: 0, corrected: 0 })
            .execute();
        }
      }
      for (const { id: p } of LAYA_PARTS) await this.evaluate(p);
      void this.trainWhenReady();
      this.changed();
    } catch (e: any) {
      console.error('[laya] learn:', e.message);
    }
  }

  private async example(part: LayaPart, itemId: string, candidate: string, state: string, gold: unknown, source: 'claude' | 'pu') {
    const ex = await this.db.selectFrom('laya_examples').select(['id', 'source']).where('part', '=', part).where('item_id', '=', itemId).where('candidate', '=', candidate).executeTakeFirst();
    const g = JSON.stringify({ [QID[part]]: gold });
    if (ex) {
      if (ex.source === 'pu' && source === 'claude') return; // the PU's correction wins over a later Claude decision
      await this.db.updateTable('laya_examples').set({ state, gold: g, source, updated_at: now() }).where('id', '=', ex.id).execute();
    } else {
      await this.db.insertInto('laya_examples').values({ id: nanoid(12), part, item_id: itemId, candidate, state, gold: g, source, created_at: now(), updated_at: now() }).execute();
    }
  }

  // ---------- the PU's corrections ----------

  /**
   * The PU corrected triage. Corrections become training examples (they override Claude's), re-score shadow
   * comparisons against the PU's answer, and count against Laya if Laya made the decision.
   */
  async correction(itemId: string, c: { kind: 'relevant' } | { kind: 'notInStream'; streamId: string } | { kind: 'moved'; toStreamId: string } | { kind: 'newStream' }) {
    try {
      const item = await this.repo.getItem(itemId);
      if (!item) return;
      const s = await this.settings();
      if (c.kind === 'relevant' || c.kind === 'moved' || c.kind === 'newStream') {
        const state = (await this.exampleState('relevance', itemId)) ?? this.stateFromItem(s, item);
        await this.example('relevance', itemId, '', state, true, 'pu');
        await this.rescore('relevance', itemId, true);
      }
      if (c.kind === 'notInStream') {
        const row = await this.db.selectFrom('laya_examples').select(['state']).where('part', '=', 'stream').where('item_id', '=', itemId).where('candidate', '=', c.streamId).executeTakeFirst();
        if (row) await this.example('stream', itemId, c.streamId, row.state, false, 'pu');
        await this.rescore('stream', itemId, null, c.streamId);
      }
      if (c.kind === 'moved') {
        const to = await this.repo.getStream(c.toStreamId);
        const rows = await this.db.selectFrom('laya_examples').select(['candidate', 'state']).where('part', '=', 'stream').where('item_id', '=', itemId).execute();
        const base = (await this.exampleState('relevance', itemId)) ?? this.stateFromItem(s, item);
        for (const r of rows) await this.example('stream', itemId, r.candidate, r.state, r.candidate === c.toStreamId, 'pu');
        if (to && !rows.some((r) => r.candidate === to.id)) await this.example('stream', itemId, to.id, candidateState(base, to), true, 'pu');
        await this.rescore('stream', itemId, c.toStreamId);
      }
      if (c.kind === 'newStream') {
        // The PU put it in a stream of its own: it belongs to none of the streams it was compared with.
        const rows = await this.db.selectFrom('laya_examples').select(['candidate', 'state']).where('part', '=', 'stream').where('item_id', '=', itemId).execute();
        for (const r of rows) await this.example('stream', itemId, r.candidate, r.state, false, 'pu');
        await this.rescore('stream', itemId, 'new');
      }
      for (const { id: p } of LAYA_PARTS) await this.evaluate(p);
      await this.nudge();
      this.changed();
    } catch (e: any) {
      console.error('[laya] correction:', e.message);
    }
  }

  /** Once per trained version: tell the PU when corrections show a live part slipping below the threshold. */
  private async nudge() {
    for (const ps of (await this.status()).parts) {
      if (!ps.suggestRetrain) continue;
      const key = `laya.nudged.${ps.part}.${ps.version}`;
      if (await this.repo.getSync(key)) continue;
      await this.repo.setSync(key, now());
      const label = LAYA_PARTS.find((x) => x.id === ps.part)!.label;
      bus.publish({ type: 'notify', streamId: null, title: 'Laya may need retraining', body: `You corrected Laya on "${label}" often enough that it's right only ${Math.round((100 * ps.agreed) / ps.compared)}% of the time lately. Retrain it in Settings → Triage.` });
    }
  }

  private async exampleState(part: LayaPart, itemId: string) {
    return (await this.db.selectFrom('laya_examples').select(['state']).where('part', '=', part).where('item_id', '=', itemId).where('candidate', '=', '').executeTakeFirst())?.state;
  }
  private stateFromItem(s: Settings, item: StreamItem) {
    const msgs = item.data.messages ?? item.data.ticket?.comments ?? [];
    return messageState(s, { source: item.source, kind: item.kind, externalId: item.externalId, title: item.title, data: item.data, eventId: '' }, msgs.slice(-1));
  }

  /** The latest comparison for this item and part: score it against the PU's answer instead. `wrong`: a stream the PU said is not right. */
  private async rescore(part: LayaPart, itemId: string, truth: unknown, wrong?: string) {
    const row = await this.db.selectFrom('laya_compare').selectAll().where('part', '=', part).where('item_id', '=', itemId).orderBy('id', 'desc').executeTakeFirst();
    if (!row) return;
    const laya = JSON.parse(row.laya);
    if (row.live) {
      const corrected = wrong !== undefined ? laya === wrong : laya !== truth;
      if (corrected) await this.db.updateTable('laya_compare').set({ corrected: 1 }).where('id', '=', row.id).execute();
      return;
    }
    const claude = wrong !== undefined ? (JSON.parse(row.claude) === wrong ? 'wrong' : JSON.parse(row.claude)) : truth;
    const agree = row.agree === null ? null : wrong !== undefined ? (laya === wrong ? 0 : row.agree) : laya === truth ? 1 : 0;
    await this.db.updateTable('laya_compare').set({ claude: JSON.stringify(claude), agree, corrected: 1 }).where('id', '=', row.id).execute();
  }

  // ---------- qualifying and switching ----------

  private async window(p: LayaPart, rec: PartRecord, live: boolean, n: number) {
    return this.db
      .selectFrom('laya_compare')
      .select(['agree', 'corrected'])
      .where('part', '=', p)
      .where('version', '=', rec.version)
      .where('live', '=', live ? 1 : 0)
      .where('id', '>', rec.windowAfter)
      .orderBy('id', 'desc')
      .limit(n)
      .execute();
  }

  /** A shadowing part that agrees often enough over enough messages is offered to the PU (never switched silently). */
  private async evaluate(p: LayaPart) {
    const rec = await this.part(p);
    if (rec.state !== 'shadowing') return;
    const s = await this.settings();
    const n = s.triage.minMessages;
    const rows = (await this.window(p, rec, false, n * 3)).filter((r) => r.agree !== null).slice(0, n);
    if (rows.length < n) return;
    const agreed = rows.filter((r) => r.agree === 1).length;
    if (agreed / rows.length < s.triage.agreeThreshold) return;
    await this.setPart(p, { ...rec, state: 'proposed' });
    const label = LAYA_PARTS.find((x) => x.id === p)!.label;
    bus.publish({ type: 'notify', streamId: null, title: 'Laya is ready', body: `Laya agreed with Claude on "${label}" ${Math.round((100 * agreed) / rows.length)}% of the time over ${rows.length} messages. Switch it on in Settings → Triage.` });
    await this.audit('laya.proposed', { part: p, agreed, of: rows.length, version: rec.version });
  }

  async accept(p: LayaPart) {
    const rec = await this.part(p);
    if (rec.state !== 'proposed') throw new Error('Laya has not qualified for this part yet');
    await this.setPart(p, { ...rec, state: 'live' });
    await this.audit('laya.live', { part: p, version: rec.version });
    this.changed();
  }
  /** "Not yet": keep shadowing, and only count messages from now on before offering again. */
  async decline(p: LayaPart) {
    const rec = await this.part(p);
    const last = await this.db.selectFrom('laya_compare').select('id').orderBy('id', 'desc').executeTakeFirst();
    await this.setPart(p, { ...rec, state: rec.version ? 'shadowing' : 'collecting', windowAfter: last?.id ?? 0 });
    await this.audit('laya.declined', { part: p });
    this.changed();
  }
  /** Hand a live part back to Claude; Laya keeps shadowing it. */
  async stopUsing(p: LayaPart) {
    await this.decline(p);
  }

  // ---------- training ----------

  private async counts(p: LayaPart) {
    const rows = await this.db.selectFrom('laya_examples').select(['gold']).where('part', '=', p).execute();
    return { n: rows.length, labels: new Set(rows.map((r) => r.gold)).size };
  }

  private autoRun: Promise<void> | null = null;

  /** First training happens by itself once there are enough examples; after that, only when the PU asks. */
  trainWhenReady(): Promise<void> {
    if (this.autoRun) return this.autoRun;
    this.autoRun = (async () => {
      if (!(await this.active()) || !this.installed) return;
      for (const { id: p } of LAYA_PARTS) {
        const rec = await this.part(p);
        if (rec.state !== 'collecting' || rec.version > 0 || this.training[p]) continue;
        const c = await this.counts(p);
        if (c.labels < 2) continue;
        await this.refreshNeeded(p);
        if (c.n >= (await this.needed(p))) await this.train(p).catch(() => undefined);
      }
    })().finally(() => (this.autoRun = null));
    return this.autoRun;
  }

  /** Ask Laya how many examples these questions need (its own rule), once. */
  private async refreshNeeded(p: LayaPart) {
    if (Number(await this.repo.getSync(`laya.needed.${p}`)) > 0) return;
    const r = await this.manager.call<{ rows: number }>('/min_rows', { questions: QUESTIONS[p] }).catch(() => null);
    if (r?.rows) await this.repo.setSync(`laya.needed.${p}`, String(r.rows));
  }

  /** Train (or retrain) a part. The new version shadows Claude from scratch, even if the part was live. */
  async train(p: LayaPart) {
    if (this.training[p]) throw new Error('Already training');
    this.training[p] = true;
    this.trainMessage = `Training "${LAYA_PARTS.find((x) => x.id === p)!.label}"…`;
    this.changed();
    try {
      await this.refreshNeeded(p);
      const rows = (await this.db.selectFrom('laya_examples').select(['state', 'gold']).where('part', '=', p).orderBy('updated_at', 'desc').limit(MAX_TRAIN_ROWS).execute()).map((r) => ({ state: r.state, gold: JSON.parse(r.gold) }));
      const needed = await this.needed(p);
      if (rows.length < needed) throw new Error(`Needs ${needed} examples; has ${rows.length}`);
      const rec = await this.part(p);
      const version = rec.version + 1;
      const r = await this.manager.call<{ report: any }>('/fit', { rows, questions: QUESTIONS[p], out: this.manager.headsDir(p, version) });
      const head = r.report?.heads?.[QID[p]];
      if (head && head.fitted === false) throw new Error(head.reason || 'Laya could not learn from these examples yet');
      await this.setPart(p, { state: 'shadowing', version, trainedAt: now(), windowAfter: 0, message: head?.cv_accuracy !== undefined ? `Training accuracy ${Math.round(head.cv_accuracy * 100)}% on held-out examples` : undefined });
      await this.audit('laya.trained', { part: p, version, rows: rows.length, cvAccuracy: head?.cv_accuracy, servedByHead: head?.used_by_auto });
      this.trainMessage = '';
    } catch (e: any) {
      const rec = await this.part(p);
      await this.setPart(p, { ...rec, message: `Training failed: ${e.message}` });
      this.trainMessage = `Training failed: ${e.message}`;
      throw e;
    } finally {
      this.training[p] = false;
      this.changed();
    }
  }

  // ---------- status ----------

  async status(): Promise<LayaStatus> {
    const s = await this.settings();
    const parts: LayaPartStatus[] = [];
    for (const { id: p } of LAYA_PARTS) {
      const rec = await this.part(p);
      const c = await this.counts(p);
      const live = rec.state === 'live';
      const n = s.triage.minMessages;
      const rows = live ? await this.window(p, rec, true, n) : (await this.window(p, rec, false, n * 3)).filter((r) => r.agree !== null).slice(0, n);
      const agreed = live ? rows.filter((r) => !r.corrected).length : rows.filter((r) => r.agree === 1).length;
      parts.push({
        part: p,
        state: rec.state,
        examples: c.n,
        examplesNeeded: await this.needed(p),
        compared: rows.length,
        agreed,
        suggestRetrain: live && rows.length >= MIN_LIVE_FOR_NUDGE && agreed / rows.length < s.triage.agreeThreshold,
        trainedAt: rec.trainedAt,
        version: rec.version,
      });
    }
    const dis = await this.db
      .selectFrom('laya_compare')
      .selectAll()
      .where((eb) => eb.or([eb('agree', '=', 0), eb('corrected', '=', 1)]))
      .orderBy('id', 'desc')
      .limit(25)
      .execute();
    const name = async (v: unknown) => {
      if (typeof v === 'boolean') return v ? 'needs you' : 'no action needed';
      if (v === 'new') return 'a new work stream';
      if (v === null || v === undefined) return 'unsure';
      if (typeof v === 'string' && (await this.repo.getStream(v))) return `"${(await this.repo.getStream(v))!.title}"`;
      return String(v);
    };
    const disagreements = [];
    for (const r of dis) disagreements.push({ at: r.at, part: r.part as LayaPart, itemId: r.item_id, title: r.title, laya: await name(JSON.parse(r.laya)), claude: r.live ? 'you corrected it' : await name(JSON.parse(r.claude)) });
    const anyTraining = Object.values(this.training).some(Boolean);
    return {
      install: this.manager.install,
      server: { running: this.manager.running, message: this.manager.serverMessage },
      training: { running: anyTraining, message: this.trainMessage || undefined },
      parts,
      disagreements,
    };
  }

  private changed() {
    void this.status()
      .then((status) => bus.publish({ type: 'laya.status', status }))
      .catch(() => undefined);
  }
  notify() {
    this.changed();
  }

  private audit(action: string, detail: unknown) {
    return this.repo.audit('laya', action, detail);
  }
}
