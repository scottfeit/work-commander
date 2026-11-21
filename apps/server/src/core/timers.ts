import { nanoid } from 'nanoid';
import type { StreamTimer } from '@wc/shared';
import type { AgentBackend } from '../agent/backend.js';
import type { TurnRequest } from '../agent/runner.js';
import type { Repo } from './repo.js';
import { bus } from './bus.js';
import { parseTime } from './parseTime.js';

/** A timer whose time passed this long ago when WC first sees it was missed (WC wasn't running, or the computer slept). */
const MISSED_AFTER_MS = 3 * 60_000;

type Deps = { repo: Repo; backend: Pick<AgentBackend, 'structured'>; run: (r: TurnRequest) => Promise<unknown>; tz?: () => string };

/**
 * Timed instructions: "in 30 minutes, check for tickets on this topic". Claude sets them; at the time, Claude carries the
 * instruction out in the stream as if the PU had just asked, then the stream is back in Open and unread (whatever it was).
 * One missed while WC wasn't running waits in the chat with Run now / Cancel.
 */
export class TimerService {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private d: Deps, private log: (m: string) => void = () => undefined) {}

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private zone() {
    return this.d.tz?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  }

  /** Set one from a time phrase ("in 30 minutes", "at 3pm", "tomorrow morning"). */
  async create(streamId: string, when: string, instruction: string, runId?: string) {
    const t = await parseTime(this.d.backend, when, this.zone());
    if (!t.at) throw new Error(t.note ?? "That doesn't name a time");
    const id = `t_${nanoid(8)}`;
    const timer: StreamTimer = { id, instruction: instruction.trim(), at: t.at, status: 'waiting' };
    const chat = await this.d.repo.addChat({ streamId, role: 'system', content: `Timed instruction: ${timer.instruction}`, meta: { timer, ...(runId ? { runId } : {}) } });
    await this.d.repo.db.insertInto('timers').values({ id, stream_id: streamId, instruction: timer.instruction, run_at: t.at, status: 'waiting', chat_id: chat.id, created_at: new Date().toISOString(), done_at: null }).execute();
    await this.d.repo.audit('pu', 'timer.set', { streamId, id, at: t.at, instruction: timer.instruction });
    await this.touch(streamId);
    return { ...timer, note: t.note };
  }

  async cancel(id: string) {
    const row = await this.row(id);
    if (!row || !['waiting', 'missed'].includes(row.status)) return false;
    await this.setStatus(row, 'cancelled');
    await this.d.repo.audit('you', 'timer.cancelled', { streamId: row.stream_id, id });
    return true;
  }

  /** Run a missed one now (the PU chose Run now). */
  async runNow(id: string) {
    const row = await this.row(id);
    if (!row || row.status !== 'missed') return false;
    void this.fire(row, true);
    return true;
  }

  async tick(nowMs = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.d.repo.db.selectFrom('timers').selectAll().where('status', '=', 'waiting').where('run_at', '<=', new Date(nowMs).toISOString()).execute();
      for (const row of due) {
        if (nowMs - Date.parse(row.run_at) > MISSED_AFTER_MS) await this.miss(row);
        else void this.fire(row, false);
      }
    } catch (e: any) {
      this.log(`timers: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  private async miss(row: TimerRow) {
    await this.setStatus(row, 'missed');
    // so the question is seen: back in Open, unread
    await this.d.repo.updateStream(row.stream_id, { status: 'open', pending: false, unread: true, touch: true }, 'claude');
    bus.publish({ type: 'notify', streamId: row.stream_id, title: 'Timed instruction missed', body: `"${row.instruction}" was due while Work Commander wasn't running. Run it now or cancel it in the chat.` });
  }

  private async fire(row: TimerRow, late: boolean) {
    await this.setStatus(row, 'running');
    try {
      await this.d.run({
        streamId: row.stream_id,
        origin: 'user',
        purpose: 'chat',
        allowDrafts: true,
        prompt: `[A timed instruction the PU set earlier is due now${late ? ' (it ran late: Work Commander was not running at the time, and the PU chose to run it now)' : ''}. Their instruction: "${row.instruction}". Carry it out now, as if the PU had just asked you, and tell them in a few sentences what you found or did.]`,
      });
      await this.setStatus(row, 'done');
    } catch (e: any) {
      await this.setStatus(row, 'done');
      await this.d.repo.addChat({ streamId: row.stream_id, role: 'system', content: `The timed instruction couldn't run: ${e.message}` });
    }
    // done: back in Open and unread, whatever the stream was (Pending, snoozed, closed or open)
    await this.d.repo.updateStream(row.stream_id, { status: 'open', pending: false, unread: true, touch: true }, 'claude');
    bus.publish({ type: 'notify', streamId: row.stream_id, title: 'Timed instruction done', body: row.instruction });
  }

  private row(id: string) {
    return this.d.repo.db.selectFrom('timers').selectAll().where('id', '=', id).executeTakeFirst();
  }

  private async setStatus(row: TimerRow, status: StreamTimer['status']) {
    await this.d.repo.db.updateTable('timers').set({ status, done_at: ['done', 'cancelled'].includes(status) ? new Date().toISOString() : null }).where('id', '=', row.id).execute();
    if (row.chat_id) {
      const m = await this.d.repo.getChat(row.chat_id);
      if (m?.meta.timer) await this.d.repo.updateChatMeta(m.id, { ...m.meta, timer: { ...m.meta.timer, status } });
    }
    await this.touch(row.stream_id);
  }

  /** The stream's timers changed: refresh it on screen. */
  private async touch(streamId: string) {
    const st = await this.d.repo.getStream(streamId);
    if (st) bus.publish({ type: 'stream.updated', stream: st });
  }
}

type TimerRow = { id: string; stream_id: string; instruction: string; run_at: string; status: string; chat_id: string | null };
