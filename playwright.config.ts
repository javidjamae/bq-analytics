import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.HARNESS_PORT ?? 4319)
const baseURL = `http://127.0.0.1:${PORT}`

/**
 * The e2e suite exists for the parts of `src/browser.ts` that only a real
 * browser can exercise: sendBeacon during page unload, the fetch fallback when
 * a beacon is refused, storage that throws, and sessionStorage dying with the
 * tab. Stubbed globals in the unit tests cannot reach any of those, because
 * the stubs encode the same assumptions as the code they check.
 */
export default defineConfig({
  testDir: './e2e',
  // The harness records delivered events in one module-level array, so the
  // specs share mutable server state and must not interleave.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node e2e/harness/server.mjs',
    url: `${baseURL}/_events`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
