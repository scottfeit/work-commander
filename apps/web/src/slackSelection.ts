import type { StreamItem, ThreadMessage } from '@wc/shared';

/**
 * The Slack work item that's open and the messages ticked in it, shared with the Drafts pane: a Slack draft's "Reply in
 * thread" replies in the thread of the ticked message (or the latest one).
 */
export interface OpenSlackItem {
  channel: string;
  /** A channel thread's own root: every message of the item is in it. */
  itemThreadTs?: string;
  messages: ThreadMessage[];
  selected: string[];
}

let current: OpenSlackItem | null = null;
const subs = new Set<() => void>();

export function setOpenSlackItem(item: StreamItem | null, selected: string[] = []) {
  if (!item || item.source !== 'slack') current = null;
  else {
    const channel = item.data.slack?.channel ?? item.externalId.split(':')[0];
    const flat = channel.startsWith('D') || /:dm(?:@.*)?$/.test(item.externalId);
    current = { channel, itemThreadTs: flat ? undefined : item.data.slack?.threadTs || item.externalId.split(':')[1], messages: item.data.messages ?? [], selected };
  }
  for (const f of subs) f();
}

export const getOpenSlackItem = () => current;

export function subscribeOpenSlackItem(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}

/**
 * The thread to reply in: the ticked message's thread, or a new thread under it when it has none yet (even in an item
 * stored as a thread, such as a group DM that came in live). With nothing ticked: the item's own thread, else the latest
 * message's.
 */
export function threadFor(o: OpenSlackItem): { ts: string; m?: ThreadMessage } | null {
  const byTime = [...o.messages].sort((a, b) => a.at.localeCompare(b.at));
  const picked = byTime.filter((x) => o.selected.includes(x.id)).pop();
  if (picked) return { ts: picked.threadTs ?? picked.id, m: picked };
  if (o.itemThreadTs) return { ts: o.itemThreadTs, m: o.messages.find((x) => x.id === o.itemThreadTs) ?? o.messages[0] };
  const m = byTime.pop();
  return m ? { ts: m.threadTs ?? m.id, m } : null;
}
