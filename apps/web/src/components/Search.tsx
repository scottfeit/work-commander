import { useEffect, useRef, useState } from 'react';
import { ClearableInput } from './ClearableInput';
import type { SearchHit } from '@wc/shared';
import { get } from '../api';
import { SourceBadge } from './TabBar';

const ago = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

/** Bold the searched words in a snippet. */
function Marked({ text, q }: { text: string; q: string }) {
  const terms = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]).concat(q.replace(/"[^"]*"/g, ' ').split(/\s+/)).map((t) => t.trim()).filter((t) => t.length >= 2);
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}
    </>
  );
}

const GROUPS: { kind: SearchHit['kind']; label: string }[] = [
  { kind: 'stream', label: 'Work streams' },
  { kind: 'message', label: 'Messages' },
  { kind: 'chat', label: 'Chat' },
];

/** Search everything (⌘K, or "s"): work streams open and closed, the messages in work items, and chat. */
export function Search({ open, initial, onClose, onOpen }: { open: boolean; initial?: string; onClose: () => void; onOpen: (hit: SearchHit) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQ(initial ?? '');
    setHits(null);
    setSel(0);
    setTimeout(() => input.current?.focus(), 0);
  }, [open, initial]);
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setHits(null);
      return;
    }
    setBusy(true);
    const t = setTimeout(() => {
      get<SearchHit[]>(`/api/search?q=${encodeURIComponent(term)}`)
        .then((r) => {
          setHits(r);
          setSel(0);
        })
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);
  if (!open) return null;
  const ordered = GROUPS.flatMap((g) => (hits ?? []).filter((h) => h.kind === g.kind));
  const choose = (h: SearchHit) => {
    onClose();
    onOpen(h);
  };
  return (
    <div className="shortcuts-backdrop search-backdrop" onMouseDown={onClose}>
      <div className="search" role="dialog" aria-label="Search everything" onMouseDown={(e) => e.stopPropagation()}>
        <ClearableInput
          ref={input}
          onClear={() => setQ('')}
          className="search-input"
          aria-label="Search everything"
          placeholder='Search work streams, messages and chat (closed work too). "Quotes" for a phrase.'
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') (e.preventDefault(), setSel((n) => Math.min(ordered.length - 1, n + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((n) => Math.max(0, n - 1)));
            else if (e.key === 'Enter' && ordered[sel]) choose(ordered[sel]);
          }}
        />
        <div className="search-results">
          {q.trim().length < 2 && <p className="muted small">Type at least two letters.</p>}
          {hits && !hits.length && !busy && <p className="muted small">Nothing found.</p>}
          {GROUPS.map((g) => {
            const xs = (hits ?? []).filter((h) => h.kind === g.kind);
            if (!xs.length) return null;
            return (
              <section key={g.kind}>
                <h3>
                  {g.label} · {xs.length}
                </h3>
                {xs.map((h) => {
                  const i = ordered.indexOf(h);
                  return (
                    <button key={`${h.kind}-${h.streamId}-${h.itemId}-${h.at}-${i}`} type="button" className={`search-hit${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(h)}>
                      <div className="search-hit-head">
                        {h.source && <SourceBadge source={h.source} />}
                        <span className="search-hit-title">{h.kind === 'stream' ? <Marked text={h.streamTitle ?? ''} q={q} /> : h.kind === 'message' ? h.itemTitle : h.streamTitle ?? 'All open work'}</span>
                        {h.streamStatus === 'closed' && <span className="chip">closed</span>}
                        {h.kind !== 'stream' && (h.streamTitle ? h.kind === 'message' && <span className="muted small">in {h.streamTitle}</span> : h.kind === 'message' && <span className="muted small">not in a work stream</span>)}
                        <span className="muted small search-hit-at">{ago(h.at)}</span>
                      </div>
                      <div className="search-hit-snippet small">
                        {h.who && <b>{h.who}: </b>}
                        <Marked text={h.snippet} q={q} />
                      </div>
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>
        <div className="muted small search-foot">↑ ↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}
