import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { E2E_DATABASE_PATH } from '../playwright.config';

/**
 * Clears the end-to-end database once, before the run, so every suite starts from
 * the same empty store whatever a previous run left behind.
 *
 * Playwright starts every `webServer` entry and waits for it to be ready before
 * this hook runs, so the API process has usually created and opened the file
 * already. Unlinking it anyway is correct: the handle that process holds stays the
 * single store every spec shares for the whole run, the next run then begins with
 * no file at all, and rows a previous run left behind are cleared per spec by
 * `e2e/support/api.ts`.
 */
export default async function globalSetup(): Promise<void> {
  // Resolved against the working directory rather than this module's own location:
  // Playwright resolves the configured hook path against the config directory but
  // leaves the working directory untouched, and the documented `npm run test:e2e`
  // runs at the repository root. The root package's module format is not fixed, so
  // neither `__dirname` nor `import.meta.url` is relied on here. The path itself
  // comes from the configuration, which hands the same constant to the API process
  // through `DATABASE_PATH`, so both halves of the run name one file.
  const databasePath = resolve(process.cwd(), 'backend', E2E_DATABASE_PATH);

  // `force: true` turns a missing file — and a missing parent directory, which is
  // the fresh-checkout case — into a no-op instead of a throw. The directory itself
  // is left alone; the API creates it recursively when it opens the database.
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}
