import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — E2E tests exercise UI → GraphQL → advisory lock → DB.
 *
 * Prerequisites:
 *   1. Postgres running (`make up` at repo root).
 *   2. Migrations applied + seed (`make migrate && make seed`).
 *   3. Browsers installed (`pnpm e2e:install`, runs `playwright install chromium`).
 *
 * The config starts the API and web servers itself but reuses ones you already
 * have running locally, so `pnpm dev` in another terminal won't conflict.
 */
export default defineConfig({
  testDir: './tests-e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },  // generous — Apollo cold start in dev can be slow
  fullyParallel: false,           // Tests share the dev DB; serialize for predictability.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  // Two reporters: live console output during the run, plus a persistent HTML
  // report you can open later with `pnpm e2e:report`. `open: 'never'` keeps
  // Playwright from auto-launching a browser when the run finishes — the user
  // controls when the report server starts.
  reporter: [
    [process.env.CI ? 'line' : 'list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @app/api dev',
      cwd: '../..',
      port: 4000,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @app/web dev',
      cwd: '../..',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
