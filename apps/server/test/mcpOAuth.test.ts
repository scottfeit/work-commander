import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerSettings } from '@wc/shared';
import { McpOAuth, mcpTokenSecretId, setMcpOAuth } from '../src/integrations/mcpOAuth.js';
import { McpConnection } from '../src/integrations/mcp.js';
// @ts-expect-error plain JS test helper
import { startMockOAuthMcp } from './support/oauthMcpMock.mjs';

const PORT = 8897;
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const REDIRECT = 'http://localhost:9999/api/oauth/mcp/callback';

describe('MCP OAuth', () => {
  let mock: { events: string[]; close: () => Promise<void> };
  const secrets = new Map<string, string>();
  const sync = new Map<string, string>();
  const oauth = new McpOAuth({
    secrets: {
      get: async (id) => {
        if (!secrets.has(id)) throw new Error('missing');
        return secrets.get(id)!;
      },
      has: async (id) => secrets.has(id),
      set: async (id, v) => void secrets.set(id, v),
      remove: async (id) => void secrets.delete(id),
    },
    sync: { get: async (k) => sync.get(k), set: async (k, v) => void sync.set(k, v) },
    defaultBackend: async () => 'keychain',
    redirectUri: () => REDIRECT,
  });
  setMcpOAuth(oauth);
  const s: McpServerSettings = { transport: 'http', url: URL_, readOnlyToolPatterns: ['list'], oauth: { enabled: true } };

  beforeAll(async () => (mock = await startMockOAuthMcp(PORT)));
  afterAll(() => mock.close());

  /** Act as the browser: open the login URL; the mock approves at once and redirects back with a code. */
  const signIn = async (settings: McpServerSettings) => {
    const login = await oauth.start('slack', settings);
    expect(login).toBeTruthy();
    const r = await fetch(login!, { redirect: 'manual' });
    const back = new URL(r.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    return oauth.finish(back.searchParams.get('state')!, back.searchParams.get('code')!, async () => settings);
  };

  it('needs sign-in before use', async () => {
    await expect(McpConnection.open(s, async () => '')).rejects.toThrow(/Not signed in/);
  });

  it('signs in with dynamic registration + PKCE and then calls tools with the token', async () => {
    expect(await signIn(s)).toBe('slack');
    expect(mock.events.some((e) => e.startsWith('register'))).toBe(true);
    expect(mock.events).toContain('token exchange, PKCE ok: true');
    const conn = await McpConnection.open(s, async () => '');
    try {
      expect((await conn.listTools()).map((t) => t.name)).toEqual(['list_channels', 'post_message']);
    } finally {
      await conn.close();
    }
  });

  it('refreshes a token about to expire, and not before', async () => {
    const before = mock.events.filter((e) => e === 'refresh ok').length;
    await oauth.accessToken(s); // fresh 60s token: no refresh
    expect(mock.events.filter((e) => e === 'refresh ok').length).toBe(before);
    const id = mcpTokenSecretId(URL_);
    const st = JSON.parse(secrets.get(id)!);
    secrets.set(id, JSON.stringify({ ...st, savedAt: Date.now() - 50_000 })); // 10s left
    const t = await oauth.accessToken(s);
    expect(t).not.toBe(st.tokens.access_token);
    expect(mock.events.filter((e) => e === 'refresh ok').length).toBe(before + 1);
  });

  it('uses a pre-registered client id without registering', async () => {
    const regs = mock.events.filter((e) => e.startsWith('register')).length;
    await signIn({ ...s, oauth: { enabled: true, clientId: 'preregistered' } });
    expect(mock.events.filter((e) => e.startsWith('register')).length).toBe(regs);
  });

  it('rejects an unknown or reused sign-in state', async () => {
    await expect(oauth.finish('slack.bogus', 'code', async () => s)).rejects.toThrow(/expired|already used/);
  });

  it('signs out', async () => {
    await oauth.signOut(s);
    await expect(oauth.accessToken(s)).rejects.toThrow(/Not signed in/);
  });
});
