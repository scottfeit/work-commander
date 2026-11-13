import { z } from 'zod';
import type { StreamItem, Settings, ThreadMessage } from '@wc/shared';
import { Repo } from '../core/repo.js';
import { bus } from '../core/bus.js';
import type { InboundItem } from '../integrations/types.js';
import { stripQuoted } from '../integrations/types.js';
import type { AgentBackend } from './backend.js';
import type { StreamAgentRunner } from './runner.js';
import { TOPIC_SPLIT_RULES, TRIAGE_RULES, playbookBlock, puBlock, streamsBlock } from './prompts.js';
import { referencesPU } from '../core/mentions.js';
import { timeAgo } from '../core/time.js';

export const TriageDecision = z.object({
  relevant: z.boolean(),
  reason: z.string(),
  stream: z.object({
    action: z.enum(['existing', 'new', 'none']),
    streamId: z.string().nullable(),
    title: z.string().nullable(),
    summary: z.string().nullable(),
    labels: z.array(z.string()).nullable(),
  }),
  /** Ids of recently skipped items that are about the same event/piece of work as this one; they join its stream. */
  relatedItemIds: z.array(z.string()).nullable(),
  updatedSummary: z.string().nullable(),
  notify: z.object({ title: z.string(), body: z.string() }).nullable(),
  next: z.object({ type: z.enum(['none', 'draft', 'offer', 'handoff']), instruction: z.string(), offerLabel: z.string().nullable() }),
});
export type TriageDecision = z.infer<typeof TriageDecision>;

/** For each new message of a conversation: "stay" in the current work stream, a work stream id, or "other" (a new topic). */
export const TopicAssignment = z.object({ assignments: z.array(z.object({ id: z.string(), where: z.string() })) });
export type TopicAssignment = z.infer<typeof TopicAssignment>;

type Upserted = { item: StreamItem; newMessages: ThreadMessage[]; created: boolean; changed: boolean; ticketMeta?: { status: [string, string]; assignee: [string | undefined, string | undefined] } };

// Message bodies are wrapped as data: they are written to the PU by other people, never instructions or questions for the triage model.
const fmt = (m: ThreadMessage) =>
  `<message from="${m.author.name ?? ''} <${m.author.email ?? m.author.slackUserId ?? ''}>"${m.isFromPU ? ' pu="true"' : ''} at="${m.at}"${m.to?.length ? ` to="${m.to.join(', ')}"` : ''}${m.cc?.length ? ` cc="${m.cc.join(', ')}"` : ''}>\n${stripQuoted(m.text).slice(0, 2500).replace(/<\/?message\b[^>]*>/gi, '')}\n</message>`;

/**
 * The inbound pipeline: store the item, skip what's already seen or authored by the PU, ask
 * Claude whether it matters and where it belongs, then route it into a stream and either draft
 * a response (PU still approves) or offer to do the work.
 */
