/**
 * Integration suite for the API's liveness route: `GET /api/health`.
 *
 * What is asserted, and why it is worth a suite of its own. The route answers 200 with exactly
 * `{ "status": "ok" }` for as long as the process serves requests, and nothing else: it reads no
 * storage, reports no version, counts nothing and requires no credential. Each of those is a
 * separate claim here. The strongest — that liveness touches no storage at all — is proved by
 * answering 200 from an application whose every port method throws, with the stub's call counter
 * still at zero afterwards, and with one listing request through that same application as the
 * control that the stub really was wired in, so the zero means "never asked" rather than "asked
 * nothing". The body assertions are exact-key assertions rather than field comparisons, so an added
 * version or task count fails `Object.keys` instead of quietly turning the route into a status
 * report.
 *
 * The path is a load-bearing contract beyond this file. The root `playwright.config.ts` waits on
 * `http://localhost:3000/api/health` before it starts driving the browser, and the sibling
 * `backend/tests/integration/restart.test.ts` polls the same path to detect that a spawned process
 * has started serving, so renaming the path or changing the body breaks two other suites. The
 * request to `/health` below — outside the `/api` prefix, answered by the not-found handler — is what
 * pins the route to its exact path rather than leaving it to convention.
 *
 * How it runs. The composed block drives the real object graph through `composeApp`, the one module
 * permitted to wire infrastructure into the HTTP layer, over a database file reserved per test by
 * `../../support/tempDatabase.ts`: never the developer's `backend/data/todo.db` and never the
 * end-to-end suite's database. The failure block composes `buildApp` by hand around a throwing
 * repository, which is the only way to answer "does this route depend on storage?" without storage.
 * Every request goes through `app.inject()`, so nothing here binds a socket, imports the SQLite
 * driver, reaches the network or reads an environment variable; no timestamp is asserted, so no
 * assertion depends on the wall clock, and only the one deliberate 500 below logs anything.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { composeApp, type AppConfig } from '../../../src/main.js';
import { buildApp, type AppDependencies, type BuildAppOptions } from '../../../src/interface/http/buildApp.js';
import { CreateTask } from '../../../src/application/CreateTask.js';
import { DeleteTask } from '../../../src/application/DeleteTask.js';
import { GetTask } from '../../../src/application/GetTask.js';
import { ListTasks } from '../../../src/application/ListTasks.js';
import { ToggleTaskCompletion } from '../../../src/application/ToggleTaskCompletion.js';
import { UpdateTask } from '../../../src/application/UpdateTask.js';
import type { TaskRepository } from '../../../src/application/TaskRepository.js';
import type { Task } from '../../../src/domain/task.js';
import { systemClock } from '../../../src/infrastructure/systemClock.js';
import { createTempDatabase, type TempDatabase } from '../../support/tempDatabase.js';

/** The liveness route's path, named once so every request and assertion uses the same string. */
const HEALTH_PATH = '/api/health';

/** The listing route, used only by the wiring control in the storage-failure block. */
const TASKS_PATH = '/api/tasks';

/**
 * The one body the liveness route may answer with.
 *
 * Held as a constant so the two blocks assert against the identical object, and asserted together
 * with `Object.keys` below, so a body that grew a field fails rather than passing on `status` alone.
 */
const EXPECTED_HEALTH_BODY = { status: 'ok' };

/** The response media type the route must answer with; a 200 that is not JSON is not the contract. */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * The failure the stub store throws.
 *
 * The wording is one no other part of the system can produce, so a response body that ever carried
 * it would be unmistakable evidence that a storage failure reached the client.
 */
const STUB_FAILURE_MESSAGE = 'stub storage failure — must never appear in a response body';

/** The composed application, derived from the factory so the type is the product's own. */
type FastifyApp = ReturnType<typeof buildApp>;

/**
 * The parts of an injected response this suite reads.
 *
 * Declared structurally rather than taken from the framework's own response type: the suite asserts
 * against the wire contract, and an injected response satisfies this shape.
 */
interface InjectedResponse {
  /** The status the route answered with. */
  readonly statusCode: number;
  /**
   * The response headers. The framework's own header type allows a number and an array beside a
   * string, so all three are named here rather than narrowed to the one a media type uses.
   */
  readonly headers: Readonly<Record<string, number | string | string[] | undefined>>;
  /** The response body, parsed as JSON. */
  json(): unknown;
}

