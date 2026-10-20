/**
 * Integration suite for the product's first-list-load budget: 1,000 stored tasks served by one
 * list request, and the same budget applied to the listing route's filtered and sorted path.
 *
 * What is being measured, and where. The requirement is that the first list load renders in under
 * one second with up to 1,000 tasks on a development machine, and that obligation is discharged on
 * this exact path: the HTTP listing route, the `ListTasks` use case, the `SqliteTaskRepository`
 * adapter and the SQLite file. The request is delivered in-process through `app.inject()`, so no
 * socket, no browser and no process startup sits inside the measured window, and each measured
 * section below holds exactly one `inject()` call between one `performance.now()` pair — the
 * recorded value is the cost of a single list request, never of a loop or an average.
 *
 * The design under test, and therefore what a failure here means. Listing is one `SELECT` through
 * `TaskRepository.findAll()` followed by one in-memory filter and one in-memory sort in
 * `ListTasks`/`taskQuery.ts`, over five statements prepared once when the adapter is constructed.
 * If the elapsed time ever exceeds the budget, the fix is that design rather than the bound: a
 * query per task, a re-query inside the sort, or a per-row read on the way out is precisely the
 * shape of change this suite exists to catch.
 *
 * Seeding is deliberately outside the measured window. The requirement is about the cost of a list
 * request, not about the cost of loading a fixture, so the 1,000 rows are written in `beforeAll`
 * and the seed is asserted complete there — before anything is timed, so a short fixture can never
 * let the budget assertion pass vacuously.
 *
 * Determinism. Every seeded identifier, timestamp, priority, completion flag and due date is
 * derived from the row's index by a pure function declared in this file; nothing here reads the
 * wall clock or generates a value the assertions cannot name in advance, so the orders asserted
 * below are reproducible. The database file comes from `../support/tempDatabase.ts` and lives in a
 * temporary directory the teardown removes together with its `-wal`/`-shm` sidecars, so the
 * developer's `backend/data/todo.db` and the end-to-end suite's database are never touched.
 *
 * The graph is wired here rather than through `src/main.ts`, so the measurement is never entangled
 * with process startup, and the six use cases are constructed over the real SQLite adapter and the
 * production clock. `buildApp` is imported for the instance that is injected into; this suite must
 * keep this file free of a listening server and of a direct `better-sqlite3` import.
 */
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTempDatabase, type TempDatabase } from '../support/tempDatabase.js';
import type { TaskRepository } from '../../src/application/TaskRepository.js';
import { CreateTask } from '../../src/application/CreateTask.js';
import { DeleteTask } from '../../src/application/DeleteTask.js';
import { GetTask } from '../../src/application/GetTask.js';
import { ListTasks } from '../../src/application/ListTasks.js';
import { ToggleTaskCompletion } from '../../src/application/ToggleTaskCompletion.js';
import { UpdateTask } from '../../src/application/UpdateTask.js';
import type { Task, TaskPriority } from '../../src/domain/task.js';
import { openDatabase } from '../../src/infrastructure/database.js';
import { SqliteTaskRepository } from '../../src/infrastructure/SqliteTaskRepository.js';
import { systemClock } from '../../src/infrastructure/systemClock.js';
import { buildApp } from '../../src/interface/http/buildApp.js';

/**
 * The open handle `openDatabase` returns, derived from the production opener rather than named
 * from the driver's own types: this suite never imports the driver, so the handle it holds is
 * whatever the opener it runs against hands back.
 */
type DatabaseHandle = ReturnType<typeof openDatabase>;

/** The composed application, derived from the factory, so the type is the product's own. */
type FastifyApp = ReturnType<typeof buildApp>;

/**
 * The parts of an injected response this suite reads.
 *
 * Declared structurally rather than imported, because a test that asserted against the framework's
 * own response type would be reaching outside the modules the suite is allowed to consume; an
 * injected response satisfies this shape.
 */
interface InjectedResponse {
  /** The status the route answered with; 200 wherever a listing succeeds. */
  readonly statusCode: number;
  /** The response headers, as the framework's own type supplies them. */
  readonly headers: { readonly [name: string]: number | string | string[] | undefined };
  /** The response body, parsed as JSON. */
  json(): unknown;
}

