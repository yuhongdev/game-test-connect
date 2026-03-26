import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import 'dotenv/config';

// Build a datetime stamp once per run: YYYY-MM-DD_HH-MM-SS
const runStamp = new Date()
    .toISOString()
    .replace('T', '_')
    .replace(/:/g, '-')
    .slice(0, 19); // "2026-03-25_13-44-00"

// All e2e UI test artifacts go into their own timestamped subfolder
// so they never overwrite results from other test flows.
const uiOutputDir = path.join('test-results', 'e2e-ui', runStamp);

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  /**
   * globalSetup runs ONCE before test collection.
   * It fetches the live vendor list and writes playwright/.auth/vendors.json
   * so s9_test_v2.spec.ts can read it synchronously at collection time.
   */
  globalSetup: path.resolve(__dirname, 'tests', 'globalSetup.ts'),
  testDir: './tests',
  /**
   * Isolate e2e UI artifacts into test-results/e2e-ui/<YYYY-MM-DD_HH-MM-SS>/
   * so each run gets its own folder and other test flows are unaffected.
   */
  outputDir: uiOutputDir,
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  // 14 workers: optimal for i7-14700F (8 P-cores + 12 E-cores = 20 logical cores).
  // Leaves ~6 cores headroom for OS, Node.js orchestrator, and system tasks.
  workers: process.env.CI ? 1 : 14,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    baseURL: process.env.BASE_URL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /**
     * Performance flags for Chromium:
     *  --disable-gpu            : Forces CPU rendering. The GT 710 is slower than
     *                             CPU compositing for headless browser tasks, and
     *                             removing GPU IPC overhead reduces context switch cost.
     *  --no-sandbox             : Skips sandbox init (safe on a trusted dev machine).
     *  --disable-dev-shm-usage  : Uses /tmp instead of /dev/shm — avoids shared memory
     *                             exhaustion when running 84 simultaneous pages.
     *  --disable-extensions     : No extension processes competing for CPU.
     */
    launchOptions: {
      args: [
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
      ],
    },
  },

  /* Configure projects for major browsers */
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
      // dependencies: ['setup'],
    },

    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        storageState: 'playwright/.auth/user.json',
      },
      // dependencies: ['setup'],
    },

    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        storageState: 'playwright/.auth/user.json',
      },
      // dependencies: ['setup'],
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
