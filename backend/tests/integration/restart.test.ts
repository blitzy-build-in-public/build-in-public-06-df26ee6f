/**
 * The real API process driven across a process boundary: restarted against one database file, and
 * started once so its startup output can be read. That is the restart half of the requirement that a
 * task "is still present after reloading the page and restarting the backend", and the half of "The
 * API logs at startup once" that only a spawned process can show.
 *
 * What this suite adds that no other one can. The repository contract, the migration suite and the
 * route suites all reach the database through a port or a handle they open themselves, and they
 * show that the file survives a close and a reopen inside one process. This suite shows that the
 * product survives a restart: a task created over HTTP while one process is serving is read back
 * over HTTP from a second process started afterwards, on a different port, against the same
 * `DATABASE_PATH`. A handle the first process never released, a schema created only in memory, a
 * path resolved against something that moved, or a migration the second open skipped would each
 * fail here and pass everywhere else.
 *
 * The process boundary is the point rather than a means. `src/main.ts` starts its server only when
 * the process was launched with that file as its entry point — its `main()` call is guarded on
 * `import.meta.url` — so importing it would bind nothing at all; this suite therefore spawns it and
 * drives the published HTTP contract over loopback, exactly as the end-to-end suite does.
 *
 * The child runs the TypeScript entry point through Node's `--import` flag with the `tsx` loader
 * that `backend/package.json` pins for that role, so no build step is needed and no `dist` output
 * can be stale. Node resolves the bare `tsx` specifier by walking up from the child's working
 * directory, which is why the hoisted `node_modules/tsx` at the repository root satisfies it: the
 * `backend/node_modules/.bin/tsx` shim does not exist in this checkout, while
 * `node --import tsx src/main.ts` from `backend/` does start the server — so no CLI fallback is
 * used here.
 *
 * The startup-output case is the suite's other half. Every other suite composes the application
 * in-process and drives it through `app.inject()`, which never binds a socket and therefore never
 * runs the code path that produced the second record the case guards against: a record written by
 * the HTTP framework's own `listen`, beside the application's own line. Counting the records of a
 * real start is the only way to observe how many there are, and the framework's banner carries the
 * same address as the application's line, so it duplicates an answer without adding one — exactly
 * the deviation the startup line is supposed to avoid. That case starts its child at `LOG_LEVEL`
 * `info` rather than the `silent` the restart case passes, because the record under test is written
 * at `info`; nothing in either case asserts on a timestamp.
 *
 * Isolation and determinism. Every database file comes from `createTempDatabase`, so the
 * developer's `backend/data/todo.db` and the end-to-end suite's file are never opened; each process
 * is handed an absolute path inside one of those temporary directories, and the teardown removes
 * the whole directory with the `-wal`/`-shm` sidecars SQLite writes beside the file. No assertion
 * reads the wall clock: the task's eight fields are compared against the very body the first
 * process returned, so the comparison is between two observations of the API rather than between a
 * value and a timestamp this machine happened to produce.
 *
 * Teardown cannot leak. Every child is tracked as it is started, and `afterAll` kills whatever is
 * still running before it removes the temporary directories — on a failing run as well — so neither
 * a stray server holding the file open nor a database directory survives the suite. Nothing asserts
 * on the first process's exit code or signal: graceful signal handling is not part of the contract
 * `src/main.ts` fixes, so only the fact that it stopped is asserted.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDatabase, type TempDatabase } from '../support/tempDatabase.js';

/**
 * The backend workspace directory, which is the child process's working directory and the base its
 * `src/main.ts` argument is resolved against.
 *
 * `../../` is exactly right for this file's depth: the module lives at
 * `backend/tests/integration/restart.test.ts`, so `../` is `tests/` and `../../` is `backend/`. A
 * wrong depth makes the child fail to find `src/main.ts` and the health probe time out, which is why
 * the value is derived from the module's own URL rather than from the runner's working directory.
 */
const backendRoot = fileURLToPath(new URL('../../', import.meta.url));

/** How long a child is given to answer `/api/health` before the suite gives up on it. */
const HEALTH_DEADLINE_MILLISECONDS = 15_000;

/** How long the health probe waits between attempts while the child is starting. */
const HEALTH_POLL_INTERVAL_MILLISECONDS = 100;

/** How long a stopping child is given to exit before it is sent a stronger signal. */
const STOP_TIMEOUT_MILLISECONDS = 5_000;

