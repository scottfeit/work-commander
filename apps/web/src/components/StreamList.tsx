import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkStream } from '@wc/shared';
import { GENERAL_STREAM } from '@wc/shared';
import { get, post, timeAgo } from '../api';
import { ITEM_DRAG, SourceBadge, dragItem } from './TabBar';

interface Props {
  streams: WorkStream[];
  selected: string;
  onSelect: (id: string) => void;
  showClosed: boolean;
  onToggleClosed: () => void;
  onSettings: () => void;
  demo: boolean;
  /** Open a skipped item in the main pane (a temporary tab). */
  onOpenSkipped: (id: string) => void;
  onSkippedDismissed: (ids: string[]) => void;
  /** Bumped when something changed the skipped list from elsewhere. */
  skippedVersion: number;
  peekId: string | null;
  /** Mark a work stream unread (swipe a tile sideways). */
  onMarkUnread: (id: string) => void;
}

export function StreamList({ streams, selected, onSelect, showClosed, onToggleClosed, onSettings, demo, onOpenSkipped, onSkippedDismissed, skippedVersion, peekId, onMarkUnread }: Props) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [moved, setMoved] = useState(0);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [skipped, setSkipped] = useState<SkippedItem[]>([]);
  const loadSkipped = () => get<SkippedItem[]>('/api/items/skipped?dismissed=1').then(setSkipped).catch(() => undefined);
  useEffect(() => void loadSkipped(), [streams.length, moved, skippedVersion]);
  const shown = streams.filter((s) => (showClosed || s.status === 'open') && (!q || `${s.title} ${s.summary}`.toLowerCase().includes(q.toLowerCase())));
  const open = shown.filter((s) => s.status === 'open');
  const closed = shown.filter((s) => s.status === 'closed');
  // Items triage passed over sit among the open work streams, marked with a "?"; the ones you dismissed get their own list (Show dismissed).
  type Entry = { key: string; at: string; stream?: WorkStream; item?: SkippedItem };
  const matches = (i: SkippedItem) => !q || `${i.title} ${i.from} ${i.reason}`.toLowerCase().includes(q.toLowerCase());
  const byTime = (a: Entry, b: Entry) => b.at.localeCompare(a.at);
  const openEntries: Entry[] = [
    ...open.map((s) => ({ key: s.id, at: s.lastActivityAt, stream: s })),
    ...skipped.filter((i) => !i.dismissed && matches(i)).map((i) => ({ key: i.id, at: i.updatedAt, item: i })),
  ].sort(byTime);
  const closedEntries: Entry[] = closed.map((s) => ({ key: s.id, at: s.lastActivityAt, stream: s }));
  const dismissedEntries: Entry[] = skipped.filter((i) => i.dismissed && matches(i)).map((i) => ({ key: i.id, at: i.updatedAt, item: i })).sort(byTime);
  const entry = (e: Entry) =>
    e.stream ? (
      row(e.stream)
    ) : (
      <SkippedTile
        key={e.key}
        i={e.item!}
        active={peekId === e.key}
        onOpen={() => onOpenSkipped(e.key)}
        onAccepted={(streamId) => {
          void loadSkipped();
          onSelect(streamId);
        }}
        onDismissed={() => {
          onSkippedDismissed([e.key]);
          void loadSkipped();
        }}
      />
    );

  const create = async () => {
    if (!title.trim()) return;
    const s = await post<WorkStream>('/api/streams', { title: title.trim(), summary: '' });
    setTitle('');
    setAdding(false);
    onSelect(s.id);
  };

  const accepts = (e: React.DragEvent, s: WorkStream) => s.status === 'open' && e.dataTransfer.types.includes(ITEM_DRAG);
  const drop = async (e: React.DragEvent, s: WorkStream) => {
    e.preventDefault();
    setDropOn(null);
    const id = e.dataTransfer.getData(ITEM_DRAG);
    if (!id || !accepts(e, s)) return;
    setMoveErr(null);
    try {
      await post(`/api/items/${id}/move`, { streamId: s.id });
      setMoved((n) => n + 1);
    } catch (err: any) {
      setMoveErr(err.message);
    }
  };
  const row = (s: WorkStream) => (
    <SwipeRow key={s.id} onSwipe={() => onMarkUnread(s.id)} label="Unread">
    <button
      className={`stream ${s.id === selected ? 'active' : ''} ${s.status} ${dropOn === s.id ? 'drop-target' : ''}`}
      onClick={() => onSelect(s.id)}
      onDragOver={(e) => {
        if (!accepts(e, s)) return;
        e.preventDefault();
        setDropOn(s.id);
      }}
      onDragLeave={() => setDropOn((d) => (d === s.id ? null : d))}
      onDrop={(e) => void drop(e, s)}
    >
      <div className="stream-head">
        {s.unread && s.id !== selected && <span className="dot" aria-label="unread" />}
        {s.lastSource && <SourceBadge source={s.lastSource} />}
        <span className="stream-title">{s.title}</span>
        <span className="muted small">{timeAgo(s.lastActivityAt)}</span>
      </div>
      {s.summary && <div className="stream-summary">{s.summary}</div>}
      <div className="stream-meta">
        {s.runState === 'running' && <span className="chip running">working…</span>}
        {s.pendingProposals > 0 && <span className="chip attention">{s.pendingProposals} to review</span>}
        {s.status === 'closed' && <span className="chip">closed</span>}
      </div>
    </button>
    </SwipeRow>
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo" />
        <span>Work Commander</span>
        {demo && <span className="chip demo">demo</span>}
      </div>
      <button className={`stream general ${selected === GENERAL_STREAM ? 'active' : ''}`} onClick={() => onSelect(GENERAL_STREAM)}>
        <span className="stream-title">All open work</span>
        <span className="muted small">{streams.filter((s) => s.status === 'open').length}</span>
      </button>
      <div className="sidebar-tools">
        <input className="search" placeholder="Filter streams" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="icon-btn" title="New work stream" onClick={() => setAdding((v) => !v)}>
          +
        </button>
      </div>
      {adding && (
        <div className="new-stream">
          <input autoFocus placeholder="Work stream title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className="btn small primary" onClick={create}>
            Add
          </button>
        </div>
      )}
      <div className="stream-scroll">
        <div className="section-label">Open · {openEntries.length}</div>
        {openEntries.length === 0 && <div className="muted small pad">No open work streams. New ones appear here as Claude triages incoming messages.</div>}
        {openEntries.map(entry)}
        {showClosed && closedEntries.length > 0 && <div className="section-label">Closed · {closedEntries.length}</div>}
        {showClosed && closedEntries.map(entry)}
        {showDismissed && <div className="section-label">Dismissed · {dismissedEntries.length}</div>}
        {showDismissed && dismissedEntries.length === 0 && <div className="muted small pad">Nothing dismissed in the last 14 days.</div>}
        {showDismissed && dismissedEntries.map(entry)}
        {moveErr && <div className="small error pad">{moveErr}</div>}
      </div>
      <div className="sidebar-foot">
        <div className="foot-toggles">
          <label className="toggle">
            <input type="checkbox" checked={showClosed} onChange={onToggleClosed} /> Show closed
          </label>
          <label className="toggle">
            <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show dismissed
          </label>
        </div>
        <button className="btn ghost small" onClick={onSettings}>
          Settings
        </button>
      </div>
    </aside>
  );
}

