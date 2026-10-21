/**
 * Integration suite for the `TaskRepository` port: the shared conformance suite run against both
 * implementations, plus the one durability assertion a store-agnostic suite cannot express.
 *
 * The suite itself lives in `../contract/taskRepositoryContract.ts` and registers nothing on
 * import — its name carries no `.test` suffix, so the runner never collects it — which is why this
 * file is the only thing that runs it, and why it runs it twice. The shipped SQLite adapter and the
 * in-memory substitute are therefore held to the identical assertions here and neither can drift
 * away from the other. That is the automated evidence for the replaceable-storage criterion: the
 * store is changed by wiring alone, because each implementation is driven through the port and no
 * `src/domain` or `src/application` module takes part in either run.
 *
 * The SQLite run opens a real database file — a `.db` inside a directory reserved per test by
 * `../support/tempDatabase.ts`, never the developer's `backend/data/todo.db` and never the
 * end-to-end suite's database — and releases the handle and the directory after each test, so
 * neither the file nor a `-wal`/`-shm` sidecar survives the suite. The in-memory run holds a `Map`
 * and owns no resource at all.
 *
 * The second `describe` block below covers what the shared suite deliberately leaves out, because
 * it is about a file rather than about the port: a row written through the adapter is still there,
 * with every field's own kind intact, once the connection that wrote it has been closed and the
 * file reopened. The restart half of the same requirement — a task outliving a stopped and
 * restarted process — belongs to `restart.test.ts`.
 */
import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { describeTaskRepositoryContract } from '../contract/taskRepositoryContract.js';
import { InMemoryTaskRepository } from '../support/inMemoryTaskRepository.js';
import { createTempDatabase } from '../support/tempDatabase.js';
import type { TaskRepository } from '../../src/application/TaskRepository.js';
import type { Task } from '../../src/domain/task.js';
import { openDatabase } from '../../src/infrastructure/database.js';
import { SqliteTaskRepository } from '../../src/infrastructure/SqliteTaskRepository.js';

/**
 * What a factory hands the suite: the store to drive — through the application's port and never as
 * its concrete type — plus the release step for a store that owns a resource. Structurally the
 * contract's own `createRepository` result, so a factory declared with it is accepted unchanged,
 * and the two calls at the bottom of this file are what hold it to that.
 */
interface RepositoryUnderTest {
  repository: TaskRepository;
  cleanup?: () => Promise<void> | void;
}

/**
 * A complete task with every field literal: what the reopen test writes and reads back. Nothing
 * here is generated, so the assertion after the file round trip compares two known values rather
 * than two values a clock or an identifier generator happened to produce.
 */
const STORED_TASK: Task = {
  id: '3f1c9a7e-2d4b-4f6a-8b1c-5e0d7a9c2b34',
  title: 'Buy milk',
  description: 'Two litres, semi-skimmed',
  priority: 'high',
  dueDate: '2026-02-14',
  completed: true,
  createdAt: '2026-02-01T09:15:00.000Z',
  updatedAt: '2026-02-02T10:30:00.000Z',
};

/**
 * The release step of every resource a test opened. The contract releases the store its factory
 * returned, in its own `afterEach`; this array is the safety net for a test that fails before that
 * runs, and for the directory the reopen test reserves by hand. It is emptied on every iteration,
 * so no handle outlives the test that opened it.
 *
 * Each step is idempotent by construction, because both this file and the contract release the same
 * resource for one test: `better-sqlite3` throws when an already-closed connection is closed again,
 * and `TempDatabase.cleanup()` is documented as safe to call more than once.
 */
const disposers: Array<() => void> = [];

afterEach(() => {
  const pending = disposers.splice(0);
  const failures: unknown[] = [];

  for (const dispose of pending) {
    try {
      dispose();
    } catch (error) {
      failures.push(error);
    }
  }

  // Every step is attempted before anything is raised, so a directory that cannot be removed cannot
  // hide a handle that cannot be closed; the failures are reported together rather than dropped.
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Releasing a temporary database failed.');
  }
});

/**
 * Reserves a temporary database file, opens it through the production entry point — so the store
 * runs against the real schema, the real pragmas and the real migration — and returns the adapter
 * over it together with the step that releases both.
 *
 * The database is on a temporary path and never the developer's `backend/data/todo.db`: each call
 * reserves its own directory, so a test starts from an empty store and the file is removed when the
 * test ends.
 */
async function createSqliteRepository(): Promise<RepositoryUnderTest> {
  const temp = createTempDatabase('task-repository-');

  // The handle is held out of reach until it is open, so that `dispose` also covers the window in
  // which the directory exists but the file is not yet open: an open that failed would otherwise
  // leave the directory behind.
  let handle: ReturnType<typeof openDatabase> | undefined;

  const dispose = (): void => {
    if (handle !== undefined) {
      // Taking the handle away before closing it is what makes the close happen exactly once: the
      // driver throws on a closed connection, and this file's `afterEach` reaches the same store the
      // contract already released.
      const closing = handle;
      handle = undefined;
      closing.close();
    }

    temp.cleanup();
  };

  disposers.push(dispose);

  handle = openDatabase(temp.path);

  return { repository: new SqliteTaskRepository(handle), cleanup: dispose };
}

/**
 * Hands back the in-memory substitute, which owns no file and therefore nothing to release.
 *
 * Running the same assertions against it is the point rather than convenience: an implementation
 * that satisfied the port in its own way, or that drifted from the adapter, fails here even though
 * the shipped store still passes.
 */
async function createInMemoryRepository(): Promise<RepositoryUnderTest> {
  return { repository: new InMemoryTaskRepository() };
}

// Both implementations run the identical suite. Both calls sit at module top level, outside any
// `describe` of this file, so the suite module registers its own two blocks — one per
// implementation — and neither is nested inside a block that could re-register it.
describeTaskRepositoryContract({
  name: 'SqliteTaskRepository (temporary file)',
  createRepository: createSqliteRepository,
});

describeTaskRepositoryContract({
  name: 'InMemoryTaskRepository',
  createRepository: createInMemoryRepository,
});

describe('SqliteTaskRepository persistence across close and reopen', () => {
  it('reads a task back with every field intact after the file is closed and reopened', async () => {
    const temp = createTempDatabase('task-repository-reopen-');

    // Tracked before the first open, so that no assertion failure below can leave the directory or
    // its SQLite sidecars behind.
    disposers.push(() => {
      temp.cleanup();
    });

    const first = openDatabase(temp.path);

    try {
      await new SqliteTaskRepository(first).insert(STORED_TASK);
    } finally {
      first.close();
    }

    expect(existsSync(temp.path)).toBe(true);

    // A file already at the current `user_version` re-runs the migrations as a no-op, so the second
    // open must not throw: a throw here would mean the migration runner is not idempotent.
    let reopened: ReturnType<typeof openDatabase> | undefined;

    expect(() => {
      reopened = openDatabase(temp.path);
    }).not.toThrow();

    const second = reopened;

    if (second === undefined) {
      throw new Error('Reopening the database file returned no handle.');
    }

    try {
      // Deep equality over all eight fields is what this asserts: `completed` comes back a boolean
      // rather than the table's 0/1 integer, `dueDate` the date string rather than `''` or
      // undefined, and `priority` still one of the three levels — none of which a shared suite can
      // check, because it would have to name a file and a column to do it.
      expect(await new SqliteTaskRepository(second).findById(STORED_TASK.id)).toStrictEqual(
        STORED_TASK,
      );
    } finally {
      second.close();
    }
  });
});