/** How many free ports the helper reserves before concluding it cannot produce a distinct one. */
const FREE_PORT_ATTEMPTS = 5;

/**
 * The explicit per-test timeout, restating the suite-wide 30 seconds configured in
 * `backend/vitest.config.ts`. One or two child processes are started, probed and stopped inside each
 * test, so the bound it runs under is named here rather than left implicit.
 */
const TIMEOUT_MILLISECONDS = 30_000;

/** The title of the task the first process creates; also what the read-back assertion names. */
const TASK_TITLE = 'Survives a restart';

/**
 * The timestamp shape the API promises: ISO 8601 in UTC with milliseconds, as `toISOString()`
 * produces it. The exact instant is never asserted, because it is the system's own choice.
 */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The logger level a child is started at unless the case needs a louder one.
 *
 * `silent` keeps the restart case's two children from interleaving their startup lines with the
 * runner's output; the startup-output case overrides it, because the record it counts is written at
 * `info` and a child started at `silent` would prove nothing about it.
 */
const DEFAULT_LOG_LEVEL = 'silent';

/** The logger level the startup-output case starts its child at, which is the level it counts. */
const STARTUP_LOG_LEVEL = 'info';

/** The pino level number of an `info` record, which is what the startup line is written as. */
const STARTUP_LEVEL = 30;

/** The startup line's message, which is what distinguishes it from any other level-30 record. */
const STARTUP_MESSAGE = 'API listening';

/**
 * The text the framework's own `listen` puts in the record the startup requirement forbids.
 *
 * Only a prefix is matched: the framework appends the resolved address to it, and the address is
 * exactly what the application's own line already reports.
 */
const FRAMEWORK_BANNER_TEXT = 'Server listening';

/**
 * The schema version a freshly reserved database file carries after the entry point migrates it.
 *
 * A path no process has opened before is migrated from version 0 to the current version, so this is
 * the whole schema the child applies rather than the version of the developer's own file.
 */
const FRESH_SCHEMA_VERSION = 1;

/** How long the startup record is given to arrive once the child has answered health. */
const STARTUP_DEADLINE_MILLISECONDS = 5_000;

/** How long the startup-record probe waits between attempts. */
const STARTUP_POLL_INTERVAL_MILLISECONDS = 50;

/**
 * How long the case waits after the record first appears before it counts.
 *
 * The record and any record written beside it arrive within microseconds of each other, so this only
 * has to outlast a stdout flush that a chunk boundary delayed; it is a settle window over an
 * accumulate-and-count step, never a substitute for the bounded probes, and no assertion depends on
 * its length.
 */
const SETTLE_MILLISECONDS = 300;

/** The three priority names the entity and the table both accept. */
type TaskPriority = 'low' | 'medium' | 'high';

/**
 * The eight fields a task response carries — the whole wire shape this suite compares across the
 * two processes.
 *
 * Declared here rather than imported from the domain: the domain module is not one this suite is
 * allowed to consume, and a test that compared against the server's own type would stop being an
 * independent check of what the server actually sent.
 */
interface TaskBody {
  /** Server-generated identifier, stable across the restart. */
  readonly id: string;
  /** The task's title, as created. */
  readonly title: string;
  /** The description; `''` when none was supplied. */
  readonly description: string;
  /** The priority; `medium` when none was supplied. */
  readonly priority: TaskPriority;
  /** The due date, or `null` when none was supplied. */
  readonly dueDate: string | null;
  /** Whether the task is complete; `false` for a task that has just been created. */
  readonly completed: boolean;
  /** Creation instant, ISO 8601 UTC with milliseconds. */
  readonly createdAt: string;
  /** Last-change instant; equal to `createdAt` until the task is updated. */
  readonly updatedAt: string;
}

/**
 * One spawned API process, together with what a caller needs to talk to it and to explain its
 * failure.
 *
 * `stdout()` and `output()` are separated deliberately: the startup records are asserted on the
 * child's standard output alone, while a failure is explained with everything the child wrote —
 * including the standard error a crash reports itself on. The startup case runs its child at `info`
 * while the restart case runs its own at `silent`, so the level is a parameter of `startApi` rather
 * than a property of the record.
 */
interface ApiProcess {
  /** The spawned child running `src/main.ts`. */
  readonly child: ChildProcess;
  /** The port the child was told to bind through `PORT`. */
  readonly port: number;
  /** Everything the child has written to standard output so far. */
  stdout(): string;
  /** Everything the child has written to standard output and standard error so far. */
  output(): string;
}