/**
 * The ceiling the list-load requirement names: the budget below is the cost of serving this many
 * tasks in one list request.
 *
 * The assertions in this suite name this count rather than the fixture's own scale, so a fixture
 * that seeded fewer rows fails them instead of quietly measuring a smaller list.
 */
const REQUIRED_TASK_COUNT = 1000;

/**
 * How many tasks the fixture seeds: the requirement's ceiling, so the measurement covers the
 * largest list the product promises to serve.
 *
 * Reduced on its own — which is how this suite's vacuity was checked — the count assertions below
 * fail, because they are tied to the requirement and not to this fixture's scale.
 */
const SEED_SIZE = REQUIRED_TASK_COUNT;

/** Width of the numeric part of a seeded identifier, so every id has one length and sorts in order. */
const ID_DIGITS = 4;

/** The budget itself: the sub-second first-list-load requirement, in milliseconds. */
const LIST_BUDGET_MILLISECONDS = 1000;

/**
 * The explicit per-test and per-hook timeout, restating the suite-wide 30 seconds: seeding 1,000
 * rows and serving three list requests must finish well inside it, and naming it here means the
 * bound does not silently depend on the workspace configuration.
 */
const TIMEOUT_MILLISECONDS = 30_000;

/** The fixed instant seeded timestamps are derived from; a literal, never the wall clock. */
const CREATED_AT_BASE = Date.parse('2026-01-01T00:00:00.000Z');

/** The fixed day the earliest seeded due date falls on; whole days are added to it per index. */
const DUE_DATE_BASE = Date.parse('2026-03-01T00:00:00.000Z');

const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_DAY = 86_400_000;

/** How many priority levels are cycled, so each level covers the same share of the fixture. */
const PRIORITY_CYCLE = 3;

/**
 * Completion cycle: two indices in every seven are seeded complete. That is roughly a third of the
 * rows, and because seven and three are coprime it cuts across all three priority levels instead
 * of coinciding with them — so the status filter and the priority filter each have real work to do
 * on the filtered request below rather than one of them being a no-op.
 */
const COMPLETED_CYCLE = 7;
const COMPLETED_PER_CYCLE = 2;

/**
 * Undated cycle: the fourth index in every five is seeded without a due date, so about a fifth of
 * the rows are undated and the due-date sort has a meaningful run of them to place last.
 */
const UNDATED_CYCLE = 5;
const UNDATED_POSITION_IN_CYCLE = 4;

/**
 * The identifier of the seeded task at `index`: zero-padded to a fixed width, so the identifiers
 * sort in index order and a task can be named in an assertion without a lookup.
 */
function seededId(index: number): string {
  return `task-${String(index).padStart(ID_DIGITS, '0')}`;
}

/**
 * The priority of the seeded task at `index`: the three levels cycled in order, so exactly a third
 * of the rows carry each level and no level is a corner case of the filter.
 */
function seededPriority(index: number): TaskPriority {
  const position = index % PRIORITY_CYCLE;

  if (position === 0) {
    return 'low';
  }

  return position === 1 ? 'medium' : 'high';
}

/** Whether the seeded task at `index` is complete; see {@link COMPLETED_CYCLE}. */
function isSeededCompleted(index: number): boolean {
  return index % COMPLETED_CYCLE < COMPLETED_PER_CYCLE;
}

/**
 * The due date of the seeded task at `index`: a real `YYYY-MM-DD` calendar date one day after the
 * previous index's, or `null` for one index in five; see {@link UNDATED_CYCLE}.
 *
 * The base is midnight UTC and whole days are added, so the ISO string's date half is the date
 * intended rather than a shifted one — which matters because the table's `CHECK` constraint
 * accepts nothing but the digits of a `YYYY-MM-DD` date.
 */
