import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A reserved SQLite database location for a single test.
 *
 * `path` is the absolute `.db` path to hand to `openDatabase`, which owns the
 * creation of the file itself. `directory` is the temporary directory that
 * contains it; the directory is what gets removed, because SQLite in WAL mode
 * writes its `-wal` and `-shm` sidecars beside the database file, so deleting
 * the `.db` alone would leave those behind.
 *
 * `cleanup()` is idempotent: a test that fails part-way and the `afterEach`
 * that disposes of it may both call it, and neither may throw.
 */
export interface TempDatabase {
  /** Absolute path of the (not yet existing) SQLite database file. */
  readonly path: string;
  /** Temporary directory holding the database file and its SQLite sidecars. */
  readonly directory: string;
  /** Removes the whole temporary directory tree; safe to call more than once. */
  cleanup(): void;
}

/**
 * Reserves a unique temporary directory under the OS temp directory and returns
 * an absolute database path inside it.
 *
 * The database file is deliberately not created here: `openDatabase` creates the
 * parent directory and the file, and the migration suite needs a genuinely fresh
 * path so that a first open migrates it from version 0. This module is the only
 * place in `backend/tests` that creates a database file, so the developer's
 * `backend/data/todo.db` and the end-to-end suite's `backend/data/e2e.db` are
 * never opened by a backend test.
 *
 * @param prefix Directory name prefix, kept recognisable so a stray directory in
 * the OS temp directory can be identified during cleanup triage. Defaults to
 * `'todo-backend-test-'`.
 */
export function createTempDatabase(prefix = 'todo-backend-test-'): TempDatabase {
  // mkdtempSync creates the directory itself with a unique name and owner-only
  // permissions, so concurrent suites cannot collide and no mkdir call is needed.
  const directory = mkdtempSync(join(tmpdir(), prefix));

  const path = join(directory, 'todo.db');

  let cleaned = false;

  return {
    path,
    directory,
    cleanup(): void {
      // Guard so a repeated call after the test already disposed of the database
      // is a silent no-op instead of a cleanup error masking the real failure;
      // `force` covers the same case should the directory disappear in between.
      if (cleaned) {
        return;
      }

      cleaned = true;

      // Recursive removal takes the database file, its `-wal`/`-shm` sidecars and
      // anything else the test wrote inside the directory it owns.
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
