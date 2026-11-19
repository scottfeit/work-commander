import { SnoozeMenu, snoozeLabel } from './SnoozeMenu';
import { DueChip, dueRank, promisedOption } from './Due';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkStream } from '@wc/shared';
import { GENERAL_STREAM } from '@wc/shared';
import { get, post, timeAgo } from '../api';
import { ITEM_DRAG, SourceBadge, dragItem } from './TabBar';
import { ConfirmButton } from './ConfirmButton';
import { AlarmIcon } from './AlarmIcon';

/** dropOn value while an item is dragged over the "+" (new work stream) button. */
const NEW_STREAM = '+new';

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
  /** Settings → Display "mark work streams Read myself": the button reads Read / Unread and just flips it. */
  manualRead?: boolean;
  onSetRead?: (id: string, read: boolean) => void;
  /** Close a work stream (the selected tile's Close stream button, after its second click). */
  onCloseStream: (id: string) => void;
  onReopenStream: (id: string) => void;
  /** Mark a work stream Pending (waiting on others) or put it back in Open. */
  onTogglePending: (id: string, pending: boolean) => void;
  onSnooze: (id: string, until: string) => void;
  /** Closing takes two clicks (Settings → Display). */
  confirmClose: boolean;
  /** What the system-wide Undo would reverse next (null: nothing). */
  undoNext: string | null;
  onUndo: () => void;
  pollingPaused: boolean;
  /** Search everything (streams open and closed, messages, chat) for what's typed in the filter. */
  onSearchAll: (q: string) => void;
  onTogglePolling: () => void;
}

