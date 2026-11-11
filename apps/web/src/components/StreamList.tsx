import { useEffect, useState } from 'react';
import type { WorkStream } from '@wc/shared';
import { GENERAL_STREAM } from '@wc/shared';
import { get, post, timeAgo } from '../api';
import { SourceBadge } from './TabBar';

interface Props {
  streams: WorkStream[];
  selected: string;
  onSelect: (id: string) => void;
  showClosed: boolean;
  onToggleClosed: () => void;
  onSettings: () => void;
  demo: boolean;
}

export function StreamList({ streams, selected, onSelect, showClosed, onToggleClosed, onSettings, demo }: Props) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
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

  const row = (s: WorkStream) => (
    <button key={s.id} className={`stream ${s.id === selected ? 'active' : ''} ${s.status}`} onClick={() => onSelect(s.id)}>
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
        <Skipped onSelect={onSelect} refreshKey={streams.length} />
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
function Skipped({ onSelect, refreshKey }: { onSelect: (id: string) => void; refreshKey: number }) {
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
  return (
    <details className="skipped">
      <summary className="section-label">Skipped · {items.length}</summary>
      <p className="muted small pad">Messages from the last 14 days that triage didn't turn into work.</p>
      {items.map((i) => (
        <div key={i.id} className="skipped-row">
          <div className="skipped-title">
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
            </div>
          ) : (
            <button className="btn small ghost" disabled={busy === i.id} onClick={() => retriage(i.id, false)}>
              {busy === i.id ? 'Triaging…' : 'Triage again'}
            </button>
          )}
        </div>
      ))}
    </details>
  );
}
