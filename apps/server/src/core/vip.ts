import type { ItemData, Person, ThreadMessage } from '@wc/shared';
import type { Database } from '../db/index.js';
import { now, pj } from '../db/index.js';

/** Who the VIPs are, by every id a message author can carry. */
export interface VipIndex {
  emails: Set<string>;
  slackIds: Set<string>;
  accountIds: Set<string>;
}

type Author = ThreadMessage['author'];

export function isVipAuthor(idx: VipIndex, a: Author | undefined | null): boolean {
  if (!a) return false;
  return (!!a.email && idx.emails.has(a.email.trim().toLowerCase())) || (!!a.slackUserId && idx.slackIds.has(a.slackUserId)) || (!!a.accountId && idx.accountIds.has(a.accountId));
}

/** The PU's managers, nearest first, up the org chart (stops at the top or on a loop). */
export function managerialLineage(people: Person[], puEmails: string[]): Person[] {
  const by = new Map(people.map((p) => [p.email.toLowerCase(), p]));
  const me = puEmails.map((e) => by.get(e.trim().toLowerCase())).find(Boolean);
  const out: Person[] = [];
  const seen = new Set<string>(me ? [me.email.toLowerCase()] : []);
  let next = me?.managerEmail?.toLowerCase();
  while (next && !seen.has(next)) {
    seen.add(next);
    const m = by.get(next);
    if (!m) break;
    out.push(m);
    next = m.managerEmail?.toLowerCase();
  }
  return out;
}

const LINEAGE_KEY = 'vip.followLineage';

/** VIPs are kept apart from the org chart (a re-import replaces the people), so they survive refreshes. */
export class Vips {
  private cache: Promise<VipIndex> | null = null;
  constructor(private db: Database) {}

  invalidate() {
    this.cache = null;
  }

  index(): Promise<VipIndex> {
    this.cache ??= this.build().catch((e) => {
      this.cache = null;
      throw e;
    });
    return this.cache;
  }

  private async build(): Promise<VipIndex> {
    const rows = await this.db.selectFrom('vips').select('email').where('vip', '=', 1).execute();
    const emails = new Set(rows.map((r) => r.email));
    const idx: VipIndex = { emails, slackIds: new Set(), accountIds: new Set() };
    if (!emails.size) return idx;
    const people = await this.db.selectFrom('people').select(['email', 'slack_user_id', 'atlassian_account_id']).execute();
    for (const p of people) {
      if (!emails.has(p.email)) continue;
      if (p.slack_user_id) idx.slackIds.add(p.slack_user_id);
      if (p.atlassian_account_id) idx.accountIds.add(p.atlassian_account_id);
    }
    return idx;
  }

  /** Every VIP decision: vip true/false (false = removed by hand, so the lineage won't add them back). */
  async list(): Promise<{ email: string; vip: boolean; origin: 'manual' | 'lineage' }[]> {
    const rows = await this.db.selectFrom('vips').selectAll().execute();
    return rows.map((r) => ({ email: r.email, vip: !!r.vip, origin: r.origin === 'lineage' ? 'lineage' : 'manual' }));
  }

  async set(email: string, vip: boolean) {
    const e = email.trim().toLowerCase();
    if (!e) throw new Error('Email required');
    await this.db
      .insertInto('vips')
      .values({ email: e, vip: vip ? 1 : 0, origin: 'manual', updated_at: now() })
      .onConflict((oc) => oc.column('email').doUpdateSet({ vip: vip ? 1 : 0, origin: 'manual', updated_at: now() }))
      .execute();
    this.invalidate();
  }

  async followingLineage() {
    const r = await this.db.selectFrom('sync_state').select('value').where('key', '=', LINEAGE_KEY).executeTakeFirst();
    return r?.value === '1';
  }

  /** The Settings button: make the PU's managers VIPs, now and whenever a new one appears. There is no turning it off. */
  async followLineage(puEmails: string[]) {
    await this.db.insertInto('sync_state').values({ key: LINEAGE_KEY, value: '1' }).onConflict((oc) => oc.column('key').doUpdateSet({ value: '1' })).execute();
    return this.syncLineage(puEmails);
  }

  /**
   * Adds managers in the PU's lineage who have no VIP decision yet. Anyone already decided (made VIP or removed by hand) is
   * left alone, and people who leave the lineage stay VIP. Returns the emails added.
   */
  async syncLineage(puEmails: string[]): Promise<string[]> {
    if (!(await this.followingLineage())) return [];
    const rows = await this.db.selectFrom('people').selectAll().execute();
    const people: Person[] = rows.map((r) => ({ id: r.id, name: r.name, email: r.email, managerEmail: r.manager_email ?? undefined, source: r.source as Person['source'] }));
    const decided = new Set((await this.db.selectFrom('vips').select('email').execute()).map((r) => r.email));
    const added: string[] = [];
    for (const m of managerialLineage(people, puEmails)) {
      const e = m.email.toLowerCase();
      if (decided.has(e)) continue;
      await this.db.insertInto('vips').values({ email: e, vip: 1, origin: 'lineage', updated_at: now() }).onConflict((oc) => oc.doNothing()).execute();
      added.push(e);
    }
    if (added.length) this.invalidate();
    return added;
  }
}

/** Every message on an item, with a ticket's requester as the opening one. */
function messagesOf(data: ItemData): { author: Author; at: string; isFromPU?: boolean }[] {
  const t = data.ticket;
  if (t) {
    const opener = t.requester?.includes('@') ? [{ author: { email: t.requester }, at: '' }] : [];
    return [...opener, ...(t.comments ?? [])];
  }
  return data.messages ?? [];
}

/** When a VIP last wrote in these items, and when anyone else last wrote after that. */
export function vipActivity(items: { data: string | ItemData }[], idx: VipIndex): { vipAt: string | null; otherAfter: string | null } {
  const msgs = items.flatMap((i) => messagesOf(typeof i.data === 'string' ? pj<ItemData>(i.data, {} as ItemData) : i.data));
  let vipAt: string | null = null;
  for (const m of msgs) if (!m.isFromPU && isVipAuthor(idx, m.author) && (vipAt === null || m.at > vipAt)) vipAt = m.at;
  if (vipAt === null) return { vipAt: null, otherAfter: null };
  let otherAfter: string | null = null;
  for (const m of msgs) if (m.at > vipAt && (m.isFromPU || !isVipAuthor(idx, m.author)) && (otherAfter === null || m.at > otherAfter)) otherAfter = m.at;
  return { vipAt, otherAfter };
}

/** The latest of these new messages is from a VIP (or, for a new ticket with nothing else, a VIP raised it). */
export function startedByVip(idx: VipIndex, fresh: ThreadMessage[], data: ItemData): boolean {
  const fromOthers = fresh.filter((m) => !m.isFromPU);
  if (fromOthers.length) return isVipAuthor(idx, fromOthers.reduce((a, b) => (a.at >= b.at ? a : b)).author);
  const t = data.ticket;
  return !!t && !t.comments?.length && !!t.requester && isVipAuthor(idx, { email: t.requester });
}
