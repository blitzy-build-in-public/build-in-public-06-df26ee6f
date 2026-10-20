import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { applyMigrations } from './migrations.js';

/**
 * Opens the SQLite file at `path`, brings its schema up to date and returns the open handle.
 *
 * The parent directory is created recursively when it is missing, so a fresh checkout — which has no
 * data directory at all — works on its first run. The connection is configured before any migration
 * runs, so the persisted behaviour never depends on the driver's or the file's defaults, and the
 * schema is created or upgraded on the same handle the caller receives.
 *
 * The caller owns the returned handle and must close it (`db.close()`); this function never closes a
 * handle it hands back. The one handle it closes is the one it opened itself, when configuring or
 * migrating it fails: the caller never receives that handle, so the connection would otherwise stay
 * open — the file with its `-wal` and `-shm` sidecars — until the process exits. A failure to create
 * the directory, open the file or migrate it is thrown unchanged, because that is a startup failure
 * the process must report loudly rather than a request failure to translate into a response.
 *
 * @param path Filesystem location of the database file, or `':memory:'` for a private in-memory
 *   database, which has no file and therefore no directory to create.
 */
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  // The busy timeout makes a writer that arrives while another write is committing wait up to five
  // seconds rather than failing at once, which is what lets concurrent edits resolve as last write
  // wins instead of as an immediate error.
  const db = new Database(path, { timeout: 5000 });

  try {
    // Both pragmas are set on the freshly opened connection so nothing depends on compile-time or
    // file defaults: WAL lets a read proceed while a write commits, which keeps the list responsive
    // under that same last-write-wins rule, and foreign keys are enabled now even though this schema
    // has none, so a later migration that adds one does not silently lose enforcement.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Only after the connection is configured above, so the schema is created with those pragmas in
    // force and the handle handed back is current from the moment the caller has it.
    applyMigrations(db);
  } catch (error) {
    // Nothing hands this handle back — the error below is what the caller gets — so a refused or
    // failing migration would leave the connection open on the file for the life of the process.
    try {
      db.close();
    } catch {
      // Deliberately swallowed: the error thrown below is the failure the caller must see, and
      // reporting a close failure here instead would replace the refusal or migration failure an
      // operator needs to read.
    }

    throw error;
  }

  return db;
}