/**
 * The value of a response header, or the empty string when the header carries no single string value.
 *
 * A media type is always one string; the empty fallback keeps an assertion's failure message about
 * the header rather than about how it was read.
 */
function headerValue(response: InjectedResponse, name: string): string {
  const value = response.headers[name];

  return typeof value === 'string' ? value : '';
}

/** True when `value` is a plain JSON object: not `null`, not an array, not a primitive. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a parsed response body as the plain JSON object the route answers with.
 *
 * @throws Error when the body is not a JSON object, so a body of some other shape reports what it
 *   was rather than failing later on a property access.
 */
function jsonObjectFrom(response: InjectedResponse): Record<string, unknown> {
  const body: unknown = response.json();

  if (!isJsonObject(body)) {
    throw new Error(`The response body is not a JSON object: ${JSON.stringify(body)}`);
  }

  return body;
}

/**
 * The `error.code` of a parsed failure response: the part of the error envelope this suite reads.
 *
 * @throws Error when the body is not the contract's envelope, so an unmatched path that answered
 *   something else reports that instead of comparing against `undefined`.
 */
function errorCodeFrom(response: InjectedResponse): string {
  const body = jsonObjectFrom(response);
  const error = body['error'];

  if (!isJsonObject(error) || typeof error['code'] !== 'string') {
    throw new Error(`The response body is not the error contract's envelope: ${JSON.stringify(body)}`);
  }

  return error['code'];
}

/**
 * The store that refuses everything: the only persistence the storage-failure composition has.
 *
 * Every port method counts the call and then throws, so the counter is a direct record of whether the
 * route under test touched storage at all — a read that failed counts as a read. The methods take no
 * arguments because they never use one: the interface is satisfied structurally by a method that
 * accepts fewer parameters, and the doc comment on each names the port member it stands for.
 */
class ThrowingTaskRepository implements TaskRepository {
  /** Total number of port methods invoked; must stay 0 across every health request. */
  public calls = 0;

  /** {@link TaskRepository.insert}: counts the call and refuses to store anything. */
  async insert(): Promise<void> {
    this.calls += 1;
    throw new Error(STUB_FAILURE_MESSAGE);
  }

  /** {@link TaskRepository.findById}: counts the call and refuses to read anything. */
  async findById(): Promise<Task | null> {
    this.calls += 1;
    throw new Error(STUB_FAILURE_MESSAGE);
  }

  /** {@link TaskRepository.findAll}: counts the call and refuses to read anything. */
  async findAll(): Promise<Task[]> {
    this.calls += 1;
    throw new Error(STUB_FAILURE_MESSAGE);
  }

  /** {@link TaskRepository.update}: counts the call and refuses to replace anything. */
  async update(): Promise<boolean> {
    this.calls += 1;
    throw new Error(STUB_FAILURE_MESSAGE);
  }

  /** {@link TaskRepository.delete}: counts the call and refuses to remove anything. */
  async delete(): Promise<boolean> {
    this.calls += 1;
    throw new Error(STUB_FAILURE_MESSAGE);
  }
}

/** The application the test currently running injects into. */
let app: FastifyApp | undefined;

/**
 * Releases that application together with whatever it owns: the two resources `composeApp` returns
 * (the server and the database handle) in one step, and the temporary location the database file
 * lives in.
 */
let close: (() => Promise<void>) | undefined;

/** The temporary location reserved for the application above; the teardown removes its whole tree. */
let temp: TempDatabase | undefined;

/**
 * The application under test, or a failure that names the setup step that did not finish.
 *
 * @throws Error when the block's setup hook did not produce an application, so a test reports the
 *   missing setup rather than a dereference of `undefined`.
 */
function requireApp(): FastifyApp {
  if (app === undefined) {
    throw new Error('The application under test was not built: the setup hook did not finish.');
  }

  return app;
}

/**
 * Releases everything the test that just ran took hold of, in dependency order: the application and
 * the database handle first, then the directory holding the file and its SQLite `-wal`/`-shm`
 * sidecars.
 *
 * Every step is attempted even when an earlier one fails, so a failing assertion can never leave a
 * server, a handle or a directory behind; the failures are raised together at the end rather than
 * dropped, because a resource that could not be released must be loud.
 *
 * @param message The summary for the raised error, naming which block's resources failed to release.
 */
