import { useEffect, useMemo, useRef, useState } from 'react';
import type { DraftMention, Person, StreamItem } from '@wc/shared';
import { get } from '../api';

const cache = new Map<string, Promise<DraftMention[]>>();

/** People to @-mention: everyone in this work stream's conversations first, then the org chart. */
export function usePeople(streamId: string | null) {
  const [people, setPeople] = useState<DraftMention[]>([]);
  useEffect(() => {
    const key = streamId ?? '';
    if (!cache.has(key))
      cache.set(
        key,
        (async () => {
          const [items, org] = await Promise.all([streamId ? get<StreamItem[]>(`/api/streams/${streamId}/items`).catch(() => []) : Promise.resolve([] as StreamItem[]), get<Person[]>('/api/people').catch(() => [] as Person[])]);
          const out = new Map<string, DraftMention>();
          const add = (p: DraftMention) => {
            const k = (p.email ?? p.slackUserId ?? p.name).toLowerCase();
            if (!p.name?.trim() || out.has(k)) return;
            out.set(k, p);
          };
          for (const it of items) for (const m of [...(it.data.messages ?? []), ...(it.data.ticket?.comments ?? [])]) if (!m.isFromPU && m.author.name) add({ name: m.author.name, email: m.author.email, slackUserId: m.author.slackUserId });
          for (const p of org) add({ name: p.name, email: p.email, slackUserId: (p as any).slackUserId });
          return [...out.values()];
        })(),
      );
    let live = true;
    cache.get(key)!.then((x) => live && setPeople(x));
    setTimeout(() => cache.delete(key), 60_000); // pick up new people now and then
    return () => {
      live = false;
    };
  }, [streamId]);
  return people;
}

/**
 * A text box where typing "@" suggests people (↑ ↓ to choose, Enter or Tab to pick, Esc to close). Picking one inserts "@Name"
 * and reports who, so the draft can turn it into a real mention (or, for email, add them to Cc).
 */
export function MentionTextarea({ id, value, rows, people, onChange, onPick }: { id: string; value: string; rows: number; people: DraftMention[]; onChange: (v: string) => void; onPick: (text: string, who: DraftMention) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [q, setQ] = useState<{ at: number; text: string } | null>(null);
  const [sel, setSel] = useState(0);
  const hits = useMemo(() => {
    if (!q) return [];
    const t = q.text.toLowerCase();
    return people.filter((p) => !t || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(t)) || p.name.toLowerCase().startsWith(t) || p.email?.toLowerCase().startsWith(t)).slice(0, 8);
  }, [q, people]);
  const look = (text: string, caret: number) => {
    const m = /(^|\s)@([\p{L}\p{N}._'-]{0,30})$/u.exec(text.slice(0, caret));
    setQ(m ? { at: caret - m[2].length - 1, text: m[2] } : null);
    setSel(0);
  };
  const pick = (who: DraftMention) => {
    if (!q) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const insert = `@${who.name} `;
    const next = value.slice(0, q.at) + insert + value.slice(caret);
    setQ(null);
    onPick(next, who);
    const pos = q.at + insert.length;
    requestAnimationFrame(() => ref.current?.setSelectionRange(pos, pos));
  };
  return (
    <div className="mention-box">
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          look(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (!q || !hits.length) return;
          if (e.key === 'ArrowDown') (e.preventDefault(), setSel((n) => (n + 1) % hits.length));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((n) => (n - 1 + hits.length) % hits.length));
          else if (e.key === 'Enter' || e.key === 'Tab') (e.preventDefault(), pick(hits[sel]));
          else if (e.key === 'Escape') (e.preventDefault(), setQ(null));
        }}
        onBlur={() => setTimeout(() => setQ(null), 150)}
      />
      {q && hits.length > 0 && (
        <ul className="mention-pop" role="listbox" aria-label="Mention someone">
          {hits.map((p, i) => (
            <li key={`${p.email ?? p.slackUserId ?? p.name}`} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), pick(p))} onMouseEnter={() => setSel(i)}>
              <span>{p.name}</span>
              {p.email && <span className="muted small">{p.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
