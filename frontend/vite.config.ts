/**
 * Vite and Vitest configuration for the `@todo/frontend` workspace.
 *
 * One file serves both toolchains: Vite reads `plugins` and `server` to compile the
 * bundle and to run the development and preview servers, and Vitest reads the `test`
 * block because `defineConfig` is imported from `vitest/config` rather than `vite`.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
    // variable the API process binds, and falls back to the documented default of
    // 3000. `vite preview` inherits `server.proxy`, so this single entry also serves
    // the built bundle and the end-to-end run; no `preview.proxy` block is needed.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.PORT ?? '3000'}`,
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
