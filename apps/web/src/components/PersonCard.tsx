import { useEffect, useRef, useState } from 'react';
import { get } from '../api';

type Card = { name: string; email?: string; title?: string; department?: string; manager?: string; slackHandle?: string };
const cache = new Map<string, Promise<Card>>();

/** A person's name; hovering it (or focusing it) shows their role and team, email and Slack handle, with copy buttons. */
export function PersonName({ name, email, slackUserId }: { name: string; email?: string; slackUserId?: string }) {
  const [card, setCard] = useState<Card | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const key = `${email ?? ''}|${slackUserId ?? ''}|${name}`;
      if (!cache.has(key)) cache.set(key, get<Card>(`/api/person?${new URLSearchParams({ name, ...(email ? { email } : {}), ...(slackUserId ? { slackUserId } : {}) })}`).catch(() => ({ name, email })));
      void cache.get(key)!.then(setCard);
      setOpen(true);
    }, 350);
  };
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 200); // time to move onto the card
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span className="person" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="person-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? setOpen(false) : show())}>
        {name}
      </button>
      {open && (
        <span className="person-card" role="dialog" aria-label={`About ${name}`}>
          {!card ? (
            <span className="muted small">Looking up…</span>
          ) : (
            <>
              <span className="person-name">{card.name}</span>
              {(card.title || card.department) && <span className="person-role">{[card.title, card.department].filter(Boolean).join(' · ')}</span>}
              {card.manager && <span className="muted small">Reports to {card.manager}</span>}
              {card.email && <Copyable label="Email" value={card.email} />}
              {card.slackHandle && <Copyable label="Slack" value={card.slackHandle} />}
              {!card.title && !card.department && <span className="muted small">Not in your org chart (Settings → Org chart).</span>}
            </>
          )}
        </span>
      )}
    </span>
  );
}

function Copyable({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="person-row">
      <span className="muted small">{label}</span>
      <span className="person-value" title={value}>
        {value}
      </span>
      <button
        type="button"
        className="link small"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))
            .catch(() => undefined)
        }
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
