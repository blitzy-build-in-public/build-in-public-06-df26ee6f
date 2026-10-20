/**
 * The API process: its configuration surface, its composition root and its entry point.
 *
 * This is the one module in the repository allowed to name a concrete implementation. It opens the
 * SQLite file, builds the adapter that implements the application's persistence port, supplies the
 * system clock, constructs the six use cases, assembles the HTTP application around them and binds
 * the socket — so every other module reaches the store, the clock and the framework only through
 * something it was handed. `.dependency-cruiser.cjs` keeps it that way: the layer rules are scoped
 * to `domain/`, `application/`, `infrastructure/` and `interface/`, which leaves this file as the
 * single place an infrastructure module and the HTTP layer may meet.
 *
 * Two exports serve two callers. `composeApp` builds the graph without listening, which is what the
 * integration tests drive a temporary database file with; `main` reads the environment and starts
 * the process. Importing this module must bind nothing and start nothing, because the tests import
 * `composeApp` and the coverage run loads every source file, so `main` runs only when the process
 * was launched with this file as its entry point.
 */
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { CreateTask } from './application/CreateTask.js';
import { DeleteTask } from './application/DeleteTask.js';
import { GetTask } from './application/GetTask.js';
import { ListTasks } from './application/ListTasks.js';
import { ToggleTaskCompletion } from './application/ToggleTaskCompletion.js';
import { UpdateTask } from './application/UpdateTask.js';
import { openDatabase } from './infrastructure/database.js';
import { LATEST_SCHEMA_VERSION } from './infrastructure/migrations.js';
import { SqliteTaskRepository } from './infrastructure/SqliteTaskRepository.js';
import { systemClock } from './infrastructure/systemClock.js';
import { buildApp } from './interface/http/buildApp.js';

/** Port the API binds when `PORT` is absent or cannot be parsed. */
const DEFAULT_PORT = 3000;

/**
 * SQLite file opened when `DATABASE_PATH` is absent, resolved against the process working
 * directory. npm runs a workspace script with the workspace directory as its working directory, so
 * through the root scripts this lands on `backend/data/todo.db`.
 */
const DEFAULT_DATABASE_PATH = './data/todo.db';

/** Pino level for the application logger when `LOG_LEVEL` is absent. */
const DEFAULT_LOG_LEVEL = 'info';

/**
 * The configuration the API process runs from, read once at startup.
 *
 * Every field has a default, so the application runs with no environment set at all. Each comes
 * from exactly one variable, documented beside it below and in `.env.example`; the process reads no
 * other variable and loads no environment file.
 */
export interface AppConfig {
  /** Port the API binds. Source: `PORT`, default `3000`. */
  port: number;
  /**
   * SQLite file to open. Source: `DATABASE_PATH`, default `./data/todo.db`, resolved against the
   * process working directory; the parent directory is created when it is missing.
   */
  databasePath: string;
  /** Pino level for the application logger. Source: `LOG_LEVEL`, default `info`. */
  logLevel: string;
}

/**
 * Renders the address `net.Server#address()` reports as one readable string.
 *
 * A bound socket is reported as an object, a pipe or unix socket as a string, and `null` before
 * anything is bound — so the three shapes are flattened here rather than at the log call, which is
 * the only place the address is used.
 */
function formatBoundAddress(address: AddressInfo | string | null): string {
  if (address === null) {
    return 'unbound';
  }

  return typeof address === 'string' ? address : `${address.address}:${address.port}`;
}

/**
 * Builds the whole object graph — database, adapter, ports, use cases and HTTP application — and
 * returns it ready to be injected into or listened on, together with the one function that releases
 * it. A failure while building any part of it leaves nothing behind: the handle the build opened is
 * released before that failure propagates unchanged.
 *
 * It deliberately does not listen: choosing the port and binding the socket belongs to `main`, and
 * keeping the two apart is what lets a test compose the application over a temporary database file
 * and drive every route in-process. It also constructs nothing through a factory or a registry,
 * because constructor injection from this one place is what makes the store and the clock
 * replaceable without a change to the domain or the application layer.
 *
 * @param config The port, database path and log level the process was configured with.
 * @returns The application, and a `close` that releases both it and the database handle. `close` is
 *   for in-process callers and is called once, when a test or an embedding process is finished; it
 *   releases the database handle whether or not closing the application succeeds, and a failure to
 *   close the application is still raised to the caller.
 */
