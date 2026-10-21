/**
 * End-to-end configuration for the product: the two servers a run starts, the browser project it
 * drives them with, and how a run is reported.
 *
 * The suite exercises the running product rather than a built bundle, so `npm run test:e2e` needs
 * no build step. Its first server is the API process and its second is the Vite development server,
 * which proxies every `/api` request to that process — the client uses the relative base `/api`, so
 * the browser reaches the API through the proxy and no host or port appears in a spec. `baseURL` is
 * therefore the Vite origin: a spec navigates with `page.goto('/')`, and the relative paths in
 * `e2e/support/api.ts` resolve against the same origin.
 *
 * The API is readiness-checked through its own liveness route rather than by probing the port, so a
 * server that is listening but not serving cannot let a run begin.
 *
 * Nothing here is conditional on continuous integration, and nothing carries credentials: this is a
 * single-user application on loopback, with no build pipeline and no authentication.
 */
import { defineConfig, devices } from '@playwright/test';

/**
 * Reads one of the run's two ports from the environment, falling back to the documented default.
 *
 * Both ports are inputs rather than fixed numbers because a checkout may share its host with other
 * work: an ambient value moves both the server and everything that addresses it. A value that is
 * absent, empty or not a usable port number falls back, so a malformed variable cannot put `NaN`
 * into the proxy target or the base URL and fail somewhere less readable.
 */
function resolvePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

/** Port the API process binds, and the target the frontend's `/api` proxy forwards to. */
const API_PORT = resolvePort(process.env.PORT, 3000);

/** Port the Vite development server listens on — the run's `baseURL`. */
const WEB_PORT = resolvePort(process.env.VITE_DEV_PORT, 5173);

/**
 * SQLite file the end-to-end API process opens, relative to the backend workspace directory — the
 * directory npm makes the working directory of a workspace script — so it names `backend/data/e2e.db`.
 *
 * It is exported and read here and by `e2e/globalSetup.ts` because both halves of the run act on the
 * same file: this configuration hands it to the API process, which creates it, and the hook clears it
 * before the run. One definition is what keeps the file a run writes to and the file the hook clears
 * from drifting apart.
 */
export const E2E_DATABASE_PATH = './data/e2e.db';

export default defineConfig({
  testDir: './e2e',

  // The specs are serialized. Every one of them drives the same API process over the same SQLite
  // file, so two running at once would assert against each other's rows; a single worker is what
  // makes the shared store safe rather than what it costs. For the same reason a failed test is
  // never retried: determinism comes from the global setup below and from each spec clearing the
  // store through `e2e/support/api.ts`, so a retry would only hide a real failure.
  fullyParallel: false,
  workers: 1,
  retries: 0,

  // Removes the end-to-end database and its sidecars before the run, so a run never depends on what
  // an earlier one left behind.
  globalSetup: './e2e/globalSetup.ts',

  // Both directories are covered by `.gitignore`.
  outputDir: 'test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  // The budget these cover is a first list load of under a second on a development machine, with a
  // cold `tsx` start and Vite's first transform absorbed by the server timeouts below.
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // One browser, desktop-sized. It is also the wider of the two widths the responsive spec asserts:
  // that spec sets its own viewport per test, so no second project and no device matrix is needed.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    // Captured on the first attempt rather than on a retry, because `retries` is 0 above: a test's
    // first run is its only run, so a retry-triggered trace could never fire. This mode keeps the
    // trace only when that attempt fails, which is the failure a report needs evidence for.
    trace: 'retain-on-first-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  // Both entries start from the checkout as it stands, never from a build output, and both pass the
  // same `PORT` so the API that binds it and the proxy that targets it cannot disagree. A cold start
  // of each — `tsx` first compiling the API, Vite its first transform — is why the timeout is
  // generous. Existing servers are never reused, so a run always tests the code in the checkout.
  webServer: [
    {
      command: 'npm run dev --workspace @todo/backend',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        // The one definition of the file, above: this process creates it inside the backend
        // workspace and `e2e/globalSetup.ts` clears that same path before the run.
        DATABASE_PATH: E2E_DATABASE_PATH,
        // The suite runs `silent` so its output stays readable: the API's startup record and its
        // per-request records are not part of what a spec asserts; `.env.example` and the README
        // state the same level for the test suites.
        LOG_LEVEL: 'silent',
      },
    },
    {
      // The port is passed on the command line because `frontend/vite.config.ts` fixes its own; the
      // flag is the override that file documents, and `--strictPort` keeps a busy port a loud
      // failure instead of a quieter server on some other port that `baseURL` would not address.
      command: `npm run dev --workspace @todo/frontend -- --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
      },
    },
  ],
});
