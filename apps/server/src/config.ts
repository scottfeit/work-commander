import path from 'node:path';
import os from 'node:os';

/**
 * Process-level configuration from environment variables. Everything a PU can change at runtime
 * lives in the Settings record in the database instead; this is only deployment wiring.
 */
export interface AppConfig {
  port: number;
  host: string;
  hosting: 'local' | 'gcp';
  dataDir: string;
  databaseUrl: string;
  publicUrl: string;
  /** Where the web UI is served, for browser redirects. Empty = same origin as the API (built mode). */
  webUrl: string;
  authMode: 'local' | 'iap';
  /** IAP audience: /projects/PROJECT_NUMBER/global/backendServices/SERVICE_ID or /projects/N/locations/R/services/S */
  iapAudience?: string;
  demoMode: boolean;
  webDist: string;
  gcpProjectId?: string;
  version: string;
}

export function loadConfig(env = process.env): AppConfig {
  const hosting = (env.WC_HOSTING ?? (env.K_SERVICE ? 'gcp' : 'local')) as 'local' | 'gcp';
  const demoMode = env.DEMO_MODE === '1' || env.DEMO_MODE === 'true';
  // Demo data never mixes with a real setup.
  const dataDir = env.WC_DATA_DIR ?? path.join(os.homedir(), demoMode ? '.work-commander-demo' : '.work-commander');
  const port = Number(env.PORT ?? 8787);
  const host = env.WC_HOST ?? (hosting === 'gcp' ? '0.0.0.0' : '127.0.0.1');
  return {
    port,
    host,
    hosting,
    dataDir,
    databaseUrl: env.DATABASE_URL ?? `sqlite:${path.join(dataDir, 'work-commander.sqlite')}`,
    publicUrl: (env.WC_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    webUrl: (env.WC_WEB_URL ?? '').replace(/\/$/, ''),
    authMode: (env.WC_AUTH_MODE ?? (hosting === 'gcp' ? 'iap' : 'local')) as 'local' | 'iap',
    iapAudience: env.WC_IAP_AUDIENCE,
    demoMode,
    webDist: env.WC_WEB_DIST ?? path.resolve(process.cwd(), '../web/dist'),
    gcpProjectId: env.GOOGLE_CLOUD_PROJECT ?? env.GCP_PROJECT_ID,
    version: env.WC_VERSION ?? '0.1.0',
  };
}
