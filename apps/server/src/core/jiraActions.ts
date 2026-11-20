import type { StreamItem, TicketTransitionOption } from '@wc/shared';
import type { IntegrationHub } from '../integrations/hub.js';
import type { Repo } from './repo.js';
import { refreshItem } from './refreshItem.js';

/** Direct actions on a Jira/JSM work item (no draft): status and assignee, from the item's own controls. */
type Deps = { repo: Repo; hub: IntegrationHub };

export async function ticketOf(d: Deps, itemId: string) {
  const item = await d.repo.getItem(itemId);
  if (!item || !item.data.ticket?.key) throw Object.assign(new Error('Not a Jira/JSM work item'), { statusCode: 400 });
  if ((await d.hub.systemMode('atlassian')) !== 'api') throw Object.assign(new Error('Needs Jira connected directly (not through an MCP server)'), { statusCode: 400 });
  return { item, key: item.data.ticket.key, t: await d.hub.api('tickets') };
}

/** The statuses the ticket can move to now, with any fields Jira requires for each (e.g. a Resolution). */
export async function transitionOptions(d: Deps, itemId: string): Promise<{ status: string; transitions: TicketTransitionOption[] }> {
  const { item, key, t } = await ticketOf(d, itemId);
  if (!t.transitionOptions) throw Object.assign(new Error('Not available for this Jira connection'), { statusCode: 400 });
  return { status: item.data.ticket!.status, transitions: await t.transitionOptions(key) };
}

/** Assign the ticket to the PU (or, for Undo, back to an account id / nobody). Returns who had it before, as an account id. */
export async function setAssignee(d: Deps, itemId: string, to: 'me' | { accountId: string | null }): Promise<{ item: StreamItem; before: string | null }> {
  const { item, key, t } = await ticketOf(d, itemId);
  const before = t.assigneeOf ? await t.assigneeOf(key) : null;
  await t.assign({ key, assignee: to === 'me' ? 'me' : to.accountId ? `accountId:${to.accountId}` : null });
  const fresh = await refreshItem(d, item).catch(() => item);
  return { item: fresh, before };
}

/** Move the ticket (by transition id, or to a status by name), then bring the item up to date. */
export async function applyTransition(d: Deps, itemId: string, input: { id?: string; to?: string; fields?: Record<string, string | { id: string }> }): Promise<{ item: StreamItem; from: string }> {
  const { item, key, t } = await ticketOf(d, itemId);
  const from = item.data.ticket!.status;
  await t.transition({ key, to: input.to ?? '', id: input.id, fields: input.fields });
  await d.repo.noteWcTransition(item.id);
  const fresh = await refreshItem(d, item).catch(() => item);
  return { item: fresh, from };
}
