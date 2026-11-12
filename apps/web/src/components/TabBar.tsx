import { useState } from 'react';
import { ConfirmButton } from './ConfirmButton';
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
  onClose,
}: {
  stream: WorkStream | null;
  items: StreamItem[];
  tab: string;
  onTab: (id: string) => void;
  peek?: StreamItem | null;
  onClosePeek?: () => void;
  /** Drop `id` before or after `targetId`. Overview never moves. */
  onReorder?: (id: string, targetId: string, after: boolean) => void;
  /** Close the work stream (the icon left of Overview; it asks for a second click). */
  onClose?: () => void;
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
      {onClose && stream.status === 'open' && (
        <ConfirmButton
          className="tab-close"
          armedClassName="tab-close armed"
          ariaLabel="Close work stream"
          title="Close this work stream (asks you to click twice)"
          armedTitle="Click again to close this work stream"
          armedChildren={<span className="tab-close-text">Close?</span>}
          onConfirm={onClose}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </ConfirmButton>
      )}
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
          <SourceBadge source={i.source} />
          <span className="tab-title">{i.data.ticket?.key ?? i.title}</span>
        </button>
      ))}
      {peekTab}
      </div>
    </div>
  );
}
