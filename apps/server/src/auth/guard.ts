import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import type { AppConfig } from '../config.js';
import type { SettingsStore } from '../core/settings.js';

const PUBLIC = [/^\/api\/webhooks\//, /^\/healthz$/];

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The exact origins (scheme, host and port) WC's own pages are served from: its public URL and its web front-end, under any of
 * this machine's names. (Host names alone aren't enough: a page on another port of this machine is another site.) Names in
 * WC_ALLOWED_HOSTS (e.g. a reverse proxy) are trusted on any port.
 */
export function allowedOrigins(cfg: Pick<AppConfig, 'publicUrl' | 'webUrl'>) {
  const out = new Set<string>();
  for (const raw of [cfg.publicUrl, cfg.webUrl]) {
    if (!raw) continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    out.add(u.origin);
    if (LOOPBACK.includes(u.hostname)) for (const h of LOOPBACK) out.add(`${u.protocol}//${h}${u.port ? `:${u.port}` : ''}`);
  }
  return out;
}

/** Is this Origin header one of WC's own pages? Missing, "null" and unparsable values are not. */
export function isOwnOrigin(origin: string | undefined, cfg: Pick<AppConfig, 'publicUrl' | 'webUrl'>) {
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (allowedOrigins(cfg).has(u.origin)) return true;
  const extra = (process.env.WC_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return extra.includes(u.hostname);
}

/**
 * Dashboard access control.
 *  - local: the server binds to 127.0.0.1; we additionally reject requests whose Host isn't
 *    localhost (DNS-rebinding) and cross-origin state-changing requests.
 *  - iap (GCP): Cloud Run sits behind Identity-Aware Proxy; every request must carry a valid IAP
 *    JWT for the configured audience, and the identity must be the PU (one PU per instance).
 */
export function installGuard(app: FastifyInstance, cfg: AppConfig, settings: SettingsStore) {
  const iap = new OAuth2Client();
  // Local mode has no login, so only requests addressed to this machine are served (blocks DNS
  // rebinding and other sites' pages). WC_ALLOWED_HOSTS adds names, e.g. for a reverse proxy.
  const localHosts = ['localhost', '127.0.0.1', '[::1]', ...(process.env.WC_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)];
  let keys: { pubkeys: any; at: number } | null = null;

  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC.some((r) => r.test(req.url))) return;
    if (cfg.authMode === 'local') {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!localHosts.includes(host)) return reply.code(403).send({ error: 'Forbidden host' });
      // A request that changes something must come from WC's own page (exact origin, port included). "null" (sandboxed
      // iframes, file://) and unparsable values count as foreign. No Origin at all = not a browser page (curl, scripts).
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== undefined && !isOwnOrigin(req.headers.origin, cfg)) {
        return reply.code(403).send({ error: 'Cross-origin request blocked' });
      }
      return;
    }
    const email = await verifyIap(req);
    if (!email) return reply.code(401).send({ error: 'IAP authentication required' });
    const s = await settings.get();
    const allowed = (process.env.WC_ALLOWED_EMAIL || s.pu.email || '').toLowerCase();
    if (allowed && email.toLowerCase() !== allowed) return reply.code(403).send({ error: `This instance belongs to ${allowed}` });
  });

  async function verifyIap(req: FastifyRequest) {
    const jwt = req.headers['x-goog-iap-jwt-assertion'];
    if (typeof jwt !== 'string' || !cfg.iapAudience) return null;
    if (!keys || Date.now() - keys.at > 3600_000) keys = { pubkeys: (await iap.getIapPublicKeys()).pubkeys, at: Date.now() };
    try {
      const ticket = await iap.verifySignedJwtWithCertsAsync(jwt, keys.pubkeys, cfg.iapAudience, ['https://cloud.google.com/iap']);
      return ticket.getPayload()?.email ?? null;
    } catch {
      return null;
    }
  }
}
