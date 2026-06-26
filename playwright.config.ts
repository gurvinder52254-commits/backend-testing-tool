/**
 * ============================================================
 * Playwright Configuration — Page Analyzer
 * ============================================================
 * Run:
 *   PAGE_URL=https://example.com npx playwright test --headed --project=chromium
 * ============================================================
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: 'list',
  timeout: 60_000,
  use: {
    headless: false,
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], headless: false },
    },
  ],
});
