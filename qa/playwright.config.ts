import { defineConfig } from '@playwright/test';

// Every spec file boots its own isolated demo instance (see helpers.ts), so there is no global webServer.
export default defineConfig({
  testDir: './tests',
  outputDir: './results/artifacts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: './results/results.json' }]],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1400, height: 900 },
    launchOptions: process.env.QA_CHROMIUM ? { executablePath: process.env.QA_CHROMIUM } : {},
  },
});
