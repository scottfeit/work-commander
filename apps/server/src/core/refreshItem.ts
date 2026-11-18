import type { StreamItem } from '@wc/shared';
import type { IntegrationHub } from '../integrations/hub.js';
import type { InboundItem } from '../integrations/types.js';
import type { Repo } from './repo.js';

/** Sources a work item can be re-read from on demand. */
export const REFRESHABLE = new Set(['gmail', 'slack', 'jira', 'jsm']);

/**
 * Re-read one work item from its source now and store what's new, the same way a poll stores it, but without triage: no
 * notification, unread mark, draft or Claude call. (The next poll then sees nothing new for it.)
 */
export async function refreshItem(d: { repo: Repo; hub: IntegrationHub }, item: StreamItem): Promise<StreamItem> {
  if (!REFRESHABLE.has(item.source)) throw new Error("This kind of work item can't be refreshed");
  const how = item.source === 'gmail' ? 'google' : item.source === 'slack' ? 'slack' : 'atlassian';
  if ((await d.hub.systemMode(how)) !== 'api') throw new Error(`Refreshing needs ${how === 'google' ? 'Google' : how === 'slack' ? 'Slack' : 'Atlassian'} connected directly (not through an MCP server); it updates on the next poll`);
  let fresh: InboundItem;
  if (item.source === 'gmail') {
    fresh = await (await d.hub.api('email')).getThread(item.data.gmail?.threadId ?? item.externalId);
  } else if (item.source === 'slack') {
    const [channel, ts] = item.externalId.split(':');
    const chat = (await d.hub.api('chat')) as Awaited<ReturnType<IntegrationHub['api']>> & { getDmConversation?: (c: string) => Promise<InboundItem> };
    if (ts === 'dm' || !ts) {
      if (!chat.getDmConversation) throw new Error("This Slack conversation can't be refreshed here");
      fresh = await chat.getDmConversation(channel);
    } else fresh = await (chat as any).getThread(channel, item.data.slack?.threadTs ?? ts);
  } else {
    fresh = await (await d.hub.api('tickets')).getIssue(item.data.ticket?.key ?? item.externalId);
  }
  const { item: updated } = await d.repo.upsertItem({ ...fresh, externalId: item.source === 'slack' ? fresh.externalId : item.externalId, streamId: item.streamId });
  await d.repo.audit('you', 'item.refreshed', { itemId: item.id });
  return (await d.repo.getItem(item.id)) ?? updated;
}