function seededDueDate(index: number): string | null {
  if (index % UNDATED_CYCLE === UNDATED_POSITION_IN_CYCLE) {
    return null;
  }

  return new Date(DUE_DATE_BASE + index * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The timestamp of the seeded task at `index`, used for both `createdAt` and `updatedAt` because a
 * seeded task has never been updated.
 *
 * Successive indices are one minute apart from a fixed base, so the creation-time order is the
 * index order and the newest task is the last one seeded — a fact the `createdAt` assertion below
 * names without depending on the machine's clock.
 */
function seededTimestamp(index: number): string {
  return new Date(CREATED_AT_BASE + index * MILLISECONDS_PER_MINUTE).toISOString();
}

/**
 * Builds the fixture: one complete task per index, every field derived from that index by the pure
 * functions above.
 *
 * Title and description are short, non-empty and distinct per row, so the response payloads are of
 * a realistic size rather than of 1,000 identical objects.
 */
function buildSeed(): Task[] {
  const tasks: Task[] = [];

  for (let index = 0; index < SEED_SIZE; index += 1) {
    tasks.push({
      id: seededId(index),
      title: `Seeded task ${index}`,
      description: `Seeded description ${index}`,
      priority: seededPriority(index),
      dueDate: seededDueDate(index),
      completed: isSeededCompleted(index),
      createdAt: seededTimestamp(index),
      updatedAt: seededTimestamp(index),
    });
  }

  return tasks;
}

/** True for a JSON object, so a response element can be read field by field without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for the three priority names the entity and the table both accept. */
function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 'low' || value === 'medium' || value === 'high';
}

/**
 * Narrows one element of a list response to the entity the API promises: all eight fields present
 * and of their own kind, with `dueDate` a date string or `null` and `completed` a real boolean.
 *
 * A response that failed this would be a contract breach rather than a slow list, so it is worth
 * the assertion: it is what stops a 200 whose body is an error envelope from being counted as a
 * served list.
 */
function isTask(value: unknown): value is Task {
  if (!isRecord(value)) {
    return false;
  }

  const { id, title, description, priority, dueDate, completed, createdAt, updatedAt } = value;

  return (
    typeof id === 'string' &&
    typeof title === 'string' &&
    typeof description === 'string' &&
    isTaskPriority(priority) &&
    (dueDate === null || typeof dueDate === 'string') &&
    typeof completed === 'boolean' &&
    typeof createdAt === 'string' &&
    typeof updatedAt === 'string'
  );
}

/**
 * Reads a parsed list response body as the tasks it holds, naming the offending element when the
 * body is not the bare array of complete task objects the listing contract returns.
 *
 * @throws Error when the body is not an array, or when an element is not a complete task.
 */
function tasksFrom(body: unknown): Task[] {
  if (!Array.isArray(body)) {
    throw new Error('A list response did not carry a JSON array.');
  }

  const entries: readonly unknown[] = body;

  return entries.map((entry, index) => {
    if (!isTask(entry)) {
      throw new Error(`The task at index ${index} of a list response is not a complete task.`);
    }

    return entry;
  });
}

/** The identifiers of `tasks`, sorted, so two lists can be compared as sets rather than by order. */
function sortedIds(tasks: readonly Task[]): string[] {
  return tasks.map((task) => task.id).sort();
}

/**
 * The value of a response header, or the empty string when the header carries no single value.
 *
 * The framework's header type allows a number and an array as well as a string; a media type is
 * always one string, and the empty fallback keeps the assertion's failure message about the header
 * rather than about how it was read.
 */
function headerValue(response: InjectedResponse, name: string): string {
  const value = response.headers[name];

  return typeof value === 'string' ? value : '';
}

/** The temporary directory holding this suite's database file; the teardown removes it. */
let temp: TempDatabase | undefined;

/** The open handle over that file; the teardown closes it after the application is closed. */
let database: DatabaseHandle | undefined;

/** The composed application every measured request is injected into. */
let app: FastifyApp | undefined;

/** The seeded tasks, kept so the expectations can name what the store holds. */
let seed: readonly Task[] = [];

/** The seeded tasks by identifier, for the assertions that name one task exactly. */
let seededById: ReadonlyMap<string, Task> = new Map();

/**
 * The composed application, or a failure that names the setup step.
 *
 * `beforeAll` assigns it; the guard exists so a setup that failed part-way reports that as the
 * reason a test could not run, rather than a `undefined` dereference.
 *
 * @throws Error when the setup hook did not compose the application.
 */
function requireApp(): FastifyApp {
  if (app === undefined) {
    throw new Error('The application under test was not composed: the setup hook did not finish.');
  }

  return app;
}

/**
 * The seeded task holding this identifier.
 *
 * @throws Error when the seed holds no such task, which would make an assertion below meaningless.
 */
function requireSeededTask(id: string): Task {
  const task = seededById.get(id);

  if (task === undefined) {
    throw new Error(`The seed holds no task with id ${id}.`);
  }

  return task;
}

/**
 * Composes the graph and seeds the fixture, both outside the measured window.
 *
 * The order is deliberate: the seed is built first so that a failure to open the database still
 * leaves nothing half-seeded, the file is reserved and opened through the production opener — which
 * creates the directory, applies WAL and runs the migration — and the adapter is built on that
 * handle. The six use cases are then constructed over the adapter and the production clock, because
 * `buildApp` takes the whole dependency object even though only the listing use case is on the
 * measured path.
 */
beforeAll(async () => {
  seed = buildSeed();
  seededById = new Map(seed.map((task) => [task.id, task]));

  const reserved = createTempDatabase('list-performance-');
  temp = reserved;

  const handle = openDatabase(reserved.path);
  database = handle;

  const repository: TaskRepository = new SqliteTaskRepository(handle);

  app = buildApp(
    {
      createTask: new CreateTask({ repository, clock: systemClock }),
      updateTask: new UpdateTask({ repository, clock: systemClock }),
      deleteTask: new DeleteTask({ repository }),
      toggleTaskCompletion: new ToggleTaskCompletion({ repository, clock: systemClock }),
      getTask: new GetTask({ repository }),
      listTasks: new ListTasks({ repository }),
    },
    // `silent` keeps the runner's output readable and keeps logging off the measured path.
    { logLevel: 'silent' },
  );

  // The rows go in through the adapter rather than by raw SQL, so what is stored is what the
  // product itself would store and the reading side of the round trip is what the requests below
  // exercise. The loop is sequential and awaited on purpose: the driver is synchronous behind the
  // promise-returning port, so concurrency could not help and would only cost determinism.
  for (const task of seed) {
    await repository.insert(task);
  }

  // Asserted here, before anything is timed, so a fixture that seeded fewer rows cannot let the
  // budget assertions below pass vacuously: the store must hold the requirement's full count.
  expect((await repository.findAll()).length).toBe(REQUIRED_TASK_COUNT);
}, TIMEOUT_MILLISECONDS);

/**
 * Releases every resource the suite owns, in dependency order: the application first, so nothing
 * can still be serving from the handle, then the database handle, then the directory holding the
 * file and its SQLite sidecars.
 *
 * Each step is attempted even when an earlier one fails, and the failures are thrown together at
 * the end, so a failing assertion can never leave a file open or a `-wal`/`-shm` sidecar behind.
 * A resource that was never created is skipped rather than dereferenced.
 */
afterAll(async () => {
  const failures: unknown[] = [];

  if (app !== undefined) {
    try {
      await app.close();
    } catch (error) {
      failures.push(error);
    } finally {
      app = undefined;
    }
  }

  if (database !== undefined) {
    try {
      database.close();
    } catch (error) {
      failures.push(error);
    } finally {
      database = undefined;
    }
  }

  if (temp !== undefined) {
    try {
      temp.cleanup();
    } catch (error) {
      failures.push(error);
    } finally {
      temp = undefined;
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Releasing the list-performance resources failed.');
  }
}, TIMEOUT_MILLISECONDS);

describe('GET /api/tasks inside the first-list-load budget at 1,000 tasks', () => {
  it(
    'serves the whole list of 1,000 tasks in under a second',
    async () => {
      const application = requireApp();

      // One request inside one timing pair: the elapsed value is a single list request, not a loop
      // and not an average, which is what makes it comparable with the requirement's budget.
      const started = performance.now();
      const response = await application.inject({ method: 'GET', url: '/api/tasks' });
      const elapsed = performance.now() - started;

      expect(response.statusCode).toBe(200);

      // A 200 alone would also be given by an error-shaped body, so the media type is asserted here
      // and the task shape below.
      expect(headerValue(response, 'content-type')).toContain('application/json');

      const body: unknown = response.json();
      expect(Array.isArray(body)).toBe(true);

      const tasks = tasksFrom(body);
      expect(tasks).toHaveLength(REQUIRED_TASK_COUNT);

      // Exactly what is stored, compared as a set of identifiers: a dropped, duplicated or invented
      // row fails here rather than quietly shortening the list the budget was measured over.
      expect(sortedIds(tasks)).toStrictEqual(sortedIds(seed));

      // The default order is by creation time, most recently created first, and deep equality means
      // the row carries all eight fields as they were seeded.
      expect(tasks[0]).toStrictEqual(requireSeededTask(seededId(SEED_SIZE - 1)));

      // The budget itself: first list load under one second with 1,000 tasks. If this fails, the
      // answer is the design — one listing query, one in-memory filter, one in-memory sort and five
      // statements prepared once — and not this bound.
      expect(
        elapsed,
        `listing ${REQUIRED_TASK_COUNT} tasks took ${elapsed.toFixed(1)} ms`,
      ).toBeLessThan(LIST_BUDGET_MILLISECONDS);
    },
    TIMEOUT_MILLISECONDS,
  );

  it(
    'serves the filtered, due-date-sorted list inside the same budget',
    async () => {
      const application = requireApp();

      // The path where an in-memory filter and sort would show their cost if the one-query design
      // were wrong, measured the same way: one request inside one timing pair.
      const started = performance.now();
      const response = await application.inject({
        method: 'GET',
        url: '/api/tasks?status=open&priority=high&sort=dueDate',
      });
      const elapsed = performance.now() - started;

      expect(response.statusCode).toBe(200);

      const tasks = tasksFrom(response.json());

      // The filter really filtered: open high-priority tasks are a minority of the fixture.
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.length).toBeLessThan(REQUIRED_TASK_COUNT);

      // And it selected exactly the seeded rows that satisfy it — every row matches, and the set of
      // identifiers is the whole matching set and nothing else.
      const expected = seed.filter((task) => !task.completed && task.priority === 'high');

      expect(tasks.every((task) => task.completed === false)).toBe(true);
      expect(tasks.every((task) => task.priority === 'high')).toBe(true);
      expect(sortedIds(tasks)).toStrictEqual(sortedIds(expected));

      // The order the request asked for: earliest due date first, with every undated task after
      // every dated one. Comparing the dated values against a sorted copy of themselves catches a
      // misordered pair, and comparing the response's own prefix against those values catches a
      // `null` that was allowed to appear among them.
      const dueDates = tasks.map((task) => task.dueDate);
      const dated = dueDates.filter((dueDate): dueDate is string => dueDate !== null);

      expect(dated).toStrictEqual([...dated].sort());
      expect(dueDates.slice(0, dated.length)).toStrictEqual(dated);
      expect(dueDates.slice(dated.length).every((dueDate) => dueDate === null)).toBe(true);

      expect(elapsed, `filtering and sorting took ${elapsed.toFixed(1)} ms`).toBeLessThan(
        LIST_BUDGET_MILLISECONDS,
      );
    },
    TIMEOUT_MILLISECONDS,
  );

  it(
    'orders the whole list by creation time, most recently created first',
    async () => {
      const application = requireApp();

      // A second ordering of the same route, timed the same way, so the measured route is exercised
      // beyond the default and the due-date sort.
      const started = performance.now();
      const response = await application.inject({
        method: 'GET',
        url: '/api/tasks?sort=createdAt',
      });
      const elapsed = performance.now() - started;

      expect(response.statusCode).toBe(200);

      const tasks = tasksFrom(response.json());
      expect(tasks).toHaveLength(REQUIRED_TASK_COUNT);

      // The first row is the stored task with the latest `createdAt`, compared in full: this names
      // the newest seeded task rather than whichever ordering the response happened to produce.
      expect(tasks[0]).toStrictEqual(requireSeededTask(seededId(SEED_SIZE - 1)));

      // And the ordering holds end to end, not just at the front: the sequence of timestamps equals
      // itself sorted descending. Every seeded timestamp is distinct, so the comparison is exact.
      const timestamps = tasks.map((task) => task.createdAt);
      expect(timestamps).toStrictEqual([...timestamps].sort().reverse());

      expect(elapsed, `listing by creation time took ${elapsed.toFixed(1)} ms`).toBeLessThan(
        LIST_BUDGET_MILLISECONDS,
      );
    },
    TIMEOUT_MILLISECONDS,
  );
});
