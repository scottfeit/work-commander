import { useEffect, useState } from 'react';
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
}

export function StreamList({ streams, selected, onSelect, showClosed, onToggleClosed, onSettings, demo, onOpenSkipped, onSkippedDismissed, skippedVersion, peekId }: Props) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [moved, setMoved] = useState(0);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const shown = streams.filter((s) => (showClosed || s.status === 'open') && (!q || `${s.title} ${s.summary} ${s.labels.join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const open = shown.filter((s) => s.status === 'open');
  const closed = shown.filter((s) => s.status === 'closed');

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
    <button
      key={s.id}
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
        <span className="stream-title">{s.title}</span>
        <span className="muted small">{timeAgo(s.lastActivityAt)}</span>
      </div>
      {s.summary && <div className="stream-summary">{s.summary}</div>}
      <div className="stream-meta">
        {s.runState === 'running' && <span className="chip running">working…</span>}
        {s.pendingProposals > 0 && <span className="chip attention">{s.pendingProposals} to review</span>}
        {s.status === 'closed' && <span className="chip">closed</span>}
        {s.labels.slice(0, 3).map((l) => (
          <span key={l} className="chip subtle">
            {l}
          </span>
        ))}
      </div>
    </button>
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
        <div className="section-label">Open · {open.length}</div>
        {open.length === 0 && <div className="muted small pad">No open work streams. New ones appear here as Claude triages incoming messages.</div>}
        {open.map(row)}
        {showClosed && closed.length > 0 && <div className="section-label">Closed · {closed.length}</div>}
        {showClosed && closed.map(row)}
        {moveErr && <div className="small error pad">{moveErr}</div>}
        <Skipped onSelect={onSelect} refreshKey={streams.length + moved + skippedVersion} onOpen={onOpenSkipped} onDismissed={onSkippedDismissed} peekId={peekId} />
      </div>
      <div className="sidebar-foot">
        <label className="toggle">
          <input type="checkbox" checked={showClosed} onChange={onToggleClosed} /> Show closed
        </label>
        <button className="btn ghost small" onClick={onSettings}>
          Settings
        </button>
      </div>
    </aside>
  );
}

type SkippedItem = { id: string; source: string; title: string; updatedAt: string; from: string; reason: string };

/** Messages triage passed over in the last 14 days, with "Triage again" for any that should have been work. */
function Skipped({ onSelect, refreshKey, onOpen, onDismissed, peekId }: { onSelect: (id: string) => void; refreshKey: number; onOpen: (id: string) => void; onDismissed: (ids: string[]) => void; peekId: string | null }) {
  const [items, setItems] = useState<SkippedItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Record<string, string>>({});
  const load = () => get<SkippedItem[]>('/api/items/skipped').then(setItems).catch(() => undefined);
  useEffect(() => void load(), [refreshKey]);
  if (!items.length) return null;
  const retriage = async (id: string, force: boolean) => {
    setBusy(id);
    try {
      const r = await post<{ relevant: boolean; reason: string; streamId: string | null }>(`/api/items/${id}/retriage`, { force });
      if (r.streamId) {
        await load();
        onSelect(r.streamId);
      } else setVerdict((v) => ({ ...v, [id]: r.reason }));
    } catch (e: any) {
      setVerdict((v) => ({ ...v, [id]: `Error: ${e.message}` }));
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (ids: string[]) => {
    await Promise.all(ids.map((id) => post(`/api/items/${id}/dismiss`).catch(() => undefined)));
    onDismissed(ids);
    await load();
  };
  return (
    <details className="skipped">
      <summary className="section-label">Skipped · {items.length}</summary>
      <div className="pad">
        <button className="btn small ghost" onClick={() => void dismiss(items.map((i) => i.id))}>
          Dismiss all
        </button>
      </div>
      <p className="muted small pad">Messages from the last 14 days that triage didn't turn into work.</p>
      {items.map((i) => (
        <div key={i.id} className={`skipped-row ${peekId === i.id ? 'open' : ''}`} title="Click to view. Drag onto a work stream to add it there" {...dragItem(i.id)}>
          <div className="skipped-title clickable" role="button" tabIndex={0} onClick={() => onOpen(i.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(i.id)}>
            <SourceBadge source={i.source} /> <span title={i.title}>{i.title}</span>
          </div>
          <div className="muted small" title={i.reason}>
            {i.from ? `${i.from} · ` : ''}
            {timeAgo(i.updatedAt)}
            {i.reason ? ` · ${i.reason}` : ''}
          </div>
          {verdict[i.id] ? (
            <div className="small">
              <div className="muted">Still not work: {verdict[i.id]}</div>
              <button className="btn small" disabled={busy === i.id} onClick={() => retriage(i.id, true)}>
                {busy === i.id ? 'Creating…' : 'Create work stream anyway'}
              </button>
              <button className="btn small ghost" onClick={() => void dismiss([i.id])}>
                Dismiss
              </button>
            </div>
          ) : (
            <div className="inline">
              <button className="btn small ghost" disabled={busy === i.id} onClick={() => retriage(i.id, false)}>
                {busy === i.id ? 'Triaging…' : 'Triage again'}
              </button>
              <button className="btn small ghost" title="Hide this until it has new activity" onClick={() => void dismiss([i.id])}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      ))}
    </details>
  );
}
