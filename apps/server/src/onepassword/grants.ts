import { nanoid } from 'nanoid';
import type { Settings } from '@wc/shared';
import type { Repo } from '../core/repo.js';
import { j, now, pj } from '../db/index.js';
import type { SecretStore } from '../secrets/store.js';
import { createOnePasswordClient, type OnePasswordClient } from './client.js';

export type AuthScheme = 'bearer' | 'basic' | `header:${string}`;

/**
 * Credential grants: the PU approves an agent's request for a 1Password item. The secret itself
 * never enters the model's context. Instead the agent gets a grant id it can use with the
 * `http_request` tool, which injects the credential server-side and only for the approved hosts.
 */
export class GrantService {
  constructor(
    private repo: Repo,
    private secrets: SecretStore,
    private getSettings: () => Promise<Settings>,
    private clientFactory?: () => Promise<OnePasswordClient>,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async client() {
    if (this.clientFactory) return this.clientFactory();
    const s = await this.getSettings();
    if (!s.onepassword.enabled) throw new Error('1Password is not enabled in Settings');
    return createOnePasswordClient(s.onepassword, (id) => this.secrets.get(id));
  }

  async listItems(query?: string) {
    const s = await this.getSettings();
    return (await this.client()).listItems(s.onepassword.accessVault, query);
  }

  async create(input: { streamId: string | null; item: string; allowedHosts: string[]; authScheme: AuthScheme }) {
    const s = await this.getSettings();
    const item = await (await this.client()).getItem(s.onepassword.accessVault, input.item);
    const hosts = input.allowedHosts.length ? input.allowedHosts : item.urls.map((u) => safeHost(u)).filter(Boolean);
    if (!hosts.length) throw new Error('No allowed hosts: add the system URL to the 1Password item or list hosts in the approval');
    const id = `g_${nanoid(8)}`;
    const expires = new Date(Date.now() + s.onepassword.grantTtlMinutes * 60_000).toISOString();
    await this.repo.db
      .insertInto('grants')
      .values({ id, stream_id: input.streamId, item_reference: input.item, item_title: item.title, allowed_hosts: j(hosts), auth_scheme: input.authScheme, status: 'active', expires_at: expires, created_at: now() })
      .execute();
    await this.repo.audit('pu', 'grant.created', { id, item: item.title, hosts, expires });
    return { id, title: item.title, hosts, expiresAt: expires };
  }

  async revoke(id: string) {
    await this.repo.db.updateTable('grants').set({ status: 'revoked' }).where('id', '=', id).execute();
  }

  async list(streamId?: string) {
    let q = this.repo.db.selectFrom('grants').selectAll().orderBy('created_at', 'desc');
    if (streamId) q = q.where('stream_id', '=', streamId);
    return (await q.execute()).map((g) => ({ ...g, allowed_hosts: pj<string[]>(g.allowed_hosts, []) }));
  }

  async request(input: { grantId: string; method: string; url: string; headers?: Record<string, string>; body?: string }) {
    const g = await this.repo.db.selectFrom('grants').selectAll().where('id', '=', input.grantId).executeTakeFirst();
    if (!g || g.status !== 'active') throw new Error('Grant not found or revoked');
    if (g.expires_at && g.expires_at < now()) throw new Error('Grant expired; request access again');
    const url = new URL(input.url);
    if (url.protocol !== 'https:') throw new Error('Only https URLs are allowed');
    const hosts = pj<string[]>(g.allowed_hosts, []);
    if (!hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) throw new Error(`Host ${url.hostname} is not covered by this grant (${hosts.join(', ')})`);
    const s = await this.getSettings();
    const item = await (await this.client()).getItem(s.onepassword.accessVault, g.item_reference);
    const secret = item.credential ?? item.password ?? '';
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
    const scheme = g.auth_scheme as AuthScheme;
    if (scheme === 'bearer') headers.Authorization = `Bearer ${secret}`;
    else if (scheme === 'basic') headers.Authorization = `Basic ${Buffer.from(`${item.username ?? ''}:${secret}`).toString('base64')}`;
    else if (scheme.startsWith('header:')) headers[scheme.slice(7)] = secret;
    const r = await this.fetchImpl(url, { method: input.method, headers, body: input.body, redirect: 'manual' });
    let text = await r.text();
    for (const v of [secret, item.username].filter((x): x is string => !!x && x.length > 3)) text = text.split(v).join('[redacted]');
    await this.repo.audit('agent', 'grant.request', { grant: g.id, method: input.method, url: url.origin + url.pathname, status: r.status });
    return `HTTP ${r.status}\n${text.slice(0, 20_000)}`;
  }
}

function safeHost(u: string) {
  try {
    return new URL(u.includes('://') ? u : `https://${u}`).hostname;
  } catch {
    return '';
  }
}
