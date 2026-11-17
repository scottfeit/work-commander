import { useEffect, useState } from 'react';

/** The single-key shortcuts, as shown in the "?" overlay. */
export const SHORTCUTS: { keys: string[]; what: string; group: string }[] = [
  { group: 'Work streams', keys: ['j'], what: 'Next work stream or proposal' },
  { group: 'Work streams', keys: ['k'], what: 'Previous work stream or proposal' },
  { group: 'Work streams', keys: ['p'], what: 'Pending on / off' },
  { group: 'Work streams', keys: ['c'], what: 'Close the stream (press twice if Settings asks for two clicks)' },
  { group: 'Work streams', keys: ['u'], what: 'Mark unread and go back to the list' },
  { group: 'Work streams', keys: ['/'], what: 'Filter work streams' },
  { group: 'Proposals and ? items', keys: ['a'], what: 'Accept' },
  { group: 'Proposals and ? items', keys: ['d'], what: 'Decline' },
  { group: 'Proposals and ? items', keys: ['m'], what: 'Decline & mute' },
  { group: 'Work items', keys: ['h', '['], what: 'Previous tab' },
  { group: 'Work items', keys: ['l', ']'], what: 'Next tab' },
  { group: 'Work items', keys: ['r'], what: 'Quick reply' },
  { group: 'Work items', keys: ['e'], what: 'Archive / unarchive the email' },
  { group: 'Work items', keys: ['#'], what: 'Delete / undelete the email' },
  { group: 'Work items', keys: ['Shift+I'], what: 'Mark the email read' },
  { group: 'Work items', keys: ['Shift+U'], what: 'Mark the email unread' },
  { group: 'Anywhere', keys: ['⌘Z'], what: 'Undo' },
  { group: 'Anywhere', keys: ['?'], what: 'Show these shortcuts' },
  { group: 'Anywhere', keys: ['Esc'], what: 'Close this list' },
];

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (!!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || el.isContentEditable);
};

/** A visible, enabled button in `root` whose accessible name (or text) matches. */
function button(root: ParentNode | null, name: RegExp): HTMLButtonElement | null {
  if (!root) return null;
  for (const b of root.querySelectorAll<HTMLButtonElement>('button')) {
    const label = b.getAttribute('aria-label') ?? b.textContent ?? '';
    if (!b.disabled && name.test(label.trim()) && b.getClientRects().length > 0) return b;
  }
  return null;
}

const tiles = () => [...document.querySelectorAll<HTMLElement>('.sidebar .stream:not(.general)')].filter((t) => t.getClientRects().length > 0);
// A ? item or proposal being viewed is the current one (the work stream behind it stays highlighted).
const activeTile = () => document.querySelector<HTMLElement>('.sidebar .skipped-tile.active') ?? document.querySelector<HTMLElement>('.sidebar .stream.active:not(.general)');

function step(d: 1 | -1) {
  const all = tiles();
  if (!all.length) return;
  const cur = activeTile();
  const i = cur ? all.indexOf(cur) : -1;
  const next = all[i < 0 ? (d === 1 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, i + d))];
  next.querySelector<HTMLButtonElement>('.stream-open, .skipped-open')?.click();
  next.scrollIntoView({ block: 'nearest' });
}

function tab(d: 1 | -1) {
  const all = [...document.querySelectorAll<HTMLElement>('.top-pane .tabbar [role=tab], .item-side .tabbar [role=tab]')];
  const unique = [...new Set(all)];
  if (!unique.length) return;
  const i = unique.findIndex((t) => t.classList.contains('active'));
  const next = unique[i < 0 ? 0 : (i + d + unique.length) % unique.length];
  (next.querySelector<HTMLElement>('.tab-open') ?? next).click();
}

/** What each key does. Returns false when the key isn't a shortcut here (so it isn't swallowed). */
function run(key: string): boolean {
  const tile = activeTile();
  const head = document.querySelector('.top-pane .item-head');
  const gmail = document.querySelector('.top-pane .gmail-actions');
  const click = (b: HTMLButtonElement | null) => (b ? (b.click(), true) : false);
  switch (key) {
    case 'j':
      step(1);
      return true;
    case 'k':
      step(-1);
      return true;
    case ']':
    case 'l':
      tab(1);
      return true;
    case '[':
    case 'h':
      tab(-1);
      return true;
    case '/': {
      const f = document.querySelector<HTMLInputElement>('.sidebar input.search');
      f?.focus();
      return !!f;
    }
    case 'p':
      return click(tile?.querySelector<HTMLButtonElement>('.pending-btn') ?? null);
    case 'c':
      return click(button(tile, /^(Close stream|Click again to close)$/));
    case 'u':
      return click(button(tile, /^Mark unread$/));
    case 'a':
      return click(button(tile, /^Accept$/));
    case 'd':
      return click(button(tile, /^Decline$/));
    case 'm':
      return click(button(tile, /^Decline & mute$/));
    case 'r':
      return click(button(head, /^Quick reply$/));
    case 'e':
      return click(button(gmail, /^(Archive|Unarchive)/));
    case '#':
      return click(button(gmail, /^(Delete|Undelete)/));
    case 'I':
      return click(button(gmail, /^Mark read/));
    case 'U':
      return click(button(gmail, /^Mark unread/));
  }
  return false;
}

/** Single-key shortcuts on the main screen (not while typing), and the "?" list of them. */
export function Shortcuts() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (location.pathname.startsWith('/settings')) return;
      if (e.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      if (typing(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (open) return;
      if (run(e.key)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <div className="shortcuts-backdrop" onClick={() => setOpen(false)}>
      <div className="shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
        <div className="shortcuts-grid">
          {groups.map((g) => (
            <section key={g}>
              <h3>{g}</h3>
              <dl>
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <div key={s.what} className="shortcut">
                    <dt>
                      {s.keys.map((k, n) => (
                        <span key={k}>
                          {n > 0 && <span className="muted small"> or </span>}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd>{s.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="muted small">Shortcuts don't fire while you're typing; Esc leaves a text box.</p>
      </div>
    </div>
  );
}
