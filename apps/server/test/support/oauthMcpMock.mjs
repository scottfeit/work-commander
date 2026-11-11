// OAuth-protected MCP server used by mcpOAuth.test.ts: protected-resource + auth-server metadata, dynamic client registration, PKCE (S256), 60-second tokens, refresh.
import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const codes = new Map(), tokens = new Map(), refresh = new Map();
const json = (res, code, body, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
const issue = () => { const a = 'at_' + crypto.randomBytes(8).toString('hex'), rt = 'rt_' + crypto.randomBytes(8).toString('hex'); tokens.set(a, Date.now() + 60_000); refresh.set(rt, true); return { access_token: a, token_type: 'Bearer', expires_in: 60, refresh_token: rt }; };
export function startMockOAuthMcp(PORT) {
  const BASE = `http://127.0.0.1:${PORT}`;
  const events = [];
  const log = (...a) => events.push(a.join(" "));
  const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${BASE}/mcp`, authorization_servers: [BASE] });
  if (u.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, { issuer: BASE, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, registration_endpoint: `${BASE}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  if (u.pathname === '/register') { const m = JSON.parse(await body(req)); log('register', m.client_name, m.redirect_uris); return json(res, 201, { ...m, client_id: 'cid_' + crypto.randomBytes(4).toString('hex'), client_id_issued_at: Math.floor(Date.now() / 1000) }); }
  if (u.pathname === '/authorize') {
    const code = 'code_' + crypto.randomBytes(6).toString('hex');
    codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri'), resource: u.searchParams.get('resource') });
    log('authorize: method', u.searchParams.get('code_challenge_method'), 'resource', u.searchParams.get('resource'));
    res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(u.searchParams.get('state'))}` }); return res.end();
  }
  if (u.pathname === '/token') {
    const p = new URLSearchParams(await body(req));
    if (p.get('grant_type') === 'authorization_code') {
      const c = codes.get(p.get('code')); codes.delete(p.get('code'));
      const ok = c && crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url') === c.challenge;
      log('token exchange, PKCE ok:', !!ok);
      return ok ? json(res, 200, issue()) : json(res, 400, { error: 'invalid_grant' });
    }
    if (p.get('grant_type') === 'refresh_token' && refresh.delete(p.get('refresh_token'))) { log('refresh ok'); return json(res, 200, issue()); }
    return json(res, 400, { error: 'invalid_grant' });
  }
  if (u.pathname === '/mcp') {
    const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!tokens.has(t) || tokens.get(t) < Date.now()) { log('mcp 401'); return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"` }); }
    const server = new McpServer({ name: 'mock', version: '1' });
    server.tool('list_channels', 'List channels', async () => ({ content: [{ type: 'text', text: 'general, random' }] }));
    server.tool('post_message', 'Post', async () => ({ content: [{ type: 'text', text: 'posted' }] }));
    const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => tr.close());
    await server.connect(tr);
    const b = req.method === 'POST' ? JSON.parse((await body(req)) || 'null') : undefined;
    return tr.handleRequest(req, res, b);
  }
  res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r({ events, close: () => new Promise((c) => server.close(c)) })));
}
