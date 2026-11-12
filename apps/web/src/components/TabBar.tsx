import { useEffect, useRef, useState } from 'react';
import type { StreamItem, WorkStream } from '@wc/shared';
export { orderTabs } from '@wc/shared';
import { BRAND_PATHS } from './brandIcons';

export const OVERVIEW_TAB = '__overview__';

/** Drag payload for moving an item to another work stream (drop it on a stream in the sidebar). */
export const ITEM_DRAG = 'application/x-wc-item';
// The id being dragged is not readable during dragover, so it is remembered here (to tell a tab reorder from a drag to another stream).
let draggingItem: string | null = null;
export const dragItem = (id: string) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    draggingItem = id;
    e.dataTransfer.setData(ITEM_DRAG, id);
    e.dataTransfer.effectAllowed = 'move';
  },
  onDragEnd: () => {
    // Some browsers fire this before the drop lands, so let the drop finish first.
    setTimeout(() => {
      if (draggingItem === id) draggingItem = null;
    }, 150);
  },
});

export const SOURCE_LABEL: Record<string, string> = {
  gmail: 'Email',
  slack: 'Slack',
  jira: 'Jira',
  jsm: 'JSM',
  confluence: 'Confluence',
  drive: 'Drive',
  calendar: 'Calendar',
  grant: 'Access',
  mcp: 'MCP',
  note: 'Note',
};

/** Which brand mark each source shows; sources without one keep a text label. */
const SOURCE_ICON: Record<string, string> = { gmail: 'gmail', slack: 'slack', jira: 'jira', jsm: 'jira', confluence: 'confluence', drive: 'drive', calendar: 'calendar', grant: 'onepassword' };
const SOURCE_NAME: Record<string, string> = { gmail: 'Gmail', jsm: 'Jira Service Management', grant: '1Password access' };