/**
 * A row that can be swiped sideways to trigger an action, like marking a conversation unread in iMessage.
 * Works with a mouse/touch drag to the right and with a two-finger trackpad swipe.
 */
function SwipeRow({ children, onSwipe, label }: { children: ReactNode; onSwipe: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [off, setOff] = useState(0);
  const [live, setLive] = useState(false);
  const drag = useRef<{ x: number; y: number; on: boolean } | null>(null);
  const swiped = useRef(false);
  const fire = useRef(onSwipe);
  fire.current = onSwipe;
  const THRESHOLD = 64;
  const MAX = 96;

  useEffect(() => {
    // Trackpad: horizontal wheel events. Needs a non-passive listener so the page doesn't navigate back/forward.
    const el = ref.current;
    if (!el) return;
    let acc = 0;
    let fired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical scrolling stays normal
      e.preventDefault();
      if (!fired) {
        acc += Math.abs(e.deltaX);
        setLive(true);
        setOff(Math.min(acc, MAX));
        if (acc >= THRESHOLD) {
          fired = true;
          fire.current();
        }
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        acc = 0;
        fired = false;
        setLive(false);
        setOff(0);
      }, 220);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="swipe"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, on: false };
        swiped.current = false;
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (!d.on && dx > 8 && dx > Math.abs(e.clientY - d.y) * 1.5) {
          d.on = true;
          setLive(true);
          ref.current?.setPointerCapture(e.pointerId);
        }
        if (d.on) setOff(Math.max(0, Math.min(dx, MAX)));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.on) {
          swiped.current = true; // the click that follows the drag must not open the stream
          if (off >= THRESHOLD) onSwipe();
          setLive(false);
          setOff(0);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        setLive(false);
        setOff(0);
      }}
      onClickCapture={(e) => {
        if (swiped.current) {
          swiped.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      <div className={`swipe-bg ${off >= THRESHOLD ? 'armed' : ''}`} aria-hidden>
        <span className="dot" /> {label}
      </div>
      <div className="swipe-inner" style={{ transform: `translateX(${off}px)`, transition: live ? 'none' : 'transform .18s ease' }}>
        {children}
      </div>
    </div>
  );
}

type SkippedItem = { id: string; source: string; title: string; updatedAt: string; from: string; reason: string; dismissed: boolean };

/**
 * A message triage didn't think was work, shown among the work streams with a "?". Accept makes it a work stream (or files it into the
 * existing stream it belongs to); Dismiss moves it to the closed list. Click to look at it; drag onto a stream to add it there.
 */
function SkippedTile({ i, active, onOpen, onAccepted, onDismissed }: { i: SkippedItem; active: boolean; onOpen: () => void; onAccepted: (streamId: string) => void; onDismissed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const accept = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ streamId: string | null }>(`/api/items/${i.id}/accept`);
      if (r.streamId) onAccepted(r.streamId);
      else setErr("Couldn't make this a work stream.");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    await post(`/api/items/${i.id}/dismiss`).catch(() => undefined);
    onDismissed();
  };
  return (
    <div className={`stream skipped-tile ${active ? 'active' : ''} ${i.dismissed ? 'closed' : ''}`} title="Click to view. Drag onto a work stream to add it there" {...dragItem(i.id)}>
      <button type="button" className="skipped-open" onClick={onOpen}>
      <div className="stream-head">
        <span className="q-icon" title={`Triage didn't think this was work${i.reason ? `: ${i.reason}` : ''}`} aria-label="Not thought to be work">
          ?
        </span>
        <SourceBadge source={i.source} />
        <span className="stream-title">{i.title}</span>
        <span className="muted small">{timeAgo(i.updatedAt)}</span>
      </div>
      <div className="stream-summary" title={i.reason}>
        {i.from ? `${i.from} · ` : ''}
        {i.reason || 'Skipped by triage'}
      </div>
      </button>
      <div className="stream-meta">
        <button className="btn small primary" disabled={busy} title="Make this a work stream (or add it to the one it belongs to)" onClick={() => void accept()}>
          {busy ? 'Accepting…' : 'Accept'}
        </button>
        {i.dismissed ? (
          <span className="chip">dismissed</span>
        ) : (
          <button className="btn small ghost" title="Hide this until it has new activity" onClick={() => void dismiss()}>
            Dismiss
          </button>
        )}
      </div>
      {err && <div className="small error">{err}</div>}
    </div>
  );
}