async function releaseResources(message: string): Promise<void> {
  const failures: unknown[] = [];

  const release = close;
  close = undefined;

  if (release !== undefined) {
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }

  const reserved = temp;
  temp = undefined;

  if (reserved !== undefined) {
    try {
      // The driver is closed by now, so the file and its sidecars are no longer held open and the
      // recursive removal takes all three.
      reserved.cleanup();
    } catch (error) {
      failures.push(error);
    }
  }

  // Dropped last: the instance is closed, so no later request may reach it.
  app = undefined;

  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}

/**
 * The liveness route over the real object graph: the database, the SQLite adapter, the six use cases
 * and the HTTP application, composed by `composeApp` exactly as the process composes them.
 *
 * A fresh composition and a fresh database file per test, so the "once tasks exist" case below
 * creates its task in the same store it then asks about, and no test's data reaches another's.
 */
describe('GET /api/health (composed application)', () => {
  beforeEach(async () => {
    const reserved = createTempDatabase('http-health-');
    temp = reserved;

    // `port: 0` is inert: `composeApp` composes, opens and migrates but never listens, which is what
    // keeps every request in this file in-process. `silent` keeps the runner's output free of request
    // logs; nothing on any path below is meant to be read from a log.
    const config: AppConfig = {
      port: 0,
      databasePath: reserved.path,
      logLevel: 'silent',
    };

    const composed = await composeApp(config);

    app = composed.app;
    close = composed.close;

    // Awaited for explicitness, so the routes and both handlers are in place before the first request
    // is injected rather than at the moment it is.
    await composed.app.ready();
  });

  afterEach(async () => {
    await releaseResources('Releasing the health suite resources failed.');
  });

  it('answers 200 with exactly { status: "ok" } and a JSON media type', async () => {
    const application = requireApp();

    // No credential, no cookie and no `authorization` header: no route in this product is
    // authenticated, and this request is the evidence that liveness needs nothing of the sort.
    const response = await application.inject({ method: 'GET', url: HEALTH_PATH });

    expect(response.statusCode).toBe(200);
    expect(headerValue(response, 'content-type')).toContain(JSON_MEDIA_TYPE);

    const body = jsonObjectFrom(response);

    // The body is the object itself — no envelope, no wrapper — and the keys are asserted separately
    // so a field added beside `status`, such as a version or a task count, fails here.
    expect(Object.keys(body)).toStrictEqual(['status']);
    expect(body).toStrictEqual(EXPECTED_HEALTH_BODY);
  });

  it('answers the exact path, leaving a request outside /api to the not-found handler', async () => {
    const application = requireApp();

    // The path inside the prefix is the liveness route ...
    const health = await application.inject({ method: 'GET', url: HEALTH_PATH });
    expect(health.statusCode).toBe(200);

    // ... and the same route without the prefix matches nothing, so the not-found handler `buildApp`
    // installs answers it with the error contract's 404 rather than with a body of its own. That is
    // what makes `/api/health` the contract the readiness probe and the restart poll wait on.
    const unprefixed = await application.inject({ method: 'GET', url: '/health' });

    expect(unprefixed.statusCode).toBe(404);
    expect(errorCodeFrom(unprefixed)).toBe('NOT_FOUND');
  });

  it('answers the same body once tasks exist, reporting no count and no version', async () => {
    const application = requireApp();

    // A real task through the real stack, so the store the next request is asked about genuinely
    // holds data. What the created task looks like is the task routes' own suite's business.
    const created = await application.inject({
      method: 'POST',
      url: TASKS_PATH,
      payload: { title: 'Buy milk' },
    });
    expect(created.statusCode).toBe(201);

    const response = await application.inject({ method: 'GET', url: HEALTH_PATH });

    expect(response.statusCode).toBe(200);

    // Byte-for-byte the body of an empty store: liveness reports that the process is serving, never
    // how much it holds, so a task count or a schema version would fail here.
    const body = jsonObjectFrom(response);
    expect(Object.keys(body)).toStrictEqual(['status']);
    expect(body).toStrictEqual(EXPECTED_HEALTH_BODY);
  });

  it('answers consecutive requests with identical bodies', async () => {
    const application = requireApp();

    const first = await application.inject({ method: 'GET', url: HEALTH_PATH });
    const second = await application.inject({ method: 'GET', url: HEALTH_PATH });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    // No first-call-only behaviour and no accumulated state between requests: the second answer is
    // the first answer, which is what makes the route safe to poll as often as a probe needs to.
    expect(second.json()).toStrictEqual(first.json());
  });
});