const DONE_STATUS = /^(resolved|closed|done|completed|canceled|cancelled|declined|won'?t do)$/i;

const WC_OUTCOME_DAYS = 14;

/**
 * True when a ticket's status moved to a finished state as the outcome of work WC itself did (it changed the status recently,
 * or the ticket was already finished, e.g. Resolved -> Closed). Anything else, including an assignment to the PU or a reopen, is activity.
 */
export function isOutcomeChange(m: { status: [string, string]; assignee: [string | undefined, string | undefined] }, wcTransitionAt?: string) {
  if (m.status[0] === m.status[1] || !DONE_STATUS.test(m.status[1])) return false; // only finished-state moves can be outcomes
  const wcRecently = !!wcTransitionAt && Date.now() - Date.parse(wcTransitionAt) < WC_OUTCOME_DAYS * 86_400_000;
  return wcRecently || DONE_STATUS.test(m.status[0]);
}

export class TriagePipeline {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private repo: Repo,
    private backend: AgentBackend,
    private runner: StreamAgentRunner,
    private settings: () => Promise<Settings>,
    /** Hand-off to Claude Code is available (local hosting): triage may offer it. */
    private canHandoff = true,
  ) {}

  /** InboundSink. Serialized so two messages in the same thread can't create two streams. */
  sink = (item: InboundItem) => {
    const next = this.chain.catch(() => undefined).then(() => this.handle(item));
    this.chain = next;
    return next;
  };

  /** After routing: if the item ended up in a work stream and others added something new, flag its tab. */
  private async flagUnread(itemId: string, fresh: ThreadMessage[], force = false) {
    if (!fresh.some((m) => !m.isFromPU)) return;
    await this.repo.markItemUnread(itemId, force);
  }

  /**
   * Judge events that were recorded but never finished (the server stopped, or the computer slept, in the middle of triage).
   * Events are de-duplicated on arrival, so without this they would be skipped for good.
   */
  async recoverUnprocessed(olderThanMs = 3 * 60_000, limit = 10) {
    let recovered = 0;
    for (const ev of await this.repo.listUnprocessedInbound(olderThanMs, limit)) {
      const next = this.chain.catch(() => undefined).then(() => this.recoverOne(ev));
      this.chain = next;
      try {
        await next;
        recovered++;
      } catch (e: any) {
        console.error('[triage recovery]', e.message); // stays unprocessed; retried on the next pass
      }
    }
    return recovered;
  }

  private async recoverOne(ev: { source: string; external_id: string; item_id: string | null }) {
    const item = ev.item_id ? await this.repo.getItem(ev.item_id) : null;
    if (!item) return this.repo.markInbound(ev.source, ev.external_id, false, { skipped: 'item no longer exists' });
    if (!item.streamId) {
      const linked = await this.autoLink(item);
      if (linked) return this.repo.markInbound(ev.source, ev.external_id, true, { recovered: true, linked: linked.streamId, reason: 'References a ticket an open work stream already tracks' });
    }
    const all = item.data.messages ?? item.data.ticket?.comments ?? [];
    const lastPU = all.map((m) => !!m.isFromPU).lastIndexOf(true);
    const fresh = all.slice(lastPU + 1).filter((m) => !m.isFromPU);
    if (!fresh.length && item.kind !== 'ticket') return this.repo.markInbound(ev.source, ev.external_id, false, { skipped: 'nothing new from others' });
    let brokeThrough = false;
    if (item.streamId && item.data.muted) {
      const cfg = await this.settings();
      brokeThrough = !!cfg.silencing?.mentionsOverride && !cfg.silencing.skipPolling && referencesPU(fresh, cfg.pu);
      if (!brokeThrough) return this.repo.markInbound(ev.source, ev.external_id, false, { skipped: 'item is silenced' });
    }
    const inbound: InboundItem = { source: item.source, kind: item.kind, externalId: item.externalId, title: item.title, url: item.url, data: item.data, eventId: ev.external_id };
    const s = await this.settings();
    const decision = await this.decide(inbound, item.streamId, fresh.length ? fresh : all.slice(-1), s);
    await this.repo.markInbound(ev.source, ev.external_id, decision.relevant, { ...decision, recovered: true });
    await this.route(inbound, item, decision, s);
    await this.flagUnread(item.id, fresh, brokeThrough);
  }

  async handle(inbound: InboundItem) {
    // "Don't poll silenced items": a silenced thread is not even stored while it is silenced (it catches up once it is un-silenced).
    const sil = (await this.settings()).silencing;
    if (sil?.skipPolling) {
      const there = await this.repo.findExistingItem(inbound.source, inbound.externalId);
      if (there?.streamId && there.data.muted) return;
    }
    const up = await this.repo.upsertItem(inbound);
    // A DM or group DM can run several topics; each goes to the work stream it belongs to and is judged there on its own.
    const parts = await this.splitByTopic(inbound, up);
    for (const [n, part] of parts.entries()) await this.processUpdate(n ? { ...inbound, eventId: `${inbound.eventId}#${n}` } : inbound, part, sil);
  }

  /**
   * New messages in a flowing Slack conversation that is already in work streams: decide, message by message, which stream's topic
   * each continues. What continues no listed topic goes to the conversation's "no stream" item, where ordinary triage decides
   * between an existing stream, a new one or not relevant. Returns the groups that now need triage (the original update when nothing moved).
   */
  private async splitByTopic(inbound: InboundItem, up: Upserted): Promise<Upserted[]> {
    const channel = inbound.data.slack?.channel;
    if (!up.changed || inbound.source !== 'slack' || !channel || !up.newMessages.length) return [up];
    const s = await this.settings();
    if (s.claude.splitSlackByTopic === false) return [up];
    const family = await this.repo.slackFamily(channel);
    if (!Repo.slackIsFlat(channel, family)) return [up];
    const streamIds = [...new Set(family.map((i) => i.streamId).filter((x): x is string => !!x))];
    if (!streamIds.length) return [up]; // nothing to split from yet: triage files the whole conversation
    const streams = new Map<string, NonNullable<Awaited<ReturnType<Repo['getStream']>>>>();
    for (const id of streamIds) {
      const st = await this.repo.getStream(id);
      if (st) streams.set(id, st);
    }
    if (!streams.size) return [up];
    const where = new Map<string, string>(); // message id -> stream title
    const all: ThreadMessage[] = [];
    for (const it of family) for (const m of it.data.messages ?? []) {
      where.set(m.id, it.streamId ? streams.get(it.streamId)?.title ?? '?' : '(no work stream)');
      all.push(m);
    }
    all.sort((a, b) => a.at.localeCompare(b.at));
    const fresh = new Set(up.newMessages.map((m) => m.id));
    const recent = all.filter((m) => !fresh.has(m.id)).slice(-12);
    const current = up.item.streamId;
    const label = (m: ThreadMessage) => fmt(m).replace('<message ', `<message id="${m.id}" stream="${where.get(m.id) ?? '?'}" `);
    const prompt = [
      `Work streams holding parts of this conversation ("${up.item.title}"):`,
      ...[...streams.values()].map((st) => `- id ${st.id}${st.id === current ? ' (current: the new messages were filed here)' : ''}: "${st.title}"${st.status === 'closed' ? ' [closed]' : ''}. ${st.summary.replace(/\s+/g, ' ').slice(0, 400)}`),
      current ? '' : 'The new messages were filed into the conversation\'s "no work stream" item (current).',
      `Recent messages:\n${recent.map(label).join('\n\n') || '(none)'}`,
      `NEW messages (say where each belongs):\n${up.newMessages.map(label).join('\n\n')}`,
      'Answer with one assignment per NEW message id.',
    ]
      .filter(Boolean)
      .join('\n\n');
    let res: TopicAssignment;
    try {
      res = await this.backend.structured({ systemPrompt: TOPIC_SPLIT_RULES, prompt, schema: TopicAssignment });
    } catch (e: any) {
      console.error('[topic split]', e.message); // keep the conversation together rather than lose messages
      return [up];
    }
    const dest = new Map<string | null, ThreadMessage[]>(); // undefined -> stays
    const pick = new Map((res?.assignments ?? []).map((a) => [a.id, a.where]));
    for (const m of up.newMessages) {
      const w = pick.get(m.id) ?? 'stay';
      const to = w === 'other' ? null : streams.has(w) && w !== current ? w : current;
      if (to === current) continue;
      dest.set(to, [...(dest.get(to) ?? []), m]);
    }
    if (!dest.size) return [up];
    const stayCount = up.newMessages.length - [...dest.values()].reduce((n, x) => n + x.length, 0);
    const out: Upserted[] = [];
    for (const [toStreamId, msgs] of dest) {
      const r = await this.repo.placeSlackMessages({ channel, toStreamId, messages: msgs, title: up.item.title, channelName: up.item.data.slack?.channelName, flat: true });
      if (!r.item) continue;
      out.push({ item: r.item, newMessages: msgs, created: !!r.created, changed: true });
    }
    // what stayed (if anything) is judged where it is, first
    const stay = stayCount ? await this.repo.getItem(up.item.id) : null;
    const rest = stay ? [{ ...up, item: stay, newMessages: up.newMessages.filter((m) => !out.some((o) => o.newMessages.includes(m))) }] : [];
    return [...rest, ...out];
  }

  /** The decisions after an item was stored: silencing, linking, triage, routing. */
  private async processUpdate(inbound: InboundItem, up: Upserted, sil: Settings['silencing']) {
    let item = up.item;
    const { newMessages, created, changed } = up;
    if (!changed) return;
    if (!(await this.repo.recordInbound(inbound.source, inbound.eventId, item.id))) return;
    // A silenced item keeps receiving updates (already stored above) but makes no noise: no triage, notification, unread dot or reopening.
    let brokeThrough = false;
    if (item.streamId && item.data.muted) {
      // ...unless the PU chose to let direct references through (not possible when silenced items aren't polled at all).
      const others = newMessages.filter((m) => !m.isFromPU);
      brokeThrough = !!sil?.mentionsOverride && !sil.skipPolling && referencesPU(others, (await this.settings()).pu);
      if (!brokeThrough) {
        await this.repo.markInbound(inbound.source, inbound.eventId, false, { skipped: 'item is silenced' });
        return;
      }
    }
    if (!item.streamId) item = (await this.autoLink(item)) ?? item;
    // A ticket moved to Resolved/Closed as the result of work WC did, with nothing new said on it, is not new activity: it must not
    // trigger triage or withdraw a pending "close this stream" proposal. (An assignment to the PU, a reopen etc. still are.)
    if (item.streamId && up.ticketMeta && newMessages.length === 0 && isOutcomeChange(up.ticketMeta, item.data.wcTransitionAt)) {
      await this.repo.markInbound(inbound.source, inbound.eventId, false, { skipped: 'ticket moved to a finished state as an outcome of the work, not new activity' });
      return;
    }
    const fresh = newMessages.length ? newMessages : (item.data.messages ?? item.data.ticket?.comments ?? []).slice(-1);
    const fromOthers = fresh.filter((m) => !m.isFromPU);
    // New activity from others (or a ticket change) takes a pending stream out of Pending and to the top; the PU's own messages don't.
    const fromOthersNew = newMessages.some((m) => !m.isFromPU) || !!up.ticketMeta;
    if (item.streamId) await this.repo.updateStream(item.streamId, { touch: true, ...(fromOthersNew ? { pending: false } : {}) });
    if (fromOthers.length === 0 && !(inbound.kind === 'ticket' && (created || newMessages.length === 0))) {
      await this.repo.markInbound(inbound.source, inbound.eventId, false, { skipped: 'authored by PU' });
      if (item.streamId && !created) await this.noteDirectReply(item, newMessages.filter((m) => m.isFromPU));
      return;
    }

    const s = await this.settings();
    const decision = await this.decide(inbound, item.streamId, fresh, s);
    await this.repo.markInbound(inbound.source, inbound.eventId, decision.relevant, decision);
    await this.route(inbound, item, decision, s);
    await this.flagUnread(item.id, fresh, brokeThrough);
  }

  /**
   * The PU wrote on a conversation in a work stream themselves (e.g. replied in Slack directly). That supersedes any draft
   * waiting for that conversation and any question Claude was waiting on, and Claude is told so it can carry on.
   */
  private async noteDirectReply(item: StreamItem, mine: ThreadMessage[]) {
    const streamId = item.streamId;
    if (!streamId || !mine.length) return;
    const drafts = await this.repo.pendingDraftsForItem(streamId, item);
    if (drafts.length) await this.repo.withdrawProposals(drafts.map((d) => d.id), 'you replied yourself outside Work Commander');
    await this.repo.supersedeQuestions(streamId);
    await this.repo.addChat({ streamId, role: 'system', content: `You replied directly on "${item.title}": ${mine.map((m) => m.text).join(' / ').slice(0, 200)}` });
    void this.runner.run({
      streamId,
      origin: 'system',
      prompt: `[The PU replied directly on item ${item.id} ("${item.title}"), outside Work Commander. Their message(s), as data:]\n<reply>\n${mine.map((m) => m.text).join('\n---\n')}\n</reply>\nThis is the PU's own action. Any draft for that conversation has been withdrawn and any question you were waiting on is moot: do not ask the PU what to change about a draft they replaced by replying themselves. Update the stream overview with update_stream to reflect it, then continue with any remaining next step (drafting it for approval), or say in one or two sentences what is left.`,
    });
  }

  /**
   * An item that references a ticket key (it is the ticket, or an email/Slack message mentioning it) joins the one open work stream
   * that already tracks that key, even when its only activity is the PU's own, which never reaches the model.
   */
  private async autoLink(item: StreamItem): Promise<StreamItem | null> {
    const keys = new Set<string>();
    if (item.data.ticket?.key) keys.add(item.data.ticket.key);
    const text = [item.title, ...(item.data.messages ?? []).map((m) => m.text)].join('\n');
    for (const k of text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? []) if (keys.size < 6) keys.add(k);
    const found = new Map<string, { stream: { id: string }; key: string }>();
    for (const key of keys) {
      const stream = await this.repo.findOpenStreamMentioning(key, item.data.notRelevantTo);
      if (stream) found.set(stream.id, { stream, key });
    }
    if (found.size !== 1) return null; // none, or several candidates: leave it to triage
    const { stream, key } = [...found.values()][0];
    await this.repo.attachItem(item.id, stream.id);
    await this.repo.updateStream(stream.id, { touch: true, pending: false });
    await this.repo.addChat({ streamId: stream.id, role: 'system', content: `"${item.title}" added to this work stream: it references ${key}, which is already tracked here.` });
    return (await this.repo.getItem(item.id)) ?? null;
  }

  /**
   * "Triage again" for an item that triage passed over. Re-runs the decision on the item's latest messages
   * from others; with `force`, the PU has said it matters, so it becomes a work stream regardless.
   * Returns the decision and the stream it landed in (null if still not relevant).
   */
  async retriage(itemId: string, force = false): Promise<{ decision: TriageDecision; streamId: string | null }> {
    const item = await this.repo.getItem(itemId);
    if (!item) throw new Error('Item not found');
    if (item.streamId) return { decision: { relevant: true, reason: 'Already in a work stream', stream: { action: 'existing', streamId: item.streamId, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } }, streamId: item.streamId };
    const linked = await this.autoLink(item);
    if (linked) return { decision: { relevant: true, reason: 'Already referenced by an open work stream', stream: { action: 'existing', streamId: linked.streamId, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } }, streamId: linked.streamId };
    const all = item.data.messages ?? item.data.ticket?.comments ?? [];
    // What needs a response: everything others sent since the PU last wrote (or the last message).
    const lastPU = all.map((m) => !!m.isFromPU).lastIndexOf(true);
    const fresh = all.slice(lastPU + 1).filter((m) => !m.isFromPU);
    const inbound: InboundItem = { source: item.source, kind: item.kind, externalId: item.externalId, title: item.title, url: item.url, data: item.data, eventId: `retriage-${Date.now()}` };
    const s = await this.settings();
    let decision = await this.decide(inbound, null, fresh.length ? fresh : all.slice(-1), s);
    // Forcing: if triage names an open stream the item belongs to, file it there; only otherwise start a new stream.
    const namedOpen = decision.stream.action === 'existing' && !!decision.stream.streamId && (await this.repo.listStreams(false)).some((o) => o.id === decision.stream.streamId);
    if (force && namedOpen && !decision.relevant) decision = { ...decision, relevant: true, reason: `Accepted by the PU. Triage said: ${decision.reason}` };
    else if (force && (!decision.relevant || decision.stream.action === 'none')) {
      decision = {
        ...decision,
        relevant: true,
        reason: `Marked relevant by the PU. Triage said: ${decision.reason}`,
        stream: { action: 'new', streamId: null, title: decision.stream.title || item.title.slice(0, 80), summary: decision.stream.summary || decision.reason, labels: decision.stream.labels },
      };
    }
    await this.repo.audit('pu', 'item.retriaged', { itemId, force, relevant: decision.relevant, reason: decision.reason });
    await this.route(inbound, item, decision, s); // even when nothing is needed: the model may still say which stream it belongs to
    await this.flagUnread(itemId, fresh);
    if (!decision.relevant) return { decision, streamId: (await this.repo.getItem(itemId))?.streamId ?? null };
    return { decision, streamId: (await this.repo.getItem(itemId))?.streamId ?? null };
  }

  /** Steps after the decision: pick or create the stream, then draft or offer. */
  private async route(inbound: InboundItem, item: StreamItem, decision: TriageDecision, s: Settings) {
    if (!decision.relevant && !item.streamId) {
      // No action needed, but if triage says it belongs to an open stream, file it there anyway.
      const home = decision.stream.action === 'existing' ? decision.stream.streamId : null;
      if (home && !item.data.notRelevantTo?.includes(home) && (await this.repo.listStreams(false)).some((o) => o.id === home)) {
        await this.repo.attachItem(item.id, home);
        await this.repo.updateStream(home, { touch: true, pending: false });
        await this.repo.addChat({ streamId: home, role: 'system', content: `"${item.title}" added to this work stream (no action needed).` });
      }
      return;
    }

    let streamId = item.streamId;
    if (!streamId) {
      const open = await this.repo.listStreams(false);
      if (decision.stream.action === 'existing' && decision.stream.streamId && !item.data.notRelevantTo?.includes(decision.stream.streamId) && open.some((o) => o.id === decision.stream.streamId)) {
        streamId = decision.stream.streamId;
      } else if (decision.stream.action !== 'none') {
        streamId = (await this.repo.createStream({ title: decision.stream.title || inbound.title.slice(0, 80), summary: decision.stream.summary || decision.reason, labels: decision.stream.labels ?? [] })).id;
      }
      if (streamId) await this.repo.attachItem(item.id, streamId);
    } else {
      const prev = await this.repo.getStream(streamId);
      if (prev?.status === 'closed' && decision.relevant) {
        const days = s.claude.reopenClosedWithinDays ?? 14;
        const closedAt = prev.closedAt ? Date.parse(prev.closedAt) : 0;
        if (Date.now() - closedAt <= days * 86_400_000) {
          await this.repo.updateStream(streamId, { status: 'open' }); // recent: carry on in the same stream
        } else {
          // Closed too long ago: this is new work. Start a fresh stream and move the thread over to it.
          const fresh = await this.repo.createStream({
            title: decision.stream.title || inbound.title.slice(0, 80),
            summary: `${decision.stream.summary || decision.reason} (Follow-up to "${prev.title}", closed ${new Date(closedAt).toLocaleDateString()}.)`,
            labels: decision.stream.labels ?? prev.labels,
            ticketTarget: prev.ticketTarget,
          });
          await this.repo.attachItem(item.id, fresh.id);
          await this.repo.addChat({ streamId: fresh.id, role: 'system', content: `New activity on "${prev.title}", which was closed more than ${days} days ago, so it starts a new work stream.` });
          streamId = fresh.id;
        }
      }
    }
    if (!streamId) return;
    await this.repo.updateStream(streamId, { touch: true, unread: true, pending: false, ...(decision.updatedSummary ? { summary: decision.updatedSummary } : {}) });
    await this.repo.withdrawStaleClose(streamId, `new activity arrived (${inbound.title.slice(0, 60)})`);
    if (!decision.relevant) return;
    // Earlier skipped messages that turn out to be part of the same event join this stream.
    for (const id of (decision.relatedItemIds ?? []).slice(0, 15)) {
      const rel = id === item.id ? null : await this.repo.getItem(id);
      if (!rel || rel.streamId || rel.data.notRelevantTo?.includes(streamId)) continue;
      await this.repo.attachItem(rel.id, streamId);
      await this.repo.addChat({ streamId, role: 'system', content: `"${rel.title}" added to this work stream: it is about the same event (earlier skipped).` });
    }

    if (decision.notify) {
      bus.publish({ type: 'notify', streamId, title: decision.notify.title, body: decision.notify.body });
      await this.repo.addChat({ streamId, role: 'system', content: `${decision.notify.title}: ${decision.notify.body}` });
    }
    if (decision.next.type === 'handoff' && this.canHandoff) {
      // Work for Claude Code: don't draft "I'm looking into it" automatically; ask, with one click for either.
      const open = (await this.repo.listChat(streamId)).some((m) => m.meta.handoffOffer && !m.meta.handoffOffer.dismissed && m.meta.handoffOffer.done.length < 2);
      if (!open)
        await this.repo.addChat({
          streamId,
          role: 'suggestion',
          content: decision.next.offerLabel || `${decision.reason} This looks like work for Claude Code.`,
          meta: { suggestion: { instruction: decision.next.instruction, status: 'open' }, handoffOffer: { task: decision.next.instruction, done: [] } },
        });
    } else if (decision.next.type === 'draft' && s.claude.autoDraft) {
      void this.runner.run({
        streamId,
        origin: 'system',
        prompt: `[New activity on item ${item.id}: ${inbound.title}]\nTriage says: ${decision.reason}\nPrepare drafts for the PU to review: ${decision.next.instruction}\nThen tell the PU in one or two sentences what you prepared.`,
      });
    } else if (decision.next.type === 'offer' || decision.next.type === 'handoff' || (decision.next.type === 'draft' && !s.claude.autoDraft)) {
      await this.repo.addChat({
        streamId,
        role: 'suggestion',
        content: decision.next.offerLabel || decision.next.instruction,
        meta: { suggestion: { instruction: decision.next.instruction, status: 'open' } },
      });
    }
  }

  async decide(inbound: InboundItem, existingStreamId: string | null, fresh: ThreadMessage[], s: Settings): Promise<TriageDecision> {
    const people = await this.repo.listPeople();
    const self = people.find((p) => p.email === s.pu.email.toLowerCase()) ?? null;
    const manager = self?.managerEmail ? people.find((p) => p.email === self.managerEmail) : null;
    const reports = self ? people.filter((p) => p.managerEmail === self.email) : [];
    const msgs = inbound.data.messages ?? inbound.data.ticket?.comments ?? [];
    const participants = new Set<string>();
    for (const m of msgs) for (const e of [m.author.email, ...(m.to ?? []), ...(m.cc ?? [])]) if (e) participants.add(e.toLowerCase());
    const known = people.filter((p) => participants.has(p.email)).map((p) => `${p.name} <${p.email}>: ${p.title ?? ''} ${p.department ?? ''}${p.managerEmail ? `, reports to ${p.managerEmail}` : ''}`);
    // Streams the PU has said this item doesn't belong to are not offered as a home for it.
    const excluded = new Set((await this.repo.findItem(inbound.source, inbound.externalId))?.data.notRelevantTo ?? []);
    const open = (await this.repo.listStreams(false)).filter((o) => !excluded.has(o.id));

    // Deterministic hint: a top-level Slack DM in a channel where a stream recently posted.
    const hints: string[] = [];
    if (inbound.source === 'slack' && inbound.data.slack && !existingStreamId) {
      const rows = await this.repo.db.selectFrom('items').select(['stream_id', 'data']).where('source', '=', 'slack').where('stream_id', 'is not', null).execute();
      for (const r of rows) if (r.data.includes(`"channel":"${inbound.data.slack.channel}"`)) hints.push(`Stream ${r.stream_id} recently messaged in this same Slack conversation.`);
    }
    // Messages triage skipped in the last day: related ones (several alerts about one outage, say) can add up to real work together.
    const self_ = await this.repo.findItem(inbound.source, inbound.externalId);
    const recentSkipped = (await this.repo.listSkipped(1)).filter((x) => x.id !== self_?.id).slice(0, 15);
    const skippedBlock = recentSkipped.length
      ? 'Recently skipped messages (last 24h, in no work stream). If this new message and any of them are about the same event or piece of work, list their ids in relatedItemIds:\n' +
        recentSkipped.map((x) => `- item ${x.id} [${x.source}] "${x.title}"${x.from ? ` from ${x.from}` : ''} (${timeAgo(x.updatedAt)}); skipped because: ${x.reason.slice(0, 160)}`).join('\n')
      : '';
    // How similar work went before (closed streams only; open ones are already listed above): the basis for "do it like last time" offers.
    const queryText = `${inbound.title} ${fresh.map((m) => m.text).join(' ').slice(0, 400)}`;
    const past = (await this.repo.searchPastWork(queryText, { excludeStreamId: existingStreamId, closedOnly: true, limit: 3, minMatched: 2 })).filter((x) => x.id !== (self_ as any)?.streamId);
    const pastBlock = past.length
      ? 'Similar past work (closed work streams; how it was handled before). Mention it in "next" only if it truly applies:\n' +
        past.map((x) => `- "${x.title}"${x.closedAt ? ` (closed ${x.closedAt.slice(0, 10)})` : ''}: ${x.summary.replace(/\s+/g, ' ').slice(0, 300)}${x.snippet ? ` | from its chat: ${x.snippet.slice(0, 200)}` : ''}`).join('\n')
      : '';
    // The conversation belongs to a work stream the PU already closed: say so, with what it was about, so the model can tell a
    // follow-up (relevant: it reopens, or starts a new stream if it closed long ago) from chatter that no longer needs the PU.
    const home = existingStreamId ? await this.repo.getStream(existingStreamId) : null;
    const closedBlock =
      home?.status === 'closed'
        ? `That stream is CLOSED${home.closedAt ? ` (closed ${home.closedAt.slice(0, 10)})` : ''}: "${home.title}". Its overview: ${home.summary.replace(/\s+/g, ' ').slice(0, 600)}\nThis conversation already belonged to that work. If the new activity continues, questions or depends on that work, or the PU may still owe something, mark it relevant (the stream is reopened). Mark it not relevant only if nothing here needs the PU.`
        : '';
    const t = inbound.data.ticket;
    const prompt = [
      puBlock(s.pu, { self, manager, reports }),
      playbookBlock(s.playbooks),
      known.length ? `People in this conversation (org chart):\n${known.join('\n')}` : '',
      streamsBlock(open),
      existingStreamId ? `This item is ALREADY attached to stream ${existingStreamId}; use action "existing" with that id.` : '',
      closedBlock,
      hints.join('\n'),
      skippedBlock,
      pastBlock,
      `Incoming ${inbound.source} ${inbound.kind}: "${inbound.title}" ${inbound.url ?? ''}`,
      t ? `Ticket ${t.key} [${t.flavor}] status=${t.status} assignee=${t.assignee ?? 'unassigned'} requester=${t.requester ?? '?'}\n${(t.description ?? '').slice(0, 2000)}` : '',
      `Earlier context:\n${msgs.filter((m) => !fresh.includes(m)).slice(-4).map(fmt).join('\n\n') || '(none)'}`,
      `NEW activity:\n${fresh.map(fmt).join('\n\n')}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.backend.structured({ systemPrompt: TRIAGE_RULES, prompt, schema: TriageDecision });
  }
}
