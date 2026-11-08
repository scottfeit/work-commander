import type { StreamItem, WorkStream } from '@wc/shared';

export const OVERVIEW_TAB = '__overview__';

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

export function SourceBadge({ source }: { source: string }) {
  return <span className={`src src-${source}`}>{SOURCE_LABEL[source] ?? source}</span>;
}

export function TabBar({ stream, items, tab, onTab }: { stream: WorkStream | null; items: StreamItem[]; tab: string; onTab: (id: string) => void }) {
  if (!stream) return <div className="tabbar"><div className="tab active">Overview</div></div>;
  return (
    <div className="tabbar" role="tablist">
      <button role="tab" className={`tab ${tab === OVERVIEW_TAB ? 'active' : ''}`} onClick={() => onTab(OVERVIEW_TAB)}>
        Overview
      </button>
      {items.map((i) => (
        <button key={i.id} role="tab" className={`tab ${tab === i.id ? 'active' : ''}`} onClick={() => onTab(i.id)} title={i.title}>
          <SourceBadge source={i.source} />
          <span className="tab-title">{i.data.ticket?.key ?? i.title}</span>
        </button>
      ))}
    </div>
  );
}
