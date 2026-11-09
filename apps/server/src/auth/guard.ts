import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import type { AppConfig } from '../config.js';
import type { SettingsStore } from '../core/settings.js';

const PUBLIC = [/^\/api\/webhooks\//, /^\/healthz$/];

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
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== undefined) {
        // "null" (sandboxed iframes, file://) and unparsable values are treated as foreign origins.
        let o = '';
        try {
          o = new URL(req.headers.origin).hostname;
        } catch {
          /* fall through: not allowed */
        }
        if (!localHosts.includes(o)) return reply.code(403).send({ error: 'Cross-origin request blocked' });
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
