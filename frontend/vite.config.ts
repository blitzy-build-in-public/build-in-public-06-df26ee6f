/**
 * Vite and Vitest configuration for the `@todo/frontend` workspace.
 *
 * One file serves both toolchains: Vite reads `plugins` and `server` to compile the
 * bundle and to run the development and preview servers, and Vitest reads the `test`
 * block because `defineConfig` is imported from `vitest/config` rather than `vite`.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** The port the API listens on when `PORT` is absent or holds nothing usable as a port. */
const DEFAULT_API_PORT = 3000;

/**
 * Reads the API's port, taking `DEFAULT_API_PORT` when the variable is absent or unusable.
 *
 * This is the one rule `backend/src/main.ts` and `playwright.config.ts` apply to the
 * same variable: an absent, empty, non-numeric, zero or out-of-range value falls back,
 * so the proxy target and the port the API actually binds cannot disagree. The rule is
 * repeated here rather than imported, because neither workspace may import the other's
 * sources.
 *
 * @param value The variable's value, or `undefined` when it is unset.
 */
function resolveApiPort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : DEFAULT_API_PORT;
}

/** The port this server forwards `/api` requests to. */
const API_PORT = resolveApiPort(process.env.PORT);

export default defineConfig({
  // The JSX transform and React fast refresh for the `.tsx` sources.
  plugins: [react()],
  server: {
    // Fixed rather than environment-driven: this is the origin the root
    // `playwright.config.ts` expects for the frontend workspace and the origin its
    // baseURL uses. A checkout that has to avoid a busy port passes `--port` on the
    // command line, which overrides this value.
    port: 5173,
    // The browser reaches the API only through this proxy — the client uses the
    // relative base `/api`, so no absolute host appears anywhere in `frontend/src`
    // and no cross-origin configuration exists. The target follows `PORT`, the same
    // variable the API process binds, through the same integer-and-range guard that
    // process uses, so a `PORT` that is absent, empty, non-numeric, zero or out of
    // range falls back to the documented default of 3000 on both sides instead of
    // reaching this URL unparsed: an empty value would render as `http://localhost:`
    // and silently mean port 80, and a non-numeric one is not a URL at all.
    // `vite preview` inherits `server.proxy`, so this single entry also serves the
    // built bundle and the end-to-end run; no `preview.proxy` block is needed.
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    // The frontend suite runs in jsdom, which the component and hook tests need.
    environment: 'jsdom',
    // Registers Testing Library's automatic cleanup hook and makes `describe`, `it`,
    // `expect` and `vi` available without importing them; `frontend/tsconfig.json`
    // types them through `types: ["vitest/globals"]`.
    globals: true,
    // The single setup module, resolved against this file's own directory. It
    // registers jest-dom's DOM assertions with Vitest's `expect`.
    setupFiles: ['./tests/setup.ts'],
    // Only the suites are collected. Support modules such as
    // `tests/support/helpers.tsx` are imported by the suites rather than run as tests.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      // `include` is declared explicitly because Vitest 4 removed `coverage.all` and
      // no longer counts uncovered files automatically. Coverage is reported for the
      // frontend and deliberately not gated, so no `thresholds` block belongs here:
      // the enforced threshold covers the backend domain and application layers.
      provider: 'v8',
      include: ['src/**'],
    },
  },
});
