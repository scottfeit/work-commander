import type { StreamItem, WorkStream } from '@wc/shared';
import { BRAND_PATHS } from './brandIcons';

export const OVERVIEW_TAB = '__overview__';

/** Drag payload for moving an item to another work stream (drop it on a stream in the sidebar). */
export const ITEM_DRAG = 'application/x-wc-item';
export const dragItem = (id: string) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    e.dataTransfer.setData(ITEM_DRAG, id);
    e.dataTransfer.effectAllowed = 'move';
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

export function TabBar({ stream, items, tab, onTab }: { stream: WorkStream | null; items: StreamItem[]; tab: string; onTab: (id: string) => void }) {
  if (!stream) return <div className="tabbar"><div className="tab active">Overview</div></div>;
  return (
    <div className="tabbar" role="tablist">
      <button role="tab" className={`tab ${tab === OVERVIEW_TAB ? 'active' : ''}`} onClick={() => onTab(OVERVIEW_TAB)}>
        Overview
      </button>
      {items.map((i) => (
        <button key={i.id} role="tab" className={`tab ${tab === i.id ? 'active' : ''}`} onClick={() => onTab(i.id)} title={`${i.title}\nDrag to another work stream to move it`} {...dragItem(i.id)}>
          <SourceBadge source={i.source} />
          <span className="tab-title">{i.data.ticket?.key ?? i.title}</span>
        </button>
      ))}
    </div>
  );
}