/**
 * Every child this suite has started, in start order, so the teardown can stop whatever a failed
 * test left running. A child is added at the moment it is spawned, not when it is awaited, so a
 * process that dies before the test reaches its own assertions is still tracked.
 */
const startedProcesses: ApiProcess[] = [];

/**
 * Every temporary database the suite has created, in creation order, so the teardown can remove each
 * one even when a test failed part-way through. Held at module scope for the same reason as the
 * process list: the two cases create their own file, and neither directory may survive the run.
 */
const temporaryDatabases: TempDatabase[] = [];

/** True once the child has exited, whether through an exit code or through a signal. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Waits up to `timeoutMilliseconds` for the child's `exit` event.
 *
 * Resolves `true` when the child exited and `false` when the wait elapsed, so a caller can escalate
 * to a stronger signal without an exception standing between it and its next step. A child that has
 * already exited resolves `true` at once, because the event it fired earlier will not fire again.
 */
function waitForExit(child: ChildProcess, timeoutMilliseconds: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMilliseconds);

    function onExit(): void {
      clearTimeout(timer);
      resolve(true);
    }

    child.once('exit', onExit);
  });
}

/** Resolves after `milliseconds`; the probes' pause, named so each loop reads as a loop. */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Reserves a free TCP port on loopback and releases it, returning the number the kernel chose.
 *
 * The port is closed again before the number is returned, because the child must be able to bind
 * it: a held listener here would make the child fail with `EADDRINUSE`. The reservation is
 * therefore only a strong hint that the port was free a moment ago, which is what the health probe
 * is for.
 */
async function reserveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      // `address()` is an object for a TCP socket, a string for a pipe and `null` before the bind
      // completes; only the first shape carries the port.
      if (address === null || typeof address === 'string') {
        server.close(() => {
          reject(new Error('The free-port probe bound to something without a port'));
        });
        return;
      }

      const { port } = address;

      server.close((closeError) => {
        if (closeError !== undefined) {
          reject(closeError);
          return;
        }

        resolve(port);
      });
    });
  });
}

/**
 * Reserves a free port that is not one of the ports already taken by this suite.
 *
 * The restart needs two distinct ports: reusing the first one would make the second server
 * indistinguishable from the first at the socket level, and the kernel is free to hand a released
 * port straight back. A repeat is simply drawn again, so the assertion that follows the call is
 * about two servers rather than about the kernel's habits.
 */
async function findFreePort(...taken: readonly number[]): Promise<number> {
  for (let attempt = 0; attempt < FREE_PORT_ATTEMPTS; attempt += 1) {
    const port = await reserveFreePort();

    if (!taken.includes(port)) {
      return port;
    }
  }

  throw new Error(`Could not reserve a free port other than ${taken.join(', ')}`);
}

/** The loopback URL of one route on the API process listening on `port`. */
function apiUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

/**
 * Starts the API process on `port` against `databasePath` and returns the record that tracks it.
 *
 * The child is this process's own Node executable — the same runtime the suite runs on — invoked
 * with `--import tsx` and `src/main.ts`, run from `backendRoot` because that relative entry path is
 * resolved against the child's working directory. `DATABASE_PATH` is the absolute temporary path it
 * must open, and `LOG_LEVEL` is the level the caller asks for — `silent` by default, so the restart
 * case's children do not interleave with the runner's output, and `info` for the startup-output
 * case, whose record is written at that level. The standard streams are piped and accumulated rather
 * than inherited, so the child can stay quiet on success and still explain itself on failure; stdout
 * and stderr are kept apart because the startup records are read from stdout alone.
 *
 * @param port The port to bind, already reserved as free by `findFreePort`.
 * @param databasePath The absolute SQLite file the child must open.
 * @param logLevel The logger level handed to the child through `LOG_LEVEL`.
 */
