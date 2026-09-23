import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3199);

// End-to-end tests run the real server with the scripted composer (no API key needed) against
// the production client bundle.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // Synth-only autopilot: the sandboxed browser can't fetch GitHub-hosted samples.
    command: `npm run build && rm -rf .e2e-data && BSIDE_COMPOSER=scripted BSIDE_AUTOPILOT=synth BSIDE_DATA_DIR=.e2e-data PORT=${PORT} npm start`,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
