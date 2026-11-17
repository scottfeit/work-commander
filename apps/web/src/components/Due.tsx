import { useState } from 'react';
import type { StreamDeadline, WorkStream } from '@wc/shared';
import { patch, post } from '../api';

const DAY = 86_400_000;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Whole days from today to the deadline's day (negative = overdue). An all-day deadline is due until that day ends. */
export function daysLeft(due: StreamDeadline, now = new Date()) {
  const at = new Date(due.at);
  if (!due.allDay && at.getTime() < now.getTime() && dayStart(at) === dayStart(now)) return -0.5; // later today has passed
  return Math.round((dayStart(at) - dayStart(now)) / DAY);
}

/** "overdue 2d" (red), "due today" (amber), "due tomorrow", "due Fri", "due 21 Nov" (grey). */
export function dueChip(due: StreamDeadline, now = new Date()): { text: string; tone: 'overdue' | 'today' | 'later' } {
  const n = daysLeft(due, now);
  const at = new Date(due.at);
  if (n < 0) return { text: n === -0.5 ? 'overdue' : `overdue ${-n}d`, tone: 'overdue' };
  if (n === 0) return { text: due.allDay ? 'due today' : `due ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, tone: 'today' };
  if (n === 1) return { text: 'due tomorrow', tone: 'later' };
  if (n < 7) return { text: `due ${at.toLocaleDateString([], { weekday: 'short' })}`, tone: 'later' };
  return { text: `due ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}`, tone: 'later' };
}

/** Sort rank in Open: overdue first, then due today, then everything else (by latest activity, as before). */
export function dueRank(s?: WorkStream) {
  if (!s?.due || s.status !== 'open') return 2;
  const n = daysLeft(s.due);
  return n < 0 ? 0 : n === 0 ? 1 : 2;
}

export function DueChip({ due }: { due: StreamDeadline }) {
  const c = dueChip(due);
  return (
    <span className={`chip due-chip ${c.tone}`} title={`Due ${new Date(due.at).toLocaleString()}${due.quote ? ` — "${due.quote}"` : ''}${due.who ? ` (${due.who})` : ''}`}>
      {c.text}
    </span>
  );
}

const longDate = (d: StreamDeadline) => {
  const at = new Date(d.at);
  const day = at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return d.allDay ? day : `${day}, ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

/** The Overview pane's due line (and the "they'll deliver by" line): the date, the words it came from, Change and Clear. */
export function DueLine({ stream }: { stream: WorkStream }) {
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const due = stream.due;
  const set = async (body: object) => {
    await patch(`/api/streams/${stream.id}`, body);
    setEditing(false);
    setText('');
    setErr(null);
  };
  const fromText = async () => {
    setBusy(true);
    try {
      const r = await post<{ at: string | null; note: string | null }>('/api/parse-time', { text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (r.at) await set({ due: { at: r.at } });
      else setErr(r.note ?? "Couldn't read that");
    } finally {
      setBusy(false);
    }
  };
  const open = () => {
    setDate(due ? new Date(new Date(due.at).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : '');
    setEditing(true);
  };
  return (
    <div className="due-lines">
      {(due || editing) && (
        <div className="due-line">
          <span className="due-k">Due</span>
          {due && <span className={`due-v ${dueChip(due).tone}`}>{longDate(due)}</span>}
          {!editing && (
            <>
              <button type="button" className="link small" onClick={open}>
                Change
              </button>
              <button type="button" className="link small" aria-label="Clear the due date" title="Clear the due date" onClick={() => void set({ due: null })}>
                ✕
              </button>
            </>
          )}
        </div>
      )}
      {due?.quote && !editing && (
        <div className="due-quote muted small">
          "{due.quote}"{due.who ? ` — ${due.who}` : ''}
          {due.source ? `, ${due.source === 'gmail' ? 'email' : due.source}` : ''}
          {due.by === 'you' ? ' (set by you)' : ''}
        </div>
      )}
      {!due && !editing && (
        <button type="button" className="link small" onClick={open}>
          Set a due date
        </button>
      )}
      {editing && (
        <div className="due-edit">
          <input type="date" aria-label="Due date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button type="button" className="btn small" disabled={!date} onClick={() => void set({ due: { at: new Date(`${date}T17:00`).toISOString(), allDay: true } })}>
            Set
          </button>
          <form
            className="due-type"
            onSubmit={(e) => {
              e.preventDefault();
              void fromText();
            }}
          >
            <input aria-label="Type a due date" placeholder='or type: "end of next week"' value={text} onChange={(e) => (setText(e.target.value), setErr(null))} />
            <button type="submit" className="btn small" disabled={busy || !text.trim()}>
              {busy ? 'Reading…' : 'Read'}
            </button>
          </form>
          <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {err && <span className="small error">{err}</span>}
        </div>
      )}
      {stream.promised && (
        <div className="due-line">
          <span className="due-k">They'll deliver</span>
          <span className="due-v">{longDate(stream.promised)}</span>
          <span className="muted small">
            {stream.promised.quote ? `"${stream.promised.quote}"` : ''}
            {stream.promised.who ? ` — ${stream.promised.who}` : ''}
          </span>
          <button type="button" className="link small" aria-label="Clear the delivery date" title="Clear" onClick={() => void set({ promised: null })}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/** For the Pending ▾ menu: snooze until the other side said they'd deliver. */
export function promisedOption(s: WorkStream) {
  const p = s.promised;
  if (!p || Date.parse(p.at) <= Date.now()) return [];
  const at = new Date(p.at);
  const when = p.allDay ? at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return [{ label: 'Until they deliver', detail: `${when}${p.who ? ` (${p.who.split(' ')[0]})` : ''}`, at: p.at, title: p.quote ? `"${p.quote}"` : undefined }];
}
