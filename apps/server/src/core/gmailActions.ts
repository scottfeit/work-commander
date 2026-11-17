import type { GmailAction, GmailThreadState, ItemData } from '@wc/shared';
import type { IntegrationHub } from '../integrations/hub.js';
import type { Repo } from './repo.js';
import { bus } from './bus.js';

/** The Gmail buttons on an email work item: act on the whole thread in Gmail, then store where it is now. */
export async function gmailThreadAction(d: { repo: Repo; hub: IntegrationHub }, itemId: string, action: GmailAction | null, opts: { toInbox?: boolean } = {}): Promise<GmailThreadState> {
  const item = await d.repo.getItem(itemId);
  if (!item) throw new Error('Item not found');
  if (item.source !== 'gmail') throw new Error('Only email work items are in Gmail');
  const mail = await d.hub.api('email');
  if (!mail.modifyThread || !mail.threadState) throw new Error('Gmail actions need Google connected with sign-in (Settings → Google)');
  const threadId = item.data.gmail?.threadId ?? item.externalId;
  if (action) await mail.modifyThread(threadId, action, opts);
  const state = await mail.threadState(threadId);
  const cur = (await d.repo.getItem(itemId))!;
  const data: ItemData = { ...cur.data, gmail: { ...(cur.data.gmail ?? { threadId }), state } };
  await d.repo.db.updateTable('items').set({ data: JSON.stringify(data) }).where('id', '=', itemId).execute();
  bus.publish({ type: 'item.updated', item: { ...cur, data } });
  return state;
}
