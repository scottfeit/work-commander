import type { StreamItem } from '@wc/shared';
import type { IntegrationHub } from '../integrations/hub.js';
import type { Repo } from './repo.js';
import { gmailThreadAction } from './gmailActions.js';

/**
 * The trash button on a proposed or skipped tile ("delete and mute"): besides declining and muting, an email thread goes to
 * Gmail's Trash and a Slack DM / group DM is marked read in Slack. Not offered for Jira/JSM, for Slack channel threads
 * (apps can't mark those read), or when the source isn't connected directly.
 */
export type TrashWhat = 'gmail' | 'slack';
export interface TrashOption {
  can: boolean;
  what?: TrashWhat;
}

const kinds = new Map<string, 'im' | 'mpim' | 'channel'>();

export function slackChannelOf(item: StreamItem) {
  return item.data.slack?.channel ?? item.externalId.split(':')[0];
}

export async function trashOption(d: { hub: IntegrationHub }, item: StreamItem): Promise<TrashOption> {
  if (item.source === 'gmail') {
    const mail = await d.hub.api('email').catch(() => null);
    return mail?.modifyThread ? { can: true, what: 'gmail' } : { can: false };
  }
  if (item.source === 'slack') {
    const chat = await d.hub.api('chat').catch(() => null);
    if (!chat?.readState || !chat.markConversation) return { can: false };
    const channel = slackChannelOf(item);
    if (!channel) return { can: false };
    // a conversation's kind never changes: ask Slack once
    let kind = channel.startsWith('D') ? 'im' : kinds.get(channel);
    if (!kind) {
      kind = (await chat.readState(channel).catch(() => ({ kind: undefined }))).kind;
      if (kind) kinds.set(channel, kind);
    }
    return kind === 'im' || kind === 'mpim' ? { can: true, what: 'slack' } : { can: false };
  }
  return { can: false };
}

/** Trash the email thread / mark the Slack conversation read. Returns what was done, for Undo. */
export async function trashUnderlying(d: { repo: Repo; hub: IntegrationHub }, item: StreamItem): Promise<{ what: TrashWhat; wasInInbox?: boolean }> {
  const opt = await trashOption(d, item);
  if (!opt.can || !opt.what) throw Object.assign(new Error(item.source === 'slack' ? 'Only Slack DMs and group DMs can be marked read' : "This item can't be deleted at its source"), { statusCode: 400 });
  if (opt.what === 'gmail') {
    const wasInInbox = item.data.gmail?.state?.inbox ?? true;
    await gmailThreadAction(d, item.id, 'trash');
    return { what: 'gmail', wasInInbox };
  }
  const chat = await d.hub.api('chat');
  await chat.markConversation!(slackChannelOf(item), true);
  return { what: 'slack' };
}

/** Undo for the Slack half: mark the conversation unread again. */
export async function slackMarkUnread(d: { repo: Repo; hub: IntegrationHub }, itemId: string) {
  const item = await d.repo.getItem(itemId);
  if (!item) return;
  const chat = await d.hub.api('chat');
  await chat.markConversation?.(slackChannelOf(item), false);
}
