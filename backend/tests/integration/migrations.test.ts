/**
 * The `tasks` schema as the file on disk really holds it: its creation on a fresh file, its
 * version, its physical shape, its constraints and its durability.
 *
 * Every other suite in `backend/tests` reaches the database through a port — the repository
 * contract, the use cases, the HTTP routes — and none of them can see a column, a `CHECK` or a
 * `PRAGMA user_version`. What this module asserts is exactly that layer: `openDatabase` on a path
 * that does not exist yet creates the directory and migrates the file from version 0 to
 * `LATEST_SCHEMA_VERSION`; an already-migrated file is left untouched; a file carrying a version
 * newer than this build is refused rather than misread; the table has the eight documented columns
 * in the documented order with the documented nullability, defaults and types; the two `CHECK`
 * constraints mirroring the domain rules reject a row the domain could never have written; no
 * secondary index was created; and a task inserted through the adapter is still there, field for
 * field, after the handle is closed and the file reopened. That is the storage half of the
 * durability requirement ("it is still present after reloading the page and restarting the
 * backend"), and the evidence for the documented entity-to-table mapping.
 *
 * The file is created by the run's implementation plan (its tree lists this path and its file map
 * gives it the purpose "fresh, current, version-ahead and restart-survival cases"), so the DDL, the
 * pragmas and the version guard it exercises are the ones that ship — nothing here is a copy of
 * them.
 *
 * Two properties keep the suite honest and repeatable. First, every database file it touches comes
 * from `createTempDatabase`, so the developer's `backend/data/todo.db` and the end-to-end suite's
 * `backend/data/e2e.db` are never opened, and `afterEach` removes the whole temporary directory
 * together with the `-wal` and `-shm` sidecars a WAL database writes beside its file. Second, no
 * assertion here reads the wall clock or generates an identifier: every timestamp is a literal ISO
 * string and every identifier is a literal, so a failure names a real disagreement between the
 * schema and its specification rather than a difference between two runs.
 *
 * The raw rows the constraint group writes are deliberately typed as what a column can hold — a
 * `string` priority, a `number` completed flag — rather than as the domain's narrowed types:
 * these tests assert what the table does with input the domain would never produce, and a domain
 * type would make the invalid cases unwritable.
 */
import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '../../src/domain/task.js';
import { openDatabase } from '../../src/infrastructure/database.js';
import { LATEST_SCHEMA_VERSION, applyMigrations } from '../../src/infrastructure/migrations.js';
import { SqliteTaskRepository } from '../../src/infrastructure/SqliteTaskRepository.js';
import { createTempDatabase, type TempDatabase } from '../support/tempDatabase.js';

/**
 * The open handle `openDatabase` returns. Derived from the function rather than named from the
 * driver's own types, because this suite never imports the driver: the handle a test needs is the
 * one the production opener hands back, whatever it is.
 */
type DatabaseHandle = ReturnType<typeof openDatabase>;

/** A temporary database file together with the handle opened on it. */
interface OpenedDatabase {
  /** The open handle carrying the migrated `tasks` table. */
  readonly db: DatabaseHandle;
  /** The temporary directory holding the file; `afterEach` removes it. */
  readonly temp: TempDatabase;
}

/** A `tasks` row as a hand-written `INSERT` supplies it: the column names, at column types. */
interface RawTaskRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly priority: string;
  readonly dueDate: string | null;
  readonly completed: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One column of `PRAGMA table_info(tasks)`, with the driver's column names. */
interface TableColumn {
  /** The column's name, as stored. */
  readonly name: string;
  /** The declared storage type: `TEXT` or `INTEGER` for this schema. */
  readonly type: string;
  /** 1 when the column is declared `NOT NULL`, 0 when it accepts `NULL`. */
  readonly notnull: number;
  /** The declared `DEFAULT` expression, verbatim, or `null` when the column has none. */
  readonly defaultValue: string | null;
  /** 1 for the primary key column, 0 for every other column. */
  readonly pk: number;
}

/** One row of the index query over `sqlite_master`, for a table's indexes. */
interface IndexRow {
  /** The index's name; an automatic primary-key index is named `sqlite_autoindex_`. */
  readonly name: string;
  /** The `CREATE INDEX` statement that made it, or `null` for an automatically created index. */
  readonly sql: string | null;
}