function startApi(
  port: number,
  databasePath: string,
  logLevel: string = DEFAULT_LOG_LEVEL,
): ApiProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: databasePath,
      LOG_LEVEL: logLevel,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const standardOutput: string[] = [];
  const standardError: string[] = [];

  // Decoded as text on the way in: the output is read back as log records and as a failure
  // explanation, so there is nothing that would need the original bytes.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    standardOutput.push(chunk);
  });
  child.stderr?.on('data', (chunk: string) => {
    standardError.push(chunk);
  });

  const record: ApiProcess = {
    child,
    port,
    stdout: () => standardOutput.join(''),
    output: () => standardOutput.join('') + standardError.join(''),
  };

  startedProcesses.push(record);

  // A spawn that failed to launch leaves no pid behind; failing here names the child that never
  // started rather than letting the health probe spend its whole deadline on it.
  if (child.pid === undefined) {
    throw new Error(`The API process on port ${port} could not be started: ${record.output()}`);
  }

  return record;
}

/** True for a JSON object, so a parsed response can be read field by field without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the child's standard output as the log records it has written so far.
 *
 * A record is one JSON object per line, so a line that is not a complete JSON object is a breach of
 * the output contract rather than a slow process, and the offending line is what the failure
 * reports. The text after the last newline is deliberately not read: a chunk boundary can leave the
 * record being written incomplete, and a caller that polls will see it whole on the next attempt,
 * where parsing it here would fail the case on the runner's timing rather than on the application's
 * behaviour.
 *
 * @param text Everything the child has written to standard output so far.
 */
function readLogRecords(text: string): Record<string, unknown>[] {
  // `split` always yields at least one element, the remainder after the last newline, so dropping it
  // leaves exactly the lines that were terminated.
  const completeLines = text.split('\n').slice(0, -1);

  const records: Record<string, unknown>[] = [];

  for (const line of completeLines) {
    if (line.trim() === '') {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Expected one JSON log record per line, received: ${line}\n${text}`);
    }

    if (!isRecord(parsed)) {
      throw new Error(`Expected one JSON log record per line, received: ${line}\n${text}`);
    }

    records.push(parsed);
  }

  return records;
}

/** True for the records written at the level the startup line is written at. */
function isStartupLevel(record: Record<string, unknown>): boolean {
  return record['level'] === STARTUP_LEVEL;
}

/**
 * Waits until the child has written a level-30 record, or fails with the child's own output.
 *
 * The record is written immediately after the bind completes, so it is normally already there by the
 * time the health probe returns; polling is what makes the case independent of that ordering, and
 * the deadline is what stops a child that binds but never logs from hanging the suite. A child that
 * has exited can never write it, so that case fails at once with everything the child wrote.
 *
 * @param record The tracked child, whose accumulated standard output is polled.
 */
async function waitForStartupRecord(record: ApiProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_DEADLINE_MILLISECONDS;

  while (Date.now() < deadline) {
    if (hasExited(record.child)) {
      throw new Error(
        `The API process on port ${record.port} exited before writing a startup record.\n${record.output()}`,
      );
    }

    if (readLogRecords(record.stdout()).some(isStartupLevel)) {
      return;
    }

    await delay(STARTUP_POLL_INTERVAL_MILLISECONDS);
  }

  throw new Error(
    `The API process on port ${record.port} wrote no level-${String(STARTUP_LEVEL)} record within ${String(STARTUP_DEADLINE_MILLISECONDS)} ms.\n${record.output()}`,
  );
}

/** True for the three priority names the API accepts. */
function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 'low' || value === 'medium' || value === 'high';
}

/**
 * Narrows a parsed response body to the eight-field task the contract promises.
 *
 * Every field is checked for presence and kind, so a response that is an error envelope, a partial
 * object or a list cannot be mistaken for the task this suite is comparing — the deep equality at
 * the end of the test would otherwise pass while asserting nothing.
 */
function isTaskBody(value: unknown): value is TaskBody {
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
 * Reads a response body as the task it must be, failing with the body itself when it is not.
 *
 * A response that is not a complete task is a contract breach rather than a slow process, so the
 * received text is what the failure reports: it is the whole of what a reader needs to see which
 * field came back wrong.
 */
async function readTaskBody(response: Response): Promise<TaskBody> {
  const text = await response.text();

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Expected a JSON task body, received: ${text}`);
  }

  if (!isTaskBody(parsed)) {
    throw new Error(`Expected a complete task body, received: ${text}`);
  }

  return parsed;
}

/**
 * True for the documented liveness body, `{ "status": "ok" }`.
 *
 * The route's contract is the body as well as the status, so the probe waits for both: a 200 whose
 * body is something else would be a different route than the one the interface and the end-to-end
 * suite wait on.
 */
function isLivenessBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);

    return isRecord(parsed) && parsed['status'] === 'ok';
  } catch {
    return false;
  }
}

