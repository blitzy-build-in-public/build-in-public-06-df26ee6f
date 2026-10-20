import Database from 'better-sqlite3';

/**
 * One ordered, synchronous schema step.
 *
 * `up` receives the already-open database handle and runs its own DDL. Migrations are append-only
 * and strictly ascending by `version`: an entry that has shipped is never renumbered or rewritten,
 * because a database file already carrying that version will never execute it again.
 */
export interface Migration {
  /** The schema version this step produces; the file's `PRAGMA user_version` after it has run. */
  readonly version: number;
  /** Applies the step's schema change to the open handle. */
  up(db: Database.Database): void;
}

// The version 1 schema. No foreign keys and no secondary index: the product has one entity, every
// read is a single scan of a table capped at 1,000 rows, and filtering and sorting happen in memory
// in the application layer, so no query would use an index on completed, priority, due_date or
// created_at. The primary key on id is the only index this schema needs.
//
// The CHECK constraints mirror the domain rules so a corrupted or hand-edited row cannot present an
// invalid priority or a malformed date. due_date accepts NULL or the YYYY-MM-DD digit shape, which
// is written with POSIX character classes ([0-9]) because that is what SQLite's GLOB supports.
//
// There is no IF NOT EXISTS: version tracking already guarantees the statement runs once, and a
// silently skipped create would hide a real mismatch between the file and this schema.
const CREATE_TASKS_TABLE = `
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority    TEXT NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('low', 'medium', 'high')),
  due_date    TEXT NULL
              CHECK (due_date IS NULL OR
                     due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  completed   INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

/**
 * Every schema step this build knows, in ascending `version` order and frozen by its type.
 *
 * A later schema change is appended as a new entry with the next version; existing entries are left
 * exactly as they are.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(CREATE_TASKS_TABLE);
    },
  },
];

/**
 * The newest schema version this build knows how to produce.
 *
 * Derived from `migrations` so it can never drift from the list, rather than being maintained by hand.
 */
export const LATEST_SCHEMA_VERSION: number = migrations.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/**
 * Brings the database file up to the newest schema version this build knows.
 *
 * The file's version is read from `PRAGMA user_version`, every migration newer than it is applied in
 * ascending order, and each migration runs together with its version bump inside one immediate
 * transaction — so an interrupted run can never leave the schema half-applied or the recorded version
 * out of step with the schema it describes. The call is a no-op on a file already at
 * `LATEST_SCHEMA_VERSION`, and a file newer than the code is refused before anything is applied, so an
 * older build never misreads a newer file.
 *
 * A failure here is a startup failure, not a request failure: it is thrown as a plain `Error` and left
 * to propagate, so the process exits loudly instead of serving from an unusable database. The caller
 * owns the handle's lifetime; this function never closes it.
 *
 * @throws Error when the file's schema version is newer than `LATEST_SCHEMA_VERSION`, or when a
 *   migration step itself fails.
 */
export function applyMigrations(db: Database.Database): void {
  const currentVersion = Number(db.pragma('user_version', { simple: true }));

  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than the newest migration this build knows ` +
        `(${LATEST_SCHEMA_VERSION}); upgrade the application.`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    const applyMigration = db.transaction(() => {
      migration.up(db);
      // The one statement in this codebase built by interpolation: PRAGMA user_version cannot take a
      // bound parameter. The value is the migration's own compile-time version number above, never a
      // request value or any other runtime data.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });

    // Immediate rather than deferred: the write lock is taken at once, so two processes opening the
    // same file cannot both decide a migration is pending.
    applyMigration.immediate();
  }
}