/**
 * The liveness route over a deliberately broken composition: the same application factory and the
 * same six routes, with a store whose every method throws.
 *
 * This is the one shape that can answer whether the route depends on storage, and it answers it
 * directly — a 200 with the exact body, from an application that cannot read or write anything, with
 * the stub's counter still at zero. The composition is built once for the block rather than per test,
 * because the application holds no per-request state and the single test below makes no use of the
 * store that would need isolating.
 */
describe('GET /api/health (storage failure)', () => {
  /** The store every use case in this block is constructed over. */
  const stub = new ThrowingTaskRepository();

  beforeAll(async () => {
    // Reserved and released exactly as the composed block's location is, and never opened: the stub
    // is this composition's only store, so the zero on its counter — not a directory — is the
    // evidence that liveness read no storage. Nothing leaves a database file behind for this block.
    temp = createTempDatabase('http-health-stub-');

    // All six use cases over the throwing stub, so the application's route table is complete and its
    // listing route would reach storage if a request asked it to — which is what the control at the
    // end of the test below does, proving these are the dependencies the factory really received.
    const dependencies: AppDependencies = {
      createTask: new CreateTask({ repository: stub, clock: systemClock }),
      updateTask: new UpdateTask({ repository: stub, clock: systemClock }),
      deleteTask: new DeleteTask({ repository: stub }),
      toggleTaskCompletion: new ToggleTaskCompletion({ repository: stub, clock: systemClock }),
      getTask: new GetTask({ repository: stub }),
      listTasks: new ListTasks({ repository: stub }),
    };

    // `error` rather than `silent`: the one deliberate 500 below logs its cause at this level, which
    // is where an operator would read it, and the client's body carries the generic message instead.
    const options: BuildAppOptions = { logLevel: 'error' };

    app = buildApp(dependencies, options);

    await app.ready();
  });

  afterAll(async () => {
    await releaseResources('Releasing the health suite resources failed.');
  });

  beforeEach(() => {
    stub.calls = 0;
  });

  it('answers 200 without reaching a port method, even though every one of them throws', async () => {
    const application = requireApp();

    const response = await application.inject({ method: 'GET', url: HEALTH_PATH });

    // A 200 carrying the same exact body the composed application answers with, from an application
    // whose storage cannot be touched at all: liveness opens no database, reports no version and
    // counts nothing, so a storage outage cannot make the probe fail.
    expect(response.statusCode).toBe(200);
    expect(headerValue(response, 'content-type')).toContain(JSON_MEDIA_TYPE);

    const body = jsonObjectFrom(response);
    expect(Object.keys(body)).toStrictEqual(['status']);
    expect(body).toStrictEqual(EXPECTED_HEALTH_BODY);

    // Had the route read, counted or written anything, a port method would have recorded itself here
    // before throwing; no method did.
    expect(stub.calls).toBe(0);

    // The control that gives the zero its meaning: one listing request through the very same
    // application does reach the stub, so the six use cases really were handed to `buildApp`. The
    // zero above is therefore evidence that liveness never asked storage, not evidence that storage
    // was left out of the composition. The 500 is the error contract's own response for a failed
    // store, and the task routes' full contract, this path included, belongs to the sibling
    // `tasks.test.ts`.
    const listing = await application.inject({ method: 'GET', url: TASKS_PATH });
    const listingBody = jsonObjectFrom(listing);

    expect(listing.statusCode).toBe(500);
    expect(errorCodeFrom(listing)).toBe('INTERNAL_ERROR');

    // The cause stayed server-side, which is the contract's "no stack, no driver message, no file
    // path, no record data" read as an executable assertion: the failure's own text never reaches
    // the client.
    expect(JSON.stringify(listingBody)).not.toContain(STUB_FAILURE_MESSAGE);

    expect(stub.calls).toBeGreaterThan(0);
  });
});