/** The parts of the schema a migration could add to, captured so a no-op can be proved. */
interface SchemaSnapshot {
  /** Every user table in the file, in the order the query returns them. */
  readonly tables: string[];
  /** The names of every index on `tasks`. */
  readonly indexes: string[];
  /** The column names of `tasks`, in order. */
  readonly columns: string[];
}

/** The instant a fixture was created at; a literal, so no fixture reads the wall clock. */
const CREATED_AT = '2026-02-01T09:15:00.000Z';

/** A later literal instant, so a fixture's `updatedAt` is distinguishable from its `createdAt`. */
const UPDATED_AT = '2026-02-02T10:30:00.000Z';

/** The schema version this build's migration list produces; version 1 is the shipped schema. */
const EXPECTED_SCHEMA_VERSION = 1;

const TASKS_TABLE_EXISTS_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'";

const ALL_TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table'";

const TASK_INDEXES_SQL =
  "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'";

const INSERT_RAW_ROW_SQL =
  'INSERT INTO tasks (id, title, description, priority, due_date, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

/** The eight columns of `tasks`, in the order the DDL declares them. */
const EXPECTED_COLUMN_NAMES = [
  'id',
  'title',
  'description',
  'priority',
  'due_date',
  'completed',
  'created_at',
  'updated_at',
];

/**
 * A complete, fully populated task: the fixture both durability tests store and read back.
 *
 * `id` is a literal UUID — the form the create use case generates — so a round-trip assertion
 * compares the entity that was stored with the entity the file returns rather than depending on an
 * identifier generator. `completed` is `true` and `dueDate` is set, so the boolean and the date
 * column are both exercised instead of their empty forms.
 */
