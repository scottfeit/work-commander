import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EmojiCatalog } from '@wc/shared';
import { get } from '../api';

let catalog: Promise<EmojiCatalog> | null = null;
/** Slack's standard emoji and the workspace's own, loaded once. */
export function loadEmoji() {
  catalog ??= get<EmojiCatalog>('/api/slack/emoji').catch((e) => {
    catalog = null;
    throw e;
  });
  return catalog;
}

export function useEmoji() {
  const [c, setC] = useState<EmojiCatalog | null>(null);
  useEffect(() => {
    let live = true;
    loadEmoji().then((x) => live && setC(x), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  return c;
}

/** One emoji by its Slack name: the character, the workspace image, or :name: when unknown. */
const index = new WeakMap<EmojiCatalog, Map<string, string>>();
function charOf(c: EmojiCatalog, name: string) {
  let m = index.get(c);
  if (!m) {
    m = new Map();
    for (const e of c.standard) for (const k of [e.n, ...(e.a ?? [])]) m.set(k, e.c);
    index.set(c, m);
  }
  return m.get(name);
}

export function Emoji({ name, c }: { name: string; c: EmojiCatalog | null }) {
  const base = name.replace(/::skin-tone-\d$/, '');
  const ch = c ? charOf(c, base) : undefined;
  if (ch) return <span className="emoji" role="img" aria-label={`:${name}:`}>{ch}</span>;
  if (c?.custom[base]) return <img className="emoji custom" src={c.custom[base]} alt={`:${name}:`} />;
  return <span className="emoji unknown">:{name}:</span>;
}

/**
 * The full picker: your quick five first, a search box, your workspace's emoji, then every standard one by category.
 * Opens beside the button that opened it (placed against the window, so scrolling panes don't clip it).
 */
export function EmojiPicker({ anchor, quick, onPick, onClose, title = 'React with an emoji' }: { anchor: HTMLElement; quick: string[]; onPick: (name: string) => void; onClose: () => void; title?: string }) {
  const c = useEmoji();
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = 340;
    const h = 380;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    const top = r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    setPos({ top, left });
  }, [anchor]);
  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [anchor, onClose]);
  const term = q.trim().toLowerCase().replace(/^:|:$/g, '');
  const groups = useMemo(() => {
    if (!c) return [];
    const custom = Object.keys(c.custom).sort();
    if (term) {
      const hit = (n: string) => n.includes(term);
      return [{ cat: 'Results', names: [...c.standard.filter((e) => hit(e.n) || e.a?.some(hit)).map((e) => e.n), ...custom.filter(hit)].slice(0, 150) }];
    }
    const cats: { cat: string; names: string[] }[] = [];
    if (custom.length) cats.push({ cat: 'Your workspace', names: custom });
    for (const e of c.standard) {
      const last = cats[cats.length - 1];
      if (last && last.cat === e.cat) last.names.push(e.n);
      else cats.push({ cat: e.cat, names: [e.n] });
    }
    return cats;
  }, [c, term]);
  const pick = (n: string) => {
    onPick(n);
    onClose();
  };
  return createPortal(
    <div ref={box} className="emoji-picker" role="dialog" aria-label={title} style={pos ?? { visibility: 'hidden' }}>
      <div className="emoji-quick">
        {quick.map((n) => (
          <button key={n} type="button" className="emoji-btn" title={`:${n}:`} aria-label={`:${n}:`} onClick={() => pick(n)}>
            <Emoji name={n} c={c} />
          </button>
        ))}
      </div>
      <input className="emoji-search" aria-label="Search emoji" placeholder="Search emoji" autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && groups[0]?.names[0] && pick(groups[0].names[0])} />
      <div className="emoji-scroll">
        {!c && <p className="muted small">Loading emoji…</p>}
        {c && term && !groups[0]?.names.length && <p className="muted small">No emoji named “{term}”.</p>}
        {groups.map((g) => (
          <section key={g.cat}>
            <h4>{g.cat}</h4>
            <div className="emoji-grid">
              {g.names.map((n) => (
                <button key={n} type="button" className="emoji-btn" title={`:${n}:`} aria-label={`:${n}:`} onClick={() => pick(n)}>
                  <Emoji name={n} c={c} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}
