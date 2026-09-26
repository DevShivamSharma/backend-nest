import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/api',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:18081' },
  webServer: {
    command: 'node -r ts-node/register test/api-server.ts',
    url: 'http://127.0.0.1:18081/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: '18081' },
  },
});
