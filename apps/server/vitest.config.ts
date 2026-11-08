import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { testTimeout: 30_000, env: { DEMO_REPLY_DELAY_MS: '50', DEMO_SEED_DELAY_MS: '10' } } });