/**
 * Waits until the API process answers `GET /api/health` with 200 `{ "status": "ok" }`, or fails with
 * the child's own output.
 *
 * The port accepts nothing until the child has loaded the TypeScript entry point, opened and
 * migrated the database file and bound the socket, so a refused connection is the expected state
 * for the first few attempts and is retried rather than reported; the last rejection is kept only
 * to explain a timeout. A child that has exited can never become ready, so that case fails at once
 * with the child's accumulated stdout and stderr — the one place where a startup failure explains
 * itself. The deadline bounds the wait either way, so a child that starts but never binds cannot
 * hang the suite.
 */
async function waitForHealth(record: ApiProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_DEADLINE_MILLISECONDS;

  let lastFailure = 'the probe did not complete an attempt';

  while (Date.now() < deadline) {
    if (hasExited(record.child)) {
      throw new Error(
        `The API process on port ${record.port} exited before answering /api/health.\n${record.output()}`,
      );
    }

    try {
      const response = await fetch(apiUrl(record.port, '/api/health'));
      const body = await response.text();

      if (response.status === 200 && isLivenessBody(body)) {
        return;
      }

      lastFailure = `GET /api/health answered ${response.status} with ${body}`;
    } catch (error) {
      // Nothing is listening on the port yet, which is not the failure this helper reports: the
      // exit check above and the deadline below are. The reason is kept so a timeout can quote it.
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await delay(HEALTH_POLL_INTERVAL_MILLISECONDS);
  }

  throw new Error(
    `The API process on port ${record.port} did not answer /api/health within ${HEALTH_DEADLINE_MILLISECONDS} ms (${lastFailure}).\n${record.output()}`,
  );
}

/**
 * Stops the API process and waits for it to be gone.
 *
 * `SIGTERM` is sent first and the child is given `STOP_TIMEOUT_MILLISECONDS` to exit; a child that
 * is still running after that is sent `SIGKILL` and awaited again. The exit code and the signal are
 * deliberately not inspected: `src/main.ts` fixes no signal handling, so a process that dies from
 * the signal and one that installs a handler and exits cleanly are both correct, and asserting
 * either would test something the specification never promised.
 */
async function stopApi(record: ApiProcess): Promise<void> {
  const { child } = record;

  if (hasExited(child)) {
    return;
  }

  child.kill('SIGTERM');

  if (await waitForExit(child, STOP_TIMEOUT_MILLISECONDS)) {
    return;
  }

  // The wait may have elapsed just as the child exited on its own, so the state is read again
  // before the escalation is treated as necessary.
  if (hasExited(child)) {
    return;
  }

  child.kill('SIGKILL');

  if (await waitForExit(child, STOP_TIMEOUT_MILLISECONDS)) {
    return;
  }

  if (hasExited(child)) {
    return;
  }

  throw new Error(
    `The API process on port ${record.port} is still running after SIGKILL.\n${record.output()}`,
  );
}


describe('the API process restarted on one database file', () => {
  afterAll(async () => {
    // Neither a process nor a database directory may outlive the suite, on a green run or a red
    // one. The children go first: a server still holding the file open would keep a `-wal` sidecar
    // alive through the removal below. Every step is guarded and none throws, so one awkward child
    // cannot stop the next one from being stopped or the directory from being removed — a failure
    // that got that far is reported at the end rather than raised in the middle.
    const lingering: string[] = [];

    for (const record of startedProcesses) {
      if (!hasExited(record.child)) {
        record.child.kill('SIGKILL');

        if (!(await waitForExit(record.child, STOP_TIMEOUT_MILLISECONDS)) && !hasExited(record.child)) {
          lingering.push(`pid ${String(record.child.pid)} on port ${record.port}`);
        }
      }

      // The pipes are closed explicitly so the runner has no handle of its own left open after the
      // process behind them is gone.
      record.child.stdout?.destroy();
      record.child.stderr?.destroy();
    }

    // Removing each whole directory takes its database file and the `-wal`/`-shm` sidecars a child
    // killed mid-write leaves behind. `cleanup()` is idempotent and does not throw, so calling it
    // after a test already disposed of its own database is a no-op.
    for (const database of temporaryDatabases) {
      database.cleanup();
    }

    expect(lingering).toEqual([]);
  });

  it(
    'reads back, from a second process, the task the first process created over HTTP',
    async () => {
      // One database file for both processes: the second one is handed the same path, which is what
      // makes this a restart rather than a second isolated server.
      const database = createTempDatabase('restart-');
      temporaryDatabases.push(database);

      const firstPort = await findFreePort();
      const first = startApi(firstPort, database.path);
      await waitForHealth(first);

      // The created body is captured whole: it is the value the second process's answer is compared
      // against after the restart, and the defaults asserted here are the ones the create contract
      // fixes — an absent description, priority and due date arrive as `''`, `medium` and `null`.
      const createResponse = await fetch(apiUrl(firstPort, '/api/tasks'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: TASK_TITLE }),
      });
      expect(createResponse.status).toBe(201);

      const created = await readTaskBody(createResponse);
      expect(created.title).toBe(TASK_TITLE);
      expect(created.description).toBe('');
      expect(created.priority).toBe('medium');
      expect(created.dueDate).toBeNull();
      expect(created.completed).toBe(false);
      expect(created.createdAt).toMatch(ISO_TIMESTAMP_PATTERN);
      expect(created.updatedAt).toMatch(ISO_TIMESTAMP_PATTERN);

      await stopApi(first);
      expect(hasExited(first.child)).toBe(true);

      // A different port and the same file: the first process is gone, so whatever the second one
      // reads can only have reached it through the database file on disk.
      const secondPort = await findFreePort(firstPort);
      expect(secondPort).not.toBe(firstPort);

      const second = startApi(secondPort, database.path);
      await waitForHealth(second);

      // Two distinct processes really ran; the comparison below cannot pass by reusing one.
      expect(second.child.pid).not.toBe(first.child.pid);

      const readResponse = await fetch(apiUrl(secondPort, `/api/tasks/${created.id}`));
      expect(readResponse.status).toBe(200);

      // The whole body, field for field: the same identifier, the same defaults, and the creation
      // and last-change instants the first process reported, unaltered by the restart.
      const read = await readTaskBody(readResponse);
      expect(read).toEqual(created);
    },
    TIMEOUT_MILLISECONDS,
  );

  it(
    'writes exactly one startup record naming the address, the database path and the schema version',
    async () => {
      const database = createTempDatabase('startup-logging-');
      temporaryDatabases.push(database);

      const port = await findFreePort();
      const record = startApi(port, database.path, STARTUP_LOG_LEVEL);

      // The liveness answer is the readiness signal: the entry point composes the application,
      // migrates the reserved file and binds before it can answer, so the startup line has been
      // written — or is about to be — by the time this returns.
      await waitForHealth(record);
      await waitForStartupRecord(record);

      // Then the output is allowed to settle and read again: a second record written just after the
      // first — the framework's own banner is written a few microseconds before the application's
      // line, and a startup line split across two chunks lands in the same window — must be inside
      // the measurement, not after it.
      await delay(SETTLE_MILLISECONDS);

      const records = readLogRecords(record.stdout());
      const startupRecords = records.filter(isStartupLevel);

      // The requirement is one record, so the count is the assertion: two records of this level is
      // the failure, whatever either of them carries.
      expect(startupRecords).toHaveLength(1);

      const startup = startupRecords.at(0);

      if (startup === undefined) {
        throw new Error(`Expected one startup record, received: ${record.stdout()}`);
      }

      // The single record is the one that names all three facts, each read from the process's own
      // configuration and the schema the file was migrated to: the address the socket actually bound
      // rather than the one requested, the file the child was handed, and the version a fresh path
      // reaches.
      expect(startup).toMatchObject({
        msg: STARTUP_MESSAGE,
        address: `127.0.0.1:${String(port)}`,
        databasePath: database.path,
        schemaVersion: FRESH_SCHEMA_VERSION,
      });

      // And the framework's own listening line, which reports the address and nothing else, must not
      // be there beside it — the banner is what produced the second record.
      const banners = records.filter(
        (candidate) =>
          typeof candidate['msg'] === 'string' && candidate['msg'].includes(FRAMEWORK_BANNER_TEXT),
      );

      expect(banners).toEqual([]);

      // The process is still serving after all of the above, so the records counted belong to a
      // running server rather than to one that logged and then died.
      expect(hasExited(record.child)).toBe(false);

      await stopApi(record);
      expect(hasExited(record.child)).toBe(true);
    },
    TIMEOUT_MILLISECONDS,
  );
});