const DURABLE_TASK: Task = {
  id: '9c8f5b1e-6f2a-4a1d-9c77-2f0b1d3e4a55',
  title: 'Buy milk',
  description: 'Two litres of semi-skimmed',
  priority: 'high',
  dueDate: '2026-02-14',
  completed: true,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/**
 * A hand-written row that satisfies every constraint, including a due date in the `YYYY-MM-DD`
 * shape the table's `GLOB` check requires. The constraint tests start from this row and change the
 * one value under test, so each failing case differs from a passing one only in that value.
 */
const VALID_RAW_ROW: RawTaskRow = {
  id: 'task-raw-valid',
  title: 'Buy milk',
  description: 'Two litres',
  priority: 'medium',
  dueDate: '2026-02-14',
  completed: 0,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

/**
 * `VALID_RAW_ROW` as the task an adapter reads back from it: the row's column names and the table's
 * `0` completeness flag mapped to the entity's `completed: false`, which is the mapping a raw row
 * has to survive to be a task the product can serve.
 */
const VALID_RAW_TASK: Task = {
  id: VALID_RAW_ROW.id,
  title: VALID_RAW_ROW.title,
  description: VALID_RAW_ROW.description,
  priority: 'medium',
  dueDate: VALID_RAW_ROW.dueDate,
  completed: false,
  createdAt: VALID_RAW_ROW.createdAt,
  updatedAt: VALID_RAW_ROW.updatedAt,
};

/**
 * Every handle this file has opened and not yet released, plus every temporary directory it
 * reserved, so `afterEach` can release them whatever the test did with them.
 */
const trackedHandles: DatabaseHandle[] = [];
const trackedTemps: TempDatabase[] = [];

/**
 * Reserves a temporary directory and opens a migrated database file in it.
 *
 * The directory is tracked before the file is opened, so a directory whose open throws is still
 * removed by the teardown rather than left behind. The database file itself is deliberately not
 * created here: `openDatabase` creates it, which is what lets the fresh-file group observe a first
 * open migrating version 0.
 */
function openTempDatabase(): OpenedDatabase {
  const temp = createTempDatabase('migrations-');
  trackedTemps.push(temp);

  const db = openDatabase(temp.path);
  trackedHandles.push(db);

  return { db, temp };
}

/**
 * Opens the file this run already reserved a second time, tracking the new handle.
 *
 * Used where a test needs to prove something about a file that a previous handle has already
 * written and closed — the version and row survival of a second open, and the durability of a row
 * across a close.
 */
function reopenDatabase(temp: TempDatabase): DatabaseHandle {
  const db = openDatabase(temp.path);
  trackedHandles.push(db);

  return db;
}

/** The message of an unknown thrown value, so one teardown failure cannot mask the others. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Releases every handle and every temporary directory this test opened, then reports.
 *
 * Each release is attempted even when an earlier one fails, and the failures are thrown together at
 * the end, so a test that fails its assertions — or a `CHECK` that throws mid-test — can never leak
 * an open file or a directory holding a `-wal` and a `-shm` sidecar. A handle a test closed itself
 * is skipped rather than closed twice. The directory check comes last because removing a directory
 * an open handle still holds cannot work.
 */
afterEach(() => {
  const handles = trackedHandles.splice(0);
  const temps = trackedTemps.splice(0);
  const failures: string[] = [];

  for (const handle of handles) {
    if (!handle.open) {
      continue;
    }

    try {
      handle.close();
    } catch (error) {
      failures.push(`closing a database handle: ${errorMessage(error)}`);
    }
  }

  for (const temp of temps) {
    try {
      temp.cleanup();
    } catch (error) {
      failures.push(`removing ${temp.directory}: ${errorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`migrations teardown could not release everything: ${failures.join('; ')}`);
  }
});

/** True for a driver value that could be a row, so its columns can be read one by one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Narrows a driver result to an array of rows.
 *
 * `pragma` answers `unknown` and `Statement.all` answers `unknown[]`, so reading either through
 * this guard is what lets the assertions below name columns without a cast.
 */
function toRows(value: unknown, source: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} did not return rows.`);
  }

  const rows: unknown[] = value;

  return rows.map((row) => {
    if (!isRecord(row)) {
      throw new Error(`${source} returned a row that is not an object.`);
    }

    return row;
  });
}

/** Reads a query whose rows carry a `name` column, and returns those names. */
function readNamedRows(db: DatabaseHandle, sql: string): string[] {
  return toRows(db.prepare(sql).all(), sql).map((row) => {
    if (typeof row['name'] !== 'string') {
      throw new Error(`${sql} returned a row without a string name column.`);
    }

    return row['name'];
  });
}

/** Reads the indexes on `tasks` from `sqlite_master`. */
function readIndexRows(db: DatabaseHandle): IndexRow[] {
  return toRows(db.prepare(TASK_INDEXES_SQL).all(), TASK_INDEXES_SQL).map((row) => {
    const name = row['name'];
    const sql = row['sql'];

    if (typeof name !== 'string' || (typeof sql !== 'string' && sql !== null)) {
      throw new Error(`${TASK_INDEXES_SQL} returned a row that is not an index row.`);
    }

    return { name, sql };
  });
}

/**
 * Reads `PRAGMA table_info(tasks)` into one entry per column, in the order the pragma reports them
 * (which is the order the DDL declared them).
 *
 * A column whose flag or name is of an unexpected kind is a failure rather than something to
 * coerce: the assertions that follow are about the table's declared shape, so a schema this suite
 * cannot read must fail loudly instead of quietly skipping a check.
 */
function readTableColumns(db: DatabaseHandle): TableColumn[] {
  const source = 'PRAGMA table_info(tasks)';

  return toRows(db.pragma('table_info(tasks)'), source).map((row) => {
    const name = row['name'];
    const type = row['type'];
    const notnull = row['notnull'];
    const dfltValue = row['dflt_value'];
    const pk = row['pk'];

    if (
      typeof name !== 'string' ||
      typeof type !== 'string' ||
      typeof notnull !== 'number' ||
      (typeof dfltValue !== 'string' && dfltValue !== null) ||
      typeof pk !== 'number'
    ) {
      throw new Error(`${source} returned a row that is not a column description.`);
    }

    return { name, type, notnull, defaultValue: dfltValue, pk };
  });
}

/** Captures the tables, indexes and column names of a file, so a no-op can be compared exactly. */
function snapshotSchema(db: DatabaseHandle): SchemaSnapshot {
  return {
    tables: readNamedRows(db, ALL_TABLES_SQL),
    indexes: readIndexRows(db).map((index) => index.name),
    columns: readTableColumns(db).map((column) => column.name),
  };
}

/**
 * Prepares the raw-row `INSERT` once and returns a function that runs it.
 *
 * Building the statement once per test — rather than per case — is what keeps a failing case a
 * statement execution rather than a compile, so `toThrow` can only be reporting the table's
 * constraint.
 */
function rawRowInserter(db: DatabaseHandle): (row: RawTaskRow) => void {
  const statement = db.prepare(INSERT_RAW_ROW_SQL);

  return (row: RawTaskRow): void => {
    statement.run(
      row.id,
      row.title,
      row.description,
      row.priority,
      row.dueDate,
      row.completed,
      row.createdAt,
      row.updatedAt,
    );
  };
}

/**
 * Reads a task through the adapter and fails loudly when the table does not hold it, so a test can
 * compare fields without a non-null assertion.
 */
async function readStoredTask(db: DatabaseHandle, id: string): Promise<Task> {
  const task = await new SqliteTaskRepository(db).findById(id);

  if (task === null) {
    throw new Error(`expected the tasks table to hold a task with id ${id}`);
  }

  return task;
}

describe('the tasks schema', () => {
  describe('a fresh database file', () => {
    it('creates the directory, the file and the current schema version on a first open', () => {
      const { db, temp } = openTempDatabase();

      expect(existsSync(temp.directory)).toBe(true);
      expect(existsSync(temp.path)).toBe(true);

      // Asserted in both directions on purpose. The first says the file records the version this
      // build produces; the second says that version is still 1, so a future migration cannot make
      // this suite pass by silently raising the very constant it is compared against.
      expect(LATEST_SCHEMA_VERSION).toBe(EXPECTED_SCHEMA_VERSION);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    });

    it('creates the tasks table and no other table', () => {
      const { db } = openTempDatabase();

      expect(readNamedRows(db, TASKS_TABLE_EXISTS_SQL)).toStrictEqual(['tasks']);
      // The whole table list, not just the presence of `tasks`: an extra table a migration added
      // without a version bump would show up here.
      expect(readNamedRows(db, ALL_TABLES_SQL)).toStrictEqual(['tasks']);
    });

    it('leaves the connection in WAL with foreign keys on after migrating the file', () => {
      const { db } = openTempDatabase();

      // Read on the very handle that migrated this fresh file from version 0, so the schema this
      // file holds was created with both settings already in force. `openDatabase` applies them
      // immediately after opening and before `applyMigrations`, and the pragma calls must stay
      // above that migration: creating the schema first would build the table before WAL was in
      // force, so the file would not start out in the journal mode every later connection expects.
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });
  });

  describe('an already-migrated database file', () => {
    it('re-opening it changes neither its version nor its rows', async () => {
      const { db, temp } = openTempDatabase();

      await new SqliteTaskRepository(db).insert(DURABLE_TASK);
      // Read before the handle is closed, because a pragma cannot be read on a closed connection;
      // the same reading is taken again on the reopened handle below, which is what makes the
      // comparison a statement about the file rather than about the first connection.
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      db.close();

      const reopened = reopenDatabase(temp);

      expect(reopened.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(await new SqliteTaskRepository(reopened).findById(DURABLE_TASK.id)).toStrictEqual(
        DURABLE_TASK,
      );
    });

    it('re-applying the migrations to a migrated handle adds no table, index or column', () => {
      const { db } = openTempDatabase();
      const before = snapshotSchema(db);

      // Called directly rather than through a second `openDatabase`, so the no-op is asserted on the
      // same handle that already carries the schema. That it does not throw is itself evidence the
      // `CREATE TABLE` was not run again, because that statement carries no `IF NOT EXISTS`.
      expect(() => applyMigrations(db)).not.toThrow();

      expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(snapshotSchema(db)).toStrictEqual(before);
    });
  });
});


describe('the physical tasks table', () => {
  it('declares exactly the eight documented columns, in order, with their storage types', () => {
    const { db } = openTempDatabase();
    const columns = readTableColumns(db);

    // The count and the sequence together: a renamed column or an added one fails either way.
    expect(columns).toHaveLength(EXPECTED_COLUMN_NAMES.length);
    expect(columns.map((column) => column.name)).toStrictEqual(EXPECTED_COLUMN_NAMES);

    // The declared types, which is what an adapter's row mapping reads against: seven text columns
    // and the completeness flag stored as an integer.
    expect(columns.map((column) => [column.name, column.type])).toStrictEqual([
      ['id', 'TEXT'],
      ['title', 'TEXT'],
      ['description', 'TEXT'],
      ['priority', 'TEXT'],
      ['due_date', 'TEXT'],
      ['completed', 'INTEGER'],
      ['created_at', 'TEXT'],
      ['updated_at', 'TEXT'],
    ]);
  });

  it('marks id alone as the primary key', () => {
    const { db } = openTempDatabase();
    const columns = readTableColumns(db);

    expect(columns.filter((column) => column.pk === 1).map((column) => column.name)).toStrictEqual([
      'id',
    ]);
    expect(columns.map((column) => column.pk)).toStrictEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('declares every column NOT NULL except due_date', () => {
    const { db } = openTempDatabase();
    const columns = readTableColumns(db);
    const nullable = columns
      .filter((column) => column.notnull === 0)
      .map((column) => column.name);

    // Only the due date is optional, so it is the single nullable field of the entity; everything
    // else the entity always carries is NOT NULL, including the description and the priority, which
    // have defaults of their own instead of accepting an absent value.
    expect(nullable).toStrictEqual(['due_date']);
    expect(columns.filter((column) => column.notnull === 1)).toHaveLength(
      EXPECTED_COLUMN_NAMES.length - 1,
    );
  });

  it('declares a default for description, priority and completed, and none for the rest', () => {
    const { db } = openTempDatabase();

    expect(
      readTableColumns(db).map((column) => [column.name, column.defaultValue]),
    ).toStrictEqual([
      ['id', null],
      ['title', null],
      ['description', "''"],
      ['priority', "'medium'"],
      ['due_date', null],
      ['completed', '0'],
      ['created_at', null],
      ['updated_at', null],
    ]);
  });
});


describe('the constraints on the tasks table', () => {
  it('accepts a hand-written row that satisfies every constraint', async () => {
    const { db } = openTempDatabase();
    const insertRow = rawRowInserter(db);

    expect(() => {
      insertRow(VALID_RAW_ROW);
    }).not.toThrow();

    // Read back through the adapter rather than counted in SQL, so the row is shown to be a task the
    // product can serve — the 0 flag mapped to the boolean, the description and the due date as
    // stored — and not merely a row SQLite accepted.
    expect(await readStoredTask(db, VALID_RAW_ROW.id)).toStrictEqual(VALID_RAW_TASK);
  });

  it('rejects a priority outside the three levels', () => {
    const { db } = openTempDatabase();
    const insertRow = rawRowInserter(db);

    // Only SQLite's stable fragment is matched, never the driver's full message: the assertion is
    // that the table's CHECK refused the row, not how the wording of a failure reads.
    expect(() => {
      insertRow({ ...VALID_RAW_ROW, id: 'task-raw-urgent', priority: 'urgent' });
    }).toThrow(/CHECK/);
  });

  // The shape check is a whole-string `GLOB`, so the third case is the one that would slip through a
  // prefix match: a real date carrying a time is still not a `YYYY-MM-DD` date.
  it.each(['14-02-2026', '2026-2-4', '2026-02-14T09:15:00.000Z'])(
    'rejects the due date %s, which is not a YYYY-MM-DD date',
    (dueDate) => {
      const { db } = openTempDatabase();
      const insertRow = rawRowInserter(db);

      expect(() => {
        insertRow({ ...VALID_RAW_ROW, dueDate });
      }).toThrow(/CHECK/);
    },
  );

  it.each([0, 1])('accepts the completeness flag %i', (completed) => {
    const { db } = openTempDatabase();
    const insertRow = rawRowInserter(db);

    expect(() => {
      insertRow({ ...VALID_RAW_ROW, completed });
    }).not.toThrow();
  });

  it('rejects a completeness flag outside 0 and 1', () => {
    const { db } = openTempDatabase();
    const insertRow = rawRowInserter(db);

    expect(() => {
      insertRow({ ...VALID_RAW_ROW, id: 'task-raw-completed-2', completed: 2 });
    }).toThrow(/CHECK/);
  });

  it('accepts a NULL due date, which is how a task carries none', async () => {
    const { db } = openTempDatabase();
    const insertRow = rawRowInserter(db);

    // The constraint is `due_date IS NULL OR …`, so a task with no due date is a stored fact rather
    // than an absent column, and the adapter reads it back as `null` and never as an empty string.
    expect(() => {
      insertRow({ ...VALID_RAW_ROW, id: 'task-raw-undated', dueDate: null });
    }).not.toThrow();

    expect((await readStoredTask(db, 'task-raw-undated')).dueDate).toBeNull();
  });
});

describe('the indexes on the tasks table', () => {
  it('creates no index beyond the one the primary key needs', () => {
    const { db } = openTempDatabase();
    const indexes = readIndexRows(db);

    // Every index on the table was created automatically for the primary key — its name carries
    // SQLite's automatic prefix and it has no `CREATE INDEX` statement of its own — so a
    // hand-written index added later fails right here, whichever column it names.
    //
    // That is the schema's deliberate decision rather than an omission: every read is one scan of a
    // table this product caps at 1,000 rows, filtering and sorting run in memory in the application
    // layer, and no query the product makes would use an index on completed, priority, due_date or
    // created_at. The primary key on id is the only index this table needs.
    expect(indexes.filter((index) => !index.name.startsWith('sqlite_autoindex_'))).toStrictEqual([]);
    expect(indexes.filter((index) => index.sql !== null)).toStrictEqual([]);
  });
});

describe('a database file newer than this build', () => {
  it('refuses to migrate it and leaves its schema and its rows untouched', async () => {
    const { db } = openTempDatabase();
    const insertRow = rawRowInserter(db);
    insertRow(VALID_RAW_ROW);

    const columnsBefore = readTableColumns(db).map((column) => column.name);

    db.pragma('user_version = 999');

    // `applyMigrations` is called directly instead of reopening the file through `openDatabase`,
    // because the opener would throw while opening and the assertion could no longer say which
    // version was refused. The message names the file's version, so an operator reading a startup
    // failure learns the file is ahead of the binary rather than that it is corrupt.
    expect(() => applyMigrations(db)).toThrow(/999/);

    // The refusal is decided before anything is applied, so the file keeps the schema, the rows and
    // the recorded version the newer file wrote.
    expect(readNamedRows(db, TASKS_TABLE_EXISTS_SQL)).toStrictEqual(['tasks']);
    expect(readTableColumns(db).map((column) => column.name)).toStrictEqual(columnsBefore);
    expect(db.pragma('user_version', { simple: true })).toBe(999);
    expect(await readStoredTask(db, VALID_RAW_ROW.id)).toStrictEqual(VALID_RAW_TASK);
  });
});

describe('durability across a close and a reopen', () => {
  it('reads a stored task back field for field once the file is reopened', async () => {
    const { db, temp } = openTempDatabase();

    await new SqliteTaskRepository(db).insert(DURABLE_TASK);
    db.close();

    // The on-disk half of the durability claim: the file the first handle wrote is still there, and
    // a second handle opens it without a migration changing anything.
    expect(existsSync(temp.path)).toBe(true);

    const reopened = reopenDatabase(temp);
    const stored = await readStoredTask(reopened, DURABLE_TASK.id);

    expect(stored).toStrictEqual(DURABLE_TASK);
    // The two crossings the table's own types make: the integer flag comes back as a boolean and the
    // date as the string that was stored.
    expect(stored.completed).toBe(true);
    expect(stored.dueDate).toBe('2026-02-14');

    // The directory holds the database file together with the `-wal` and `-shm` sidecars a WAL
    // database writes beside it; removing the directory removes all three, so nothing is left for
    // the rest of the run to trip over. The handle is closed first, and the teardown's second
    // cleanup call is the idempotent no-op `cleanup()` promises to be.
    reopened.close();
    temp.cleanup();

    expect(existsSync(temp.directory)).toBe(false);
  });
});