export function StreamList({ streams, selected, onSelect, showClosed, onToggleClosed, onSettings, demo, onOpenSkipped, onSkippedDismissed, skippedVersion, peekId, onMarkUnread, manualRead, onSetRead, onCloseStream, onReopenStream, onTogglePending, onSnooze, confirmClose, undoNext, onUndo, pollingPaused, onTogglePolling, onSearchAll }: Props) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [moved, setMoved] = useState(0);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  // What the list shows (the checkboxes at the bottom): Open and Pending are on by default; uncheck to look only at Closed or Declined.
  const [showOpen, setShowOpen] = useState(true);
  const [showPending, setShowPending] = useState(true);
  const [skipped, setSkipped] = useState<SkippedItem[]>([]);
  const loadSkipped = () => get<SkippedItem[]>('/api/items/skipped?dismissed=1').then(setSkipped).catch(() => undefined);
  useEffect(() => void loadSkipped(), [streams.length, moved, skippedVersion]);
  // (a closed stream you're on stays listed, e.g. "Keep showing it" after closing, even with Show closed off)
  const shown = streams.filter((s) => (showClosed || s.status === 'open' || s.id === selected) && (!q || `${s.title} ${s.summary}`.toLowerCase().includes(q.toLowerCase())));
  const open = shown.filter((s) => s.status === 'open' && !s.pending);
  const pendingStreams = shown.filter((s) => s.status === 'open' && s.pending);
  const closed = shown.filter((s) => s.status === 'closed');
  // Items triage passed over sit among the open work streams, marked with a "?"; the ones you dismissed get their own list (Show dismissed).
  type Entry = { key: string; at: string; stream?: WorkStream; item?: SkippedItem };
  const matches = (i: SkippedItem) => !q || `${i.title} ${i.from} ${i.reason}`.toLowerCase().includes(q.toLowerCase());
  const byTime = (a: Entry, b: Entry) => b.at.localeCompare(a.at);
  const openEntries: Entry[] = [
    ...open.map((s) => ({ key: s.id, at: s.lastActivityAt, stream: s })),
    ...skipped.filter((i) => !i.dismissed && matches(i)).map((i) => ({ key: i.id, at: i.updatedAt, item: i })),
  ].sort((a: Entry, b: Entry) => dueRank(a.stream) - dueRank(b.stream) || byTime(a, b)); // overdue, then due today, then the rest
  // Pending (waiting on others): same ordering as everything else, by last update, in their own collapsible section below Open.
  const pendingEntries: Entry[] = pendingStreams.map((s) => ({ key: s.id, at: s.lastActivityAt, stream: s })).sort(byTime);
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

  // Any work stream takes a dropped work item, closed ones too (they stay closed).
  const accepts = (e: React.DragEvent, s: WorkStream) => !!s && e.dataTransfer.types.includes(ITEM_DRAG);
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
  // An item dropped on "+" starts a new work stream of its own; Claude names it and writes its overview.
  const dropNew = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropOn(null);
    const id = e.dataTransfer.getData(ITEM_DRAG);
    if (!id) return;
    setMoveErr(null);
    try {
      const r = await post<{ streamId: string }>(`/api/items/${id}/new-stream`);
      setMoved((n) => n + 1);
      onSelect(r.streamId);
    } catch (err: any) {
      setMoveErr(err.message);
    }
  };
  const row = (s: WorkStream) => (
    <SwipeRow key={s.id} onSwipe={() => (manualRead && onSetRead ? onSetRead(s.id, false) : onMarkUnread(s.id))} label="Unread">
    <div
      className={`stream ${s.id === selected ? 'active' : ''} ${s.status} ${s.pending ? 'pending' : ''} ${dropOn === s.id ? 'drop-target' : ''}`}
      onDragOver={(e) => {
        if (!accepts(e, s)) return;
        e.preventDefault();
        setDropOn(s.id);
      }}
      onDragLeave={() => setDropOn((d) => (d === s.id ? null : d))}
      onDrop={(e) => void drop(e, s)}
    >
      <button type="button" className="stream-open" onClick={() => onSelect(s.id)}>
        <div className="stream-head">
          {s.unread && (s.id !== selected || manualRead) && <span className="dot" aria-label="unread" />}
          {s.lastSource && <SourceBadge source={s.lastSource} />}
          <span className="stream-title">{s.title}</span>
          <span className="muted small">{timeAgo(s.lastActivityAt)}</span>
        </div>
        {s.summary && <div className="stream-summary">{s.summary}</div>}
        <div className="stream-meta">
          {s.runState === 'running' && <span className="chip running">working…</span>}
          {s.pendingProposals > 0 && <span className="chip attention">{s.pendingProposals} to review</span>}
          {s.reminderAt && <span className="chip reminder" title="This was Pending and nothing has happened for a while">Reminder</span>}
          {s.backAt && <span className="chip reminder" title="Back from snooze">Back</span>}
          {s.reopenedAt && s.status === 'open' && (
            <span className="chip reopened-chip" title={`Reopened by new activity ${new Date(s.reopenedAt).toLocaleString()}. Goes away when you reply, mark it Pending, or close it again.`}>
              Reopened
            </span>
          )}
          {s.status === 'open' && s.due && <DueChip due={s.due} />}
          {s.pending && s.snoozeUntil && (
            <span className="chip snooze-chip" title={`Snoozed: comes back ${new Date(s.snoozeUntil).toLocaleString()}, or earlier if someone writes`}>
              until {snoozeLabel(s.snoozeUntil)}
            </span>
          )}
          {s.status === 'closed' && <span className="chip">closed</span>}
        </div>
      </button>
      {s.id === selected && (
        // Like Accept / Dismiss on a skipped item: the open work stream's own actions sit at the bottom of its tile.
        <div className="stream-meta stream-actions">
          {manualRead && onSetRead ? (
            <button type="button" className="btn small read-btn" aria-label={s.unread ? 'Mark read' : 'Mark unread'} title={s.unread ? 'Mark this work stream read' : 'Mark this work stream unread'} onClick={() => onSetRead(s.id, s.unread)}>
              {s.unread ? 'Read' : 'Unread'}
            </button>
          ) : (
            <button type="button" className="btn small" aria-label="Mark unread" title="Mark this work stream unread and go back to the list" onClick={() => onMarkUnread(s.id)}>
              Unread
            </button>
          )}
          {s.status === 'closed' && (
            <button type="button" className="btn small" aria-label="Reopen stream" title="Reopen this work stream (back in Open)" onClick={() => onReopenStream(s.id)}>
              Reopen
            </button>
          )}
          {s.status === 'open' && (
            <ConfirmButton confirm={confirmClose} onConfirm={() => onCloseStream(s.id)} ariaLabel="Close stream" armedAriaLabel="Confirm close" armedChildren="Confirm" title={confirmClose ? 'Close this work stream (asks you to click twice)' : 'Close this work stream'} armedTitle="Click again to close this work stream">
              Close
            </ConfirmButton>
          )}
          {s.status === 'open' && (
            // One split button: the alarm does the default (Pending, or back to Open); only the ▾ opens the snooze menu.
            <span className="pending-split">
            <button
              type="button"
              className={`btn small pending-btn ${s.pending ? 'on' : ''}`}
              aria-label={s.pending ? 'Pending: put back in Open' : 'Mark pending'}
              aria-pressed={s.pending}
              title={s.pending ? 'Pending: waiting on others. Click to put it back in Open.' : "Mark pending (snooze): I've done all I can for now and am waiting on others. It stays open and returns to the top when something new arrives, or as a Reminder if nothing happens for a few days (Settings → Display)."}
              onClick={() => onTogglePending(s.id, !s.pending)}
            >
              <AlarmIcon />
            </button>
            <SnoozeMenu onPending={() => onTogglePending(s.id, true)} onSnooze={(at) => onSnooze(s.id, at)} extra={promisedOption(s)} />
            </span>
          )}
        </div>
      )}
    </div>
    </SwipeRow>
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo" />
        <span>Work Commander</span>
        {demo && <span className="chip demo">demo</span>}
        <button
          type="button"
          className={`icon-btn poll-btn${pollingPaused ? ' paused' : ''}`}
          aria-label={pollingPaused ? 'Resume polling and triage' : 'Pause polling and triage'}
          title={pollingPaused ? 'Polling and triage are paused: resume' : 'Pause polling and triage (e.g. while you clean up your inbox)'}
          onClick={onTogglePolling}
        >
          {pollingPaused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <button
          type="button"
          className="icon-btn undo-btn"
          aria-label={undoNext ? `Undo: ${undoNext}` : 'Undo'}
          title={undoNext ? `Undo: ${undoNext} (⌘Z)` : 'Nothing to undo'}
          disabled={!undoNext}
          onClick={onUndo}
        >
          <UndoIcon />
        </button>
        <button type="button" className="icon-btn gear-btn" aria-label="Settings" title="Settings" onClick={onSettings}>
          <GearIcon />
        </button>
      </div>
      <button className={`stream general ${selected === GENERAL_STREAM ? 'active' : ''}`} onClick={() => onSelect(GENERAL_STREAM)}>
        <span className="stream-title">All open work</span>
        <span className="muted small">{streams.filter((s) => s.status === 'open').length}</span>
      </button>
      <div className="sidebar-tools">
        <input className="search" placeholder="Filter streams" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim().length >= 2 && onSearchAll(q.trim())} />
        <button
          className={`icon-btn ${dropOn === NEW_STREAM ? 'drop-target' : ''}`}
          title="New work stream (or drop a work item here to start one with it)"
          aria-label="New work stream"
          onClick={() => setAdding((v) => !v)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(ITEM_DRAG)) return;
            e.preventDefault();
            setDropOn(NEW_STREAM);
          }}
          onDragLeave={() => setDropOn((d) => (d === NEW_STREAM ? null : d))}
          onDrop={(e) => void dropNew(e)}
        >
          +
        </button>
      </div>
      {q.trim().length >= 2 && (
        <button type="button" className="link small search-all" onClick={() => onSearchAll(q.trim())} title="Search work streams (closed too), messages and chat (⌘K)">
          Search everything for "{q.trim()}" ↵
        </button>
      )}
      {adding && (
        <div className="new-stream">
          <input autoFocus placeholder="Work stream title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className="btn small primary" onClick={create}>
            Add
          </button>
        </div>
      )}
      <div className="stream-scroll">
        {showOpen && <div className="section-label">Open · {openEntries.length}</div>}
        {showOpen && openEntries.length === 0 && <div className="muted small pad">No open work streams. New ones appear here as Claude triages incoming messages.</div>}
        {showOpen && openEntries.map(entry)}
        {showPending && (pendingEntries.length > 0 || !showOpen) && <div className="section-label">Pending · {pendingEntries.length}</div>}
        {showPending && !showOpen && pendingEntries.length === 0 && <div className="muted small pad">Nothing pending.</div>}
        {showPending && pendingEntries.map(entry)}
        {showClosed && (closedEntries.length > 0 || !showOpen) && <div className="section-label">Closed · {closedEntries.length}</div>}
        {showClosed && !showOpen && closedEntries.length === 0 && <div className="muted small pad">No closed work streams.</div>}
        {showClosed && closedEntries.map(entry)}
        {/* With Show closed off, a closed stream you're on (e.g. "Keep showing it" after closing) still shows, on its own */}
        {!showClosed && closedEntries.length > 0 && <div className="section-label">Closed</div>}
        {!showClosed && closedEntries.map(entry)}
        {showDismissed && <div className="section-label">Declined · {dismissedEntries.length}</div>}
        {showDismissed && dismissedEntries.length === 0 && <div className="muted small pad">Nothing declined in the last 14 days.</div>}
        {showDismissed && dismissedEntries.map(entry)}
        {moveErr && <div className="small error pad">{moveErr}</div>}
      </div>
      <div className="sidebar-foot">
        {/* Two columns: Open, Pending | Closed, Declined */}
        <div className="foot-toggles">
          <label className="toggle">
            <input type="checkbox" checked={showOpen} onChange={(e) => setShowOpen(e.target.checked)} /> Show open
          </label>
          <label className="toggle">
            <input type="checkbox" checked={showPending} onChange={(e) => setShowPending(e.target.checked)} /> Show pending
          </label>
          <label className="toggle">
            <input type="checkbox" checked={showClosed} onChange={onToggleClosed} /> Show closed
          </label>
          <label className="toggle">
            <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show declined
          </label>
        </div>
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