export async function composeApp(
  config: AppConfig,
): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  // The opener creates the parent directory, applies the busy timeout and the pragmas and brings the
  // schema up to date, so the handle below is configured and migrated before anything uses it.
  const db = openDatabase(config.databasePath);

  let app: FastifyInstance;

  try {
    const repository = new SqliteTaskRepository(db);
    const clock = systemClock;

    const createTask = new CreateTask({ repository, clock });
    const updateTask = new UpdateTask({ repository, clock });
    const toggleTaskCompletion = new ToggleTaskCompletion({ repository, clock });
    const getTask = new GetTask({ repository });
    const deleteTask = new DeleteTask({ repository });
    const listTasks = new ListTasks({ repository });

    app = buildApp(
      { createTask, updateTask, deleteTask, toggleTaskCompletion, getTask, listTasks },
      { logLevel: config.logLevel },
    );
  } catch (error) {
    // Nothing between the open above and the assignment in the block owns the handle yet, so a throw
    // from here — an unbuildable HTTP application included — would leave it open with no caller left
    // to release it. The failure is rethrown as it arrived: releasing the handle must not replace the
    // startup failure the caller has to read.
    try {
      db.close();
    } catch {
      // Deliberately not raised: the failure below is the one the caller has to read, and a close
      // failure reported in its place would hide the build failure that caused the release.
    }

    throw error;
  }

  return {
    app,
    // The two resources are released in the order they were built, so a server that has stopped
    // accepting requests can never be followed by a handle some in-flight request still needs.
    close: async () => {
      try {
        await app.close();
      } finally {
        // In a `finally` because a server whose close rejects has still stopped accepting requests,
        // so the handle must be released then too — and the rejection stays the caller's to handle.
        db.close();
      }
    },
  };
}

/**
 * Reads the configuration from the environment and starts the API process.
 *
 * This is the module's only process-level behaviour: compose the application, bind the socket, log
 * where it came up. A startup failure — an unusable database file, a port already in use — is left
 * to reject out of this function, so it surfaces rather than being swallowed, and nothing here
 * calls `process.exit`.
 */
export async function main(): Promise<void> {
  const rawPort = process.env.PORT;
  // A missing or unparsable PORT must never reach the listen call as a non-number, so the default is
  // applied to the parse result rather than to the variable: an absent value, an empty one and a
  // non-numeric one all fall back, and a valid value can never be displaced by the default.
  const parsedPort = Number.parseInt(rawPort ?? '', 10);
  const port = Number.isNaN(parsedPort) ? DEFAULT_PORT : parsedPort;

  const config: AppConfig = {
    port,
    databasePath: process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH,
    logLevel: process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  };

  const { app } = await composeApp(config);

  // Loopback only: the application is single-user and local by requirement, so it is reachable from
  // this machine and from nowhere else, and no route needs a credential.
  await app.listen({ port: config.port, host: '127.0.0.1' });

  // The one startup log line: where the API is bound, which file holds the data and which schema
  // version that file carries — the operator's answer to all three questions. Nothing else in this
  // file logs, no request's success path logs, and no task content ever reaches the log.
  app.log.info(
    {
      address: formatBoundAddress(app.server.address()),
      databasePath: config.databasePath,
      schemaVersion: LATEST_SCHEMA_VERSION,
    },
    'API listening',
  );
}

// The module must be inert when it is imported: the integration tests import `composeApp` and drive
// the application in-process, and the coverage run loads every source file, so a module-level
// `main()` would bind a port nobody asked for. `pathToFileURL` is used rather than concatenating
// `file://` with the path because it produces the encoding `import.meta.url` carries, so the
// comparison also holds when the path holds a space or a Windows drive letter.
const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  // Deliberately not awaited and not handled: a rejected `main` becomes an unhandled rejection,
  // which is what makes a startup failure loud in the log instead of silently exiting with a zero.
  void main();
}
