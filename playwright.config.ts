import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4517', viewport: { width: 1600, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'pnpm exec tsx tests/e2e/server.ts', url: 'http://127.0.0.1:4517/api/v1/health', reuseExistingServer: process.env.CIEL_E2E_REUSE === '1' },
});