type SkippedItem = { id: string; source: string; title: string; updatedAt: string; from: string; reason: string; dismissed: boolean; muted?: boolean; proposed?: { title: string; summary: string } };

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
  const dismiss = async (mute = false) => {
    await post(`/api/items/${i.id}/dismiss`, { mute }).catch(() => undefined);
    onDismissed();
  };
  const decline = async (mute: boolean) => {
    await post(`/api/items/${i.id}/decline`, { mute }).catch(() => undefined);
    onDismissed();
  };
  const p = i.proposed;
  if (p)
    // Triage proposes a new work stream (Settings → Triage, "Ask me first"): accept to create it, or decline.
    return (
      <div className={`stream skipped-tile proposed-tile ${active ? 'active' : ''} ${i.dismissed ? 'closed' : ''}`} title="Proposed work stream. Click to view the message. Drag onto a work stream to add it there instead" {...dragItem(i.id)}>
        <button type="button" className="skipped-open" onClick={onOpen}>
          <div className="stream-head">
            <span className="chip new-chip" title={`Triage proposes a new work stream${i.reason ? `: ${i.reason}` : ''}`}>
              New?
            </span>
            <SourceBadge source={i.source} />
            <span className="stream-title">{p.title}</span>
            <span className="muted small">{timeAgo(i.updatedAt)}</span>
          </div>
          <div className="stream-summary" title={p.summary}>
            {p.summary || i.reason}
          </div>
        </button>
        <div className="stream-meta">
          <button className="btn small primary" disabled={busy} title="Create this work stream" onClick={() => void accept()}>
            {busy ? 'Creating…' : 'Accept'}
          </button>
          {i.dismissed ? (
            <span className="chip" title={i.muted ? 'Declined and muted: new activity on it will not propose this work stream again' : undefined}>
              {i.muted ? 'declined · muted' : 'declined'}
            </span>
          ) : (
            <>
              <button className="btn small" title="Don't make this a work stream. It comes back if there is new activity." onClick={() => void decline(false)}>
                Decline
              </button>
              <button className="btn small" title="Don't make this a work stream, and don't propose it again when there is new activity on this message or thread" onClick={() => void decline(true)}>
                Decline &amp; mute
              </button>
            </>
          )}
        </div>
        {err && <div className="small error">{err}</div>}
      </div>
    );
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
          <span className="chip" title={i.muted ? 'Declined and muted: new activity on it will not bring it back' : undefined}>
            {i.muted ? 'declined · muted' : 'declined'}
          </span>
        ) : (
          <>
            <button className="btn small" title="Hide this until it has new activity" onClick={() => void dismiss()}>
              Decline
            </button>
            <button className="btn small" title="Hide this, and don't bring it back when there is new activity on this message or thread" onClick={() => void dismiss(true)}>
              Decline &amp; mute
            </button>
          </>
        )}
      </div>
      {err && <div className="small error">{err}</div>}
    </div>
  );
}

/** Pause / resume polling and triage. */
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M9 6v12M15 6v12" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="currentColor">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
    </svg>
  );
}

/** The system-wide Undo button in the sidebar header. */
function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

/** The Settings button in the sidebar header. */
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
