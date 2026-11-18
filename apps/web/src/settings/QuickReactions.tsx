import { useState } from 'react';
import { Emoji, EmojiPicker, useEmoji } from '../components/Emoji';

/** Settings → Slack: the five quick reactions; each slot opens the full picker to choose its emoji. */
export function QuickReactions({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const c = useEmoji();
  const slots = [...value, ...Array(5).fill('')].slice(0, 5);
  const [open, setOpen] = useState<{ i: number; el: HTMLElement } | null>(null);
  return (
    <div className="quick-slots">
      {slots.map((n, i) => (
        <button key={i} type="button" className="reaction quick-slot" aria-label={`Quick reaction ${i + 1}: ${n ? `:${n}:` : 'empty'}`} title={n ? `:${n}: (click to change)` : 'Choose an emoji'} onClick={(e) => setOpen(open?.i === i ? null : { i, el: e.currentTarget })}>
          {n ? <Emoji name={n} c={c} /> : <span className="muted">+</span>}
        </button>
      ))}
      {open && (
        <EmojiPicker
          anchor={open.el}
          quick={[]}
          title={`Quick reaction ${open.i + 1}`}
          onPick={(name) => onChange(slots.map((x, j) => (j === open.i ? name : x)).filter(Boolean))}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
