/**
 * OAuth for remote MCP servers (MCP authorization spec: protected-resource discovery, authorization-server
 * metadata, dynamic client registration or a pre-registered client, PKCE, resource indicators, refresh).
 *
 * The browser sign-in runs once through /api/oauth/mcp/:system/start → the server's login → /api/oauth/mcp/callback.
 * Tokens and client registration are kept in the secret store (they include a refresh token). Before every use
 * a current access token is attached as an Authorization header, both for Work Commander's own MCP calls and
 * for the agent's MCP connection, refreshing it first when it is about to expire.
 */
import crypto from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpServerSettings, SecretBackend } from '@wc/shared';

export type McpSystem = 'google' | 'slack' | 'atlassian';

interface Stored {
  tokens?: OAuthTokens;
  /** ms epoch when tokens were saved, to work out expiry from expires_in. */
  savedAt?: number;
  client?: OAuthClientInformationMixed;
  discovery?: unknown;
}
interface Pending {
  system: McpSystem;
  url: string;
  verifier?: string;
  createdAt: number;
}

export interface McpOAuthDeps {
  secrets: { get(id: string): Promise<string>; has(id: string): Promise<boolean>; set(id: string, v: string, b: SecretBackend, label?: string): Promise<unknown>; remove(id: string): Promise<void> };
  sync: { get(k: string): Promise<string | null | undefined>; set(k: string, v: string): Promise<void> };
  defaultBackend: () => Promise<SecretBackend>;
  redirectUri: () => string;
}

const REFRESH_EARLY_MS = 5 * 60_000;
const PENDING_TTL_MS = 15 * 60_000;
export const mcpTokenSecretId = (url: string) => `mcp.oauth.${crypto.createHash('sha256').update(url.replace(/\/+$/, '')).digest('hex').slice(0, 16)}`;

export class McpOAuth {
  constructor(private d: McpOAuthDeps) {}

  private async load(url: string): Promise<Stored> {
    const id = mcpTokenSecretId(url);
    if (!(await this.d.secrets.has(id))) return {};
    try {
      return JSON.parse(await this.d.secrets.get(id)) as Stored;
    } catch {
      return {};
    }
  }
  private async save(url: string, patch: Partial<Stored>) {
    const next = { ...(await this.load(url)), ...patch };
    await this.d.secrets.set(mcpTokenSecretId(url), JSON.stringify(next), await this.d.defaultBackend(), `MCP OAuth (${new URL(url).host})`);
  }

