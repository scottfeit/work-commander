import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { post } from '../api';

/** "today 3:40 PM", "tomorrow 9:00 AM", "Mon 9:00 AM" (this week), else "Mon 23 Nov, 9:00 AM". */
export function snoozeLabel(iso: string, now = new Date()) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - day0) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const wd = d.toLocaleDateString([], { weekday: 'short' });
  if (days > 1 && days < 7) return `${wd} ${time}`;
  return `${wd} ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

const at9 = (d: Date) => (d.setHours(9, 0, 0, 0), d);
/** The preset return times, worked out from now. */
export function presets(now = new Date()) {
  const later = new Date(now.getTime() + 3 * 3600_000);
  later.setMinutes(Math.ceil(later.getMinutes() / 15) * 15, 0, 0);
  const tomorrow = at9(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const toMonday = ((8 - now.getDay()) % 7) || 7; // the coming Monday (a week on, on a Monday)
  const monday = at9(new Date(now.getFullYear(), now.getMonth(), now.getDate() + toMonday));
  const nextWeek = at9(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
  return [
    { id: 'later', label: 'Later today', at: later },
    { id: 'tomorrow', label: 'Tomorrow', at: tomorrow },
    { id: 'monday', label: 'Monday', at: monday },
    { id: 'nextweek', label: 'Next week', at: nextWeek },
  ].filter((p, i, all) => all.findIndex((q) => q.at.getTime() === p.at.getTime()) === i);
}

/**
 * The ▾ beside Pending: plain Pending, the presets, or a time typed in your own words (read by the cheap "Reading dates" model,
 * shown back for you to confirm). `extra` adds options (e.g. "until they deliver").
 */
export function SnoozeMenu({ onPending, onSnooze, extra = [] }: { onPending: () => void; onSnooze: (iso: string) => void; extra?: { label: string; detail?: string; at: string; title?: string }[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [read, setRead] = useState<{ at: string | null; note: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // Placed against the window (the sidebar scrolls and would clip it): below the button, or above when there's no room.
  useLayoutEffect(() => {
    if (!open || !btn.current || !menu.current) return;
    const r = btn.current.getBoundingClientRect();
    const m = menu.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), window.innerWidth - m.width - 8);
    const below = r.bottom + 4;
    const top = below + m.height > window.innerHeight - 8 ? Math.max(8, r.top - m.height - 4) : below;
    setPos({ top, left });
  }, [open, read]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  const choose = (iso: string) => {
    setOpen(false);
    setPos(null);
    setText('');
    setRead(null);
    onSnooze(iso);
  };
  const ask = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setRead(await post<{ at: string | null; note: string | null }>('/api/parse-time', { text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    } catch (e: any) {
      setRead({ at: null, note: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="snooze" ref={box}>
      <button ref={btn} type="button" className={`btn small pending-caret${open ? ' on' : ''}`} aria-label="Snooze until…" aria-haspopup="menu" aria-expanded={open} title="Pending until a date and time" onClick={() => (setPos(null), setOpen((o) => !o))}>
        ▾
      </button>
      {open &&
        createPortal(
        <div ref={menu} className="snooze-menu" role="menu" aria-label="Snooze until" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}>
          <button type="button" role="menuitem" className="snooze-opt" onClick={() => (setOpen(false), onPending())}>
            <span>Pending</span>
            <span className="muted small">no date; reminds after a few days</span>
          </button>
          <div className="snooze-sep" />
          {presets().map((p) => (
            <button key={p.id} type="button" role="menuitem" className="snooze-opt" onClick={() => choose(p.at.toISOString())}>
              <span>{p.label}</span>
              <span className="muted small">{snoozeLabel(p.at.toISOString())}</span>
            </button>
          ))}
          {extra.map((x) => (
            <button key={x.label} type="button" role="menuitem" className="snooze-opt" title={x.title} onClick={() => choose(x.at)}>
              <span>{x.label}</span>
              <span className="muted small">{x.detail ?? snoozeLabel(x.at)}</span>
            </button>
          ))}
          <div className="snooze-sep" />
          <form
            className="snooze-type"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <input
              aria-label="Type a time"
              placeholder='Or type a time: "Thursday after next, 2pm"'
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setRead(null);
              }}
            />
            <button type="submit" className="btn small" disabled={busy || !text.trim()}>
              {busy ? 'Reading…' : 'Read'}
            </button>
          </form>
          {read && (
            <div className="snooze-read">
              {read.at ? (
                <>
                  <button type="button" className="btn small primary" onClick={() => choose(read.at!)}>
                    Snooze until {snoozeLabel(read.at)}
                  </button>
                  {read.note && <span className="muted small"> {read.note}</span>}
                </>
              ) : (
                <span className="small error">{read.note ?? "Couldn't read that"}</span>
              )}
            </div>
          )}
        </div>,
          document.body,
        )}
    </div>
  );
}