/** A bell with a slash through it: this item's updates are silenced. */
export function SilencedIcon() {
  return (
    <span className="silenced-icon" role="img" aria-label="Notifications silenced" title="Notifications silenced">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path d="M12 3a6 6 0 0 0-6 6v3.6L4.4 16A1 1 0 0 0 5.3 17.5h13.4a1 1 0 0 0 .9-1.5L18 12.6V9a6 6 0 0 0-6-6z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M3.5 3.5l17 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function SourceBadge({ source }: { source: string }) {
  const icon = SOURCE_ICON[source];
  const name = SOURCE_NAME[source] ?? SOURCE_LABEL[source] ?? source;
  if (!icon) return <span className={`src src-${source}`}>{SOURCE_LABEL[source] ?? source}</span>;
  return (
    <span className={`src-icon brand-${icon}`} role="img" aria-label={name} title={name}>
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path d={BRAND_PATHS[icon]} />
      </svg>
    </span>
  );
}

export function TabBar({
  stream,
  items,
  tab,
  onTab,
  peek,
  onClosePeek,
  onReorder,
  onAddUrl,
}: {
  stream: WorkStream | null;
  items: StreamItem[];
  tab: string;
  onTab: (id: string) => void;
  peek?: StreamItem | null;
  onClosePeek?: () => void;
  /** Drop `id` before or after `targetId`. Overview never moves. */
  onReorder?: (id: string, targetId: string, after: boolean) => void;
  /** Add a work item from a pasted link (the + at the right of the bar). Rejects with a message the popover shows. */
  onAddUrl?: (url: string) => Promise<void>;
}) {
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  // A previewed item (e.g. a skipped message) gets a temporary tab that is not part of the stream and goes away when you navigate off it.
  const peekTab = peek && !items.some((i) => i.id === peek.id) && (
    <span key={peek.id} className={`tab peek ${tab === peek.id ? 'active' : ''}`} role="tab" title={`${peek.title}\nPreview: not part of a work stream`} {...dragItem(peek.id)}>
      <button className="peek-main" onClick={() => onTab(peek.id)}>
        <SourceBadge source={peek.source} />
        <span className="tab-title">{peek.data.ticket?.key ?? peek.title}</span>
      </button>
      <button className="peek-close" aria-label="Close preview" onClick={onClosePeek}>
        ×
      </button>
    </span>
  );
  if (!stream)
    return (
      <div className="tabbar">
        <div className={`tab ${tab === OVERVIEW_TAB ? 'active' : ''}`} onClick={() => onTab(OVERVIEW_TAB)}>
          Overview
        </div>
        {peekTab}
      </div>
    );
  const droppable = (id: string) => !!draggingItem && draggingItem !== id && items.some((i) => i.id === draggingItem);
  return (
    <div className="tabbar" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}>
      <div className="tablist" role="tablist">
      <button
        role="tab"
        className={`tab ${tab === OVERVIEW_TAB ? 'active' : ''} ${over?.id === OVERVIEW_TAB ? 'drop-after' : ''}`}
        onClick={() => onTab(OVERVIEW_TAB)}
        onDragOver={(e) => {
          // Overview never moves, but dropping on it puts the tab first (right after Overview).
          if (!items.length || !draggingItem || !items.some((x) => x.id === draggingItem)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver({ id: OVERVIEW_TAB, after: true });
        }}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData(ITEM_DRAG) || draggingItem;
          if (!dragged || dragged === items[0]?.id || !items.some((x) => x.id === dragged)) return; // already first
          e.preventDefault();
          setOver(null);
          onReorder?.(dragged, items[0].id, false);
        }}
      >
        Overview
      </button>
      {items.map((i) => (
        <button
          key={i.id}
          role="tab"
          className={`tab ${tab === i.id ? 'active' : ''} ${over?.id === i.id ? (over.after ? 'drop-after' : 'drop-before') : ''}`}
          onClick={() => onTab(i.id)}
          title={`${i.title}\nDrag to rearrange, or onto another work stream to move it`}
          {...dragItem(i.id)}
          onDragOver={(e) => {
            if (!droppable(i.id)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const r = e.currentTarget.getBoundingClientRect();
            setOver({ id: i.id, after: e.clientX > r.left + r.width / 2 });
          }}
          onDrop={(e) => {
            // The drag data is the reliable source for what was dropped; the remembered id is only a fallback.
            const dragged = e.dataTransfer.getData(ITEM_DRAG) || draggingItem;
            if (!dragged || dragged === i.id || !items.some((x) => x.id === dragged)) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setOver(null);
            onReorder?.(dragged, i.id, e.clientX > r.left + r.width / 2);
          }}
        >
          {i.data.unread && tab !== i.id && <span className="dot" aria-label="new activity" />}
          {i.data.muted && <SilencedIcon />}
          <SourceBadge source={i.source} />
          <span className="tab-title">{i.data.ticket?.key ?? i.title}</span>
        </button>
      ))}
      {peekTab}
      </div>
      {onAddUrl && <AddByUrl onAdd={onAddUrl} />}
    </div>
  );
}

/** The "+" at the right of the tab bar: a small popover under it takes a pasted link to add as a work item. */
function AddByUrl({ onAdd }: { onAdd: (url: string) => Promise<void> }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen((o) => !o);
    setErr(null);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.add-url-pop, .add-url-btn')) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onAdd(url.trim());
      setUrl('');
      setOpen(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button ref={btn} type="button" className="add-url-btn" aria-label="New work item from a link" aria-expanded={open} title="New work item from a link" onClick={toggle}>
        +
      </button>
      {open && (
        <div className="add-url-pop" role="dialog" aria-label="New work item from a link" style={{ top: pos.top, right: pos.right }}>
          <label className="small" htmlFor="add-url-input">
            Paste a link to a Slack message, Gmail message, Google Doc or Jira issue
          </label>
          <div className="row-form">
            <input id="add-url-input" autoFocus value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
            <button type="button" className="btn small primary" disabled={busy || !url.trim()} onClick={() => void submit()}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
          {err && <div className="error small">{err}</div>}
          <div className="muted small">Claude will review it and add anything relevant to the Overview. For a Slack message, related messages posted after it come in too.</div>
        </div>
      )}
    </>
  );
}