  /** A provider for the SDK's auth() flow. `onRedirect` receives the login URL when a browser sign-in is needed. */
  private provider(s: McpServerSettings, state: string | undefined, onRedirect: (u: URL) => void): OAuthClientProvider {
    const url = s.url!;
    const self = this;
    const preRegistered = s.oauth?.clientId;
    const metadata: OAuthClientMetadata = {
      client_name: 'Work Commander',
      redirect_uris: [this.d.redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(s.oauth?.scope ? { scope: s.oauth.scope } : {}),
    };
    return {
      get redirectUrl() {
        return self.d.redirectUri();
      },
      get clientMetadata() {
        return metadata;
      },
      state: () => state ?? crypto.randomBytes(16).toString('hex'),
      async clientInformation() {
        if (preRegistered) {
          const secret = s.oauth?.clientSecretId ? await self.d.secrets.get(s.oauth.clientSecretId) : undefined;
          return { client_id: preRegistered, ...(secret ? { client_secret: secret } : {}) };
        }
        return (await self.load(url)).client;
      },
      async saveClientInformation(info) {
        if (!preRegistered) await self.save(url, { client: info });
      },
      async tokens() {
        return (await self.load(url)).tokens;
      },
      async saveTokens(tokens) {
        await self.save(url, { tokens, savedAt: Date.now() });
      },
      redirectToAuthorization(u) {
        onRedirect(u);
      },
      async saveCodeVerifier(v) {
        if (!state) return;
        const p = await self.pending(state);
        if (p) await self.d.sync.set(`mcp.oauth.pending.${state}`, JSON.stringify({ ...p, verifier: v }));
      },
      async codeVerifier() {
        const p = state ? await self.pending(state) : null;
        if (!p?.verifier) throw new Error('Sign-in expired; start it again from Settings');
        return p.verifier;
      },
      async saveDiscoveryState(d) {
        await self.save(url, { discovery: d });
      },
      async discoveryState() {
        return (await self.load(url)).discovery as any;
      },
      async invalidateCredentials(scope) {
        const cur = await self.load(url);
        if (scope === 'all') await self.save(url, { tokens: undefined, client: undefined, discovery: undefined });
        else if (scope === 'tokens') await self.save(url, { tokens: undefined });
        else if (scope === 'client') await self.save(url, { client: undefined });
        else if (scope === 'discovery') await self.save(url, { discovery: undefined });
        void cur;
      },
    };
  }

  private async pending(state: string): Promise<Pending | null> {
    const raw = await this.d.sync.get(`mcp.oauth.pending.${state}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pending;
    return Date.now() - p.createdAt > PENDING_TTL_MS ? null : p;
  }

  /** Begin sign-in. Returns the URL to send the browser to, or null if already authorized (e.g. refreshed). */
  async start(system: McpSystem, s: McpServerSettings): Promise<string | null> {
    if (!s.url || s.transport === 'stdio') throw new Error('OAuth needs a remote (HTTP or SSE) MCP server URL');
    const state = `${system}.${crypto.randomBytes(16).toString('hex')}`;
    await this.d.sync.set(`mcp.oauth.pending.${state}`, JSON.stringify({ system, url: s.url, createdAt: Date.now() } satisfies Pending));
    let login: URL | null = null;
    // Clear old tokens so auth() starts a fresh sign-in rather than silently reusing them.
    await this.save(s.url, { tokens: undefined });
    const r = await auth(this.provider(s, state, (u) => (login = u)), { serverUrl: s.url, scope: s.oauth?.scope || undefined });
    if (r === 'AUTHORIZED') return null;
    if (!login) throw new Error('The MCP server did not provide a sign-in page');
    return (login as URL).toString();
  }

  /** Finish sign-in from the redirect. Returns which system it was for. */
  async finish(state: string, code: string, current: (system: McpSystem) => Promise<McpServerSettings | undefined>) {
    const p = await this.pending(state);
    if (!p) throw new Error('Sign-in expired or was already used; start it again from Settings');
    const s = await current(p.system);
    if (!s?.url || s.url !== p.url) throw new Error('The MCP server URL changed during sign-in; start it again');
    const r = await auth(this.provider(s, state, () => undefined), { serverUrl: s.url, authorizationCode: code, scope: s.oauth?.scope || undefined });
    await this.d.sync.set(`mcp.oauth.pending.${state}`, '');
    if (r !== 'AUTHORIZED') throw new Error('The MCP server did not issue a token');
    return p.system;
  }

  /** Current access token, refreshed shortly before it expires. Throws if a new sign-in is needed. */
  async accessToken(s: McpServerSettings): Promise<string> {
    const url = s.url!;
    const st = await this.load(url);
    if (!st.tokens?.access_token) throw new Error(`Not signed in to the MCP server at ${new URL(url).host}. Press "Sign in" in Settings.`);
    const exp = st.tokens.expires_in && st.savedAt ? st.savedAt + st.tokens.expires_in * 1000 : null;
    // Refresh 5 minutes early, or halfway through the lifetime for short-lived tokens.
    const early = Math.min(REFRESH_EARLY_MS, ((st.tokens.expires_in ?? 0) * 1000) / 2);
    if (exp === null || exp - Date.now() > early) return st.tokens.access_token;
    if (!st.tokens.refresh_token) throw new Error(`The MCP sign-in for ${new URL(url).host} expired. Press "Sign in" in Settings.`);
    let needsLogin = false;
    const r = await auth(this.provider(s, undefined, () => (needsLogin = true)), { serverUrl: url, scope: s.oauth?.scope || undefined });
    if (r !== 'AUTHORIZED' || needsLogin) throw new Error(`The MCP sign-in for ${new URL(url).host} expired. Press "Sign in" in Settings.`);
    return (await this.load(url)).tokens!.access_token;
  }

  async signOut(s: McpServerSettings) {
    if (s.url) await this.d.secrets.remove(mcpTokenSecretId(s.url)).catch(() => undefined);
  }
}

/** Set once at startup; mcp.ts uses it to add Authorization headers for OAuth-enabled servers. */
let instance: McpOAuth | null = null;
export const setMcpOAuth = (o: McpOAuth) => (instance = o);
export async function oauthHeaders(s: McpServerSettings): Promise<Record<string, string>> {
  if (!s.oauth?.enabled || s.transport === 'stdio' || !s.url) return {};
  if (!instance) throw new Error('MCP OAuth is not initialised');
  return { Authorization: `Bearer ${await instance.accessToken(s)}` };
}
