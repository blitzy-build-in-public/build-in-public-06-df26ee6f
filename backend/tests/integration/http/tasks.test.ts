/**
 * Integration suite for the five task routes: the interface contract, executed end to end.
 *
 * What it proves, and on which path. Every request below but one is delivered in-process through
 * `app.inject()`, so no socket and no HTTP client is involved, and the subject is the product's own
 * composition: the route table, the request parsing, the six use cases, the SQLite adapter and the
 * file those sit on, wired by `composeApp` in `src/main.ts` — the one module allowed to name a
 * concrete implementation. The happy paths, the query parameters, the 400s and the 404s therefore run
 * against the application the process really serves, and the object graph is never assembled by hand
 * for them. The exception is the request line the transport refuses before a request exists: the
 * injector runs a request through the router and cannot deliver it, so that one case opens a socket of
 * its own.
 *
 * The 500 paths need storage to fail on demand, so they are driven twice. `buildApp` over a
 * repository that throws isolates the error mapping from storage entirely; and one case composes the
 * real application and then makes its storage fail for real, by dropping the table from a second
 * connection — which is what proves the composed path answers a genuine SQLite failure through the
 * same one mapping.
 *
 * Three invariants hold across the whole file:
 *
 * - Every rejected request is checked for the contract's error envelope under its own status, and the
 *   stored identifiers are compared before and after it, so "a rejected request creates nothing and
 *   changes nothing" is asserted per case rather than assumed.
 * - No assertion reads the wall clock. The composed application uses the system clock, so timestamps
 *   are compared with one another — the create body against the patch body against the following read
 *   — and the one place a write's `updatedAt` must be seen to advance waits out the clock's
 *   millisecond resolution first, rather than comparing two instants taken inside one millisecond.
 * - Every database file comes from `createTempDatabase`, so the developer's `backend/data/todo.db` and
 *   the end-to-end suite's file are never opened by this suite.
 *
 * Deliberately not here: the health route (`health.test.ts` owns it), coverage configuration
 * (`backend/vitest.config.ts` owns it, and this interface layer is reported rather than gated), and
 * anything about optimistic concurrency — the contract is last write wins and defines no conflict
 * status.
 */
import { connect, type AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CreateTask } from '../../../src/application/CreateTask.js';
import { DeleteTask } from '../../../src/application/DeleteTask.js';
import { GetTask } from '../../../src/application/GetTask.js';
import { ListTasks } from '../../../src/application/ListTasks.js';
import { type TaskRepository } from '../../../src/application/TaskRepository.js';
import { ToggleTaskCompletion } from '../../../src/application/ToggleTaskCompletion.js';
import { UpdateTask } from '../../../src/application/UpdateTask.js';
import { VALIDATION_ERROR_MESSAGE } from '../../../src/domain/errors.js';
import { type Task } from '../../../src/domain/task.js';
import { FIELD_MESSAGES, isValidPriority } from '../../../src/domain/validation.js';
import { openDatabase } from '../../../src/infrastructure/database.js';
import { systemClock } from '../../../src/infrastructure/systemClock.js';
import {
  buildApp,
  type AppDependencies,
  type BuildAppOptions,
} from '../../../src/interface/http/buildApp.js';
import {
  INTERNAL_ERROR_MESSAGE,
  MALFORMED_BODY_MESSAGE,
  type ApiErrorBody,
  type ApiErrorCode,
} from '../../../src/interface/http/errorMapper.js';
import { composeApp, type AppConfig } from '../../../src/main.js';
import { createTempDatabase, type TempDatabase } from '../../support/tempDatabase.js';

/** The identifier shape the create route generates: a lowercase UUID, as the contract states. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The eight field names every task body carries, ascending.
 *
 * Asserted as a whole key set so an omitted field is a visible failure rather than an absence a
 * narrower assertion would read past.
 */
const TASK_FIELD_NAMES: readonly string[] = [
  'completed',
  'createdAt',
  'description',
  'dueDate',
  'id',
  'priority',
  'title',
  'updatedAt',
];

/** The `error` member's keys, and only these, per the single envelope. */
const ENVELOPE_ERROR_KEYS: readonly string[] = ['code', 'fields', 'message'];

/** The failure classes the contract defines. */
const API_ERROR_CODES: readonly ApiErrorCode[] = ['VALIDATION_ERROR', 'NOT_FOUND', 'INTERNAL_ERROR'];

/**
 * Pino's `error` level, which is the level the cause of a 500 is logged at.
 *
 * `errorMapper.ts` logs a failure that maps to a 5xx through the request logger, so an error-level
 * record is the observable evidence that the cause reached the operator while the client received the
 * generic body.
 */
const PINO_ERROR_LEVEL = 50;

/**
 * The description pino gives the symbol that holds a logger's destination stream.
 *
 * Pino keeps that symbol private (it is not registered globally, so `Symbol.for` does not reach it),
 * so the stream is found by this description. See {@link captureLogOutput} for why the stream, and not
 * `process.stdout`, is what has to be tapped.
 */
const PINO_STREAM_SYMBOL_DESCRIPTION = 'pino.stream';

/**
 * How long this suite waits when one write's timestamp must be seen to advance past another's.
 *
 * `createdAt` and `updatedAt` are ISO 8601 with millisecond resolution, and two requests driven
 * back-to-back in-process can be applied inside the same millisecond. The wait is bounded by that
 * resolution and is never used to reason about how long anything took.
 */
const TIMESTAMP_RESOLUTION_WAIT_MS = 10;

/** The composed application, derived from the factory, so the type is the product's own. */
type FastifyApp = ReturnType<typeof buildApp>;

/** The graph `composeApp` builds, kept together so a test's teardown releases both of its parts. */
type ComposedApp = Awaited<ReturnType<typeof composeApp>>;

/** The request methods this suite drives. */
type HttpMethod = 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT';

/**
 * The parts of an injected response this suite reads.
 *
 * Declared structurally rather than imported, because a test that asserted against the framework's own
 * response type would be reaching outside the modules it is allowed to consume; an injected response
 * satisfies this shape.
 */
interface InjectedResponse {
  /** The status the route answered with. */
  readonly statusCode: number;
  /** The response headers, as the framework's own type supplies them. */
  readonly headers: { readonly [name: string]: number | string | string[] | undefined };
  /** The response body exactly as it was sent, which is what a leak check has to read. */
  readonly body: string;
  /** The response body parsed as JSON. */
  json(): unknown;
}

/** One rejected request: its response, and the error envelope the contract requires of it. */
interface RejectedRequest {
  /** The response the route answered the rejected request with. */
  readonly response: InjectedResponse;
  /** The envelope its body carried, already checked against the contract. */
  readonly body: ApiErrorBody;
}

/**
 * The part of a logger's destination stream this suite wraps: the one method every log record passes
 * through.
 */
interface LogDestination {
  /** Receives one serialised log record, followed by whatever the stream itself expects. */
  write: (...args: unknown[]) => unknown;
}

/** True when a parsed value is a JSON object rather than an array, `null` or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when a parsed value carries the entity's eight fields with the JSON kinds the contract
 * declares.
 *
 * A response body arrives as `unknown`, so this guard is what lets it be read as a task without a
 * cast. The priority is checked against the domain's own level set rather than against a second list
 * written here, so a level the domain accepts can never be rejected by this suite. Assertions about
 * the *values* — the trimmed title, the defaults, the instants — stay in the tests.
 */
function isTask(value: unknown): value is Task {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value['id'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['description'] === 'string' &&
    isValidPriority(value['priority']) &&
    (value['dueDate'] === null || typeof value['dueDate'] === 'string') &&
    typeof value['completed'] === 'boolean' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

/** True when a parsed value is the bare array of tasks the listing contract returns. */
function isTaskArray(value: unknown): value is Task[] {
  return Array.isArray(value) && value.every((entry) => isTask(entry));
}

/** True when a value is a pino destination stream this suite can wrap. */
function isLogDestination(value: unknown): value is LogDestination {
  return typeof value === 'object' && value !== null && 'write' in value && typeof value.write === 'function';
}

/** True when a value is one of the contract's failure classes. */
function isApiErrorCode(value: string): value is ApiErrorCode {
  return API_ERROR_CODES.some((code) => code === value);
}

/**
 * The failure class each status carries, per the single mapping in `errorMapper.ts`.
 *
 * Asserting the pairing — rather than only that the code is one of the three — is what lets the
 * envelope check catch a mapping that answered the wrong kind of failure under the right status.
 *
 * A client-error status other than 404 carries `VALIDATION_ERROR`: the mapping keeps the framework's
 * own client-error status under the contract's one validation class, so such a status is asserted
 * the same way a 400 is, and never with a class of its own. A status the contract gives no class to
 * at all — any 5xx other than 500 — is a failure of this suite's expectation rather than a code to
 * guess at.
 */
function expectedCodeFor(statusCode: number): ApiErrorCode {
  switch (statusCode) {
    case 400:
      return 'VALIDATION_ERROR';
    case 404:
      return 'NOT_FOUND';
    case 500:
      return 'INTERNAL_ERROR';
    default:
      if (statusCode >= 400 && statusCode < 500) {
        return 'VALIDATION_ERROR';
      }
      throw new Error(`The contract defines no failure class for status ${statusCode}`);
  }
}

/**
 * Asserts the one error envelope of the contract and returns it typed.
 *
 * Every 4xx and 5xx response carries it, and none carries the framework's default error shape: the
 * body is an object whose only key is `error`, whose only keys are `code`, `message` and `fields`,
 * whose code is the class the status requires, whose message is a non-empty string, and whose fields
 * is an object of field name to non-empty message. Structure is established by narrowing, which is
 * what hands the caller a typed envelope; the values are established by assertion.
 */
function expectErrorEnvelope(body: unknown, statusCode: number): ApiErrorBody {
  if (!isRecord(body)) {
    throw new Error(`Expected the error envelope, received: ${JSON.stringify(body)}`);
  }
  expect(Object.keys(body)).toEqual(['error']);

  const error = body['error'];
  if (!isRecord(error)) {
    throw new Error(
      `Expected the envelope's "error" member to be an object, received: ${JSON.stringify(body)}`,
    );
  }
  expect(Object.keys(error).sort()).toEqual(ENVELOPE_ERROR_KEYS);

  const code: unknown = error['code'];
  if (typeof code !== 'string' || !isApiErrorCode(code)) {
    throw new Error(`Expected one of the contract's failure classes, received: ${JSON.stringify(code)}`);
  }
  expect(code).toBe(expectedCodeFor(statusCode));

  const message: unknown = error['message'];
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error(`Expected a non-empty summary, received: ${JSON.stringify(message)}`);
  }

  const fields: unknown = error['fields'];
  if (!isRecord(fields)) {
    throw new Error(`Expected "fields" to be an object, received: ${JSON.stringify(fields)}`);
  }

  const fieldMessages: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `Expected a non-empty message for the "${name}" field, received: ${JSON.stringify(value)}`,
      );
    }
    fieldMessages[name] = value;
  }

  return { error: { code, message, fields: fieldMessages } };
}

/**
 * Asserts the whole 500 contract of one response: the status, the generic envelope, and that the body
 * discloses nothing about the failure.
 *
 * The forbidden fragments are the failure's own text and the storage detail behind it. They are checked
 * against the raw body as well as through the envelope, so a stack frame, a driver message or a file
 * path cannot ride along beside the generic summary.
 */
function expectInternalError(
  response: InjectedResponse,
  forbiddenFragments: readonly string[],
): ApiErrorBody {
  expect(response.statusCode).toBe(500);

  const body = expectErrorEnvelope(response.json(), 500);
  expect(body.error.code).toBe('INTERNAL_ERROR');
  expect(body.error.fields).toEqual({});
  expect(body.error.message).toBe(INTERNAL_ERROR_MESSAGE);

  for (const fragment of forbiddenFragments) {
    expect(response.body).not.toContain(fragment);
  }

  return body;
}

/** The message the envelope carries for one field, failing when that field was not reported. */
function fieldMessage(body: ApiErrorBody, name: string): string {
  const message = body.error.fields[name];
  if (message === undefined) {
    throw new Error(
      `Expected a message for the "${name}" field, received: ${JSON.stringify(body.error.fields)}`,
    );
  }
  return message;
}

/**
 * One response header flattened to a string.
 *
 * The framework's header type allows a number and an array as well as a string, so the media type of a
 * response is read through this rather than assumed to be a string.
 */
function headerValue(response: InjectedResponse, name: string): string {
  const value = response.headers[name];
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value === undefined ? '' : String(value);
}

/**
 * Drives one request in-process.
 *
 * A payload is sent as a JSON body with the matching content type. A request without one carries no
 * content type at all, which is what lets the body-less cases exercise both the parser's rejection and
 * the handler's.
 */
async function request(
  app: FastifyApp,
  method: HttpMethod,
  url: string,
  payload?: Record<string, unknown>,
): Promise<InjectedResponse> {
  if (payload === undefined) {
    return app.inject({ method, url });
  }
  return app.inject({ method, url, headers: { 'content-type': 'application/json' }, payload });
}

/** The task a response body carries, failing when the body is not one. */
function taskOf(response: InjectedResponse): Task {
  const body: unknown = response.json();
  if (!isTask(body)) {
    throw new Error(`Expected a task body, received: ${response.body}`);
  }
  return body;
}

/** The tasks a response body carries, failing when the body is not a bare array of tasks. */
function tasksOf(response: InjectedResponse): Task[] {
  const body: unknown = response.json();
  if (!isTaskArray(body)) {
    throw new Error(`Expected a JSON array of tasks, received: ${response.body}`);
  }
  return body;
}

/** Creates a task through the route, with the create contract's status and body asserted. */
async function createTask(app: FastifyApp, input: Record<string, unknown>): Promise<Task> {
  const response = await request(app, 'POST', '/api/tasks', input);
  expect(response.statusCode).toBe(201);
  return taskOf(response);
}

/** Patches one task through the route, with the update contract's status and body asserted. */
async function patchTask(app: FastifyApp, id: string, patch: Record<string, unknown>): Promise<Task> {
  const response = await request(app, 'PATCH', `/api/tasks/${id}`, patch);
  expect(response.statusCode).toBe(200);
  return taskOf(response);
}

/** Reads one task through the route, with the read contract's status and body asserted. */
async function readTask(app: FastifyApp, id: string): Promise<Task> {
  const response = await request(app, 'GET', `/api/tasks/${id}`);
  expect(response.statusCode).toBe(200);
  return taskOf(response);
}

/** Deletes one task through the route, asserting the 204 and the empty body it must carry. */
async function deleteTask(app: FastifyApp, id: string): Promise<void> {
  const response = await request(app, 'DELETE', `/api/tasks/${id}`);
  expect(response.statusCode).toBe(204);
  expect(response.body).toBe('');
}

/** Reads a listing through the route, asserting the 200 and the bare array it must return. */
async function readList(app: FastifyApp, url = '/api/tasks'): Promise<Task[]> {
  const response = await request(app, 'GET', url);
  expect(response.statusCode).toBe(200);
  return tasksOf(response);
}

/** Every stored identifier, ascending: what the "nothing was created" invariant compares. */
async function listIds(app: FastifyApp): Promise<string[]> {
  return (await readList(app))
    .map((task) => task.id)
    .sort();
}

/** The titles of a listing, ascending, so a filter assertion does not depend on the ordering. */
function sortedTitles(tasks: readonly Task[]): string[] {
  return tasks.map((task) => task.title).sort();
}

/** The identifier order the default `createdAt` sort must produce: newest first. */
function idsNewestFirst(tasks: readonly Task[]): string[] {
  return [...tasks].sort(compareNewestFirst).map((task) => task.id);
}

/**
 * Orders two tasks the way the `createdAt` sort does: the later creation first, and two tasks created
 * within one millisecond by identifier ascending.
 *
 * This is the total order the listing applies, restated here because a test has to know the order it
 * asserts. The expected sequence is computed from the response bodies rather than from the wall clock,
 * so it holds whatever resolution the clock gave the fixture.
 */
function compareNewestFirst(a: Task, b: Task): number {
  if (a.createdAt === b.createdAt) {
    return compareIdentifiers(a.id, b.id);
  }
  return a.createdAt > b.createdAt ? -1 : 1;
}

/** Orders two identifiers ascending in code units — the tie-break every sort applies. */
function compareIdentifiers(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Drives a request that must be rejected and asserts the two invariants every rejection shares.
 *
 * The envelope is checked under the expected status, and the stored identifiers are compared before
 * and after the request, so a rejection that quietly created or removed a task fails here instead of
 * being missed. Both checks are per call, which is why every 400 and 404 below goes through this
 * helper rather than asserting a status alone.
 */
async function rejectedRequest(
  app: FastifyApp,
  send: () => Promise<InjectedResponse>,
  statusCode = 400,
): Promise<RejectedRequest> {
  const before = await listIds(app);
  const response = await send();
  expect(response.statusCode).toBe(statusCode);

  const body = expectErrorEnvelope(response.json(), statusCode);
  expect(await listIds(app)).toEqual(before);

  return { response, body };
}

/**
 * Waits until the system clock can have advanced past the millisecond the previous write stamped.
 *
 * Used only where a test must observe that `updatedAt` advanced. Every other timestamp assertion
 * compares one response body with another and needs no wait at all.
 */
async function waitPastTimestampResolution(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, TIMESTAMP_RESOLUTION_WAIT_MS);
  });
}

/**
 * The configuration the composed application runs from in this suite.
 *
 * `port` is inert because `composeApp` does not listen, and the database path is the temporary file
 * the test reserved, so no test can reach the developer's database.
 */
function composedConfig(databasePath: string, logLevel: string): AppConfig {
  return { port: 0, databasePath, logLevel };
}

/** A composed application under test, with the release that disposes of everything it opened. */
interface ComposedFixture {
  /** The application every request of one test is injected into. */
  readonly api: FastifyApp;
  /** The database file the application holds, so a test can make its storage fail for real. */
  readonly databasePath: string;
  /** Closes the application and its database handle and removes the file's temporary directory. */
  readonly release: () => Promise<void>;
}

/**
 * The open handle `openDatabase` returns, derived from the production opener.
 *
 * Derived rather than named from the driver's own types, because this suite never imports the driver:
 * the handle it opens is whatever the opener it runs against hands back.
 */
type DatabaseHandle = ReturnType<typeof openDatabase>;

/**
 * Composes one application over a fresh temporary database file.
 *
 * `composeApp` is the single place the SQLite adapter, the clock, the six use cases and the HTTP layer
 * are wired together, so a request driven through the returned application travels the composed path
 * the process serves. The application does not listen, so no port is bound — which is what lets several
 * suites on one host compose applications without colliding.
 *
 * @param prefix Directory-name prefix for this fixture's temporary file, kept recognisable.
 * @param logLevel Pino level for the application; the failure subject raises it so the logged cause is
 *   observable.
 */
async function startComposedApp(prefix: string, logLevel = 'silent'): Promise<ComposedFixture> {
  const temp: TempDatabase = createTempDatabase(prefix);
  const built: ComposedApp = await composeApp(composedConfig(temp.path, logLevel));
  await built.app.ready();

  return {
    api: built.app,
    databasePath: temp.path,
    // The two resources are released in the order they were built, and each release is guarded: a
    // failure while releasing can never mask the assertion failure already on its way out of the test,
    // and neither resource is left behind for the next test to inherit.
    release: async () => {
      try {
        await built.close();
      } catch {
        // The database file is removed by the directory cleanup below in any case.
      }

      try {
        temp.cleanup();
      } catch {
        // Nothing left to remove: the directory is either gone or owned by the OS temp cleaner.
      }
    },
  };
}

/**
 * The composed application one test is driving, or `null` outside a test.
 *
 * Held at module scope so that building and releasing an application per test is written once rather
 * than once per subject; the tests in a file run one at a time, so a single slot holds it.
 */
let composedFixture: ComposedFixture | null = null;

/** Composes the application for the current test, over its own database file. */
async function composeForTest(prefix: string, logLevel = 'silent'): Promise<void> {
  composedFixture = await startComposedApp(prefix, logLevel);
}

/** Releases the application the current test was driving, however that test ended. */
async function releaseForTest(): Promise<void> {
  const fixture = composedFixture;
  composedFixture = null;

  if (fixture !== null) {
    await fixture.release();
  }
}

/** The application under test, failing loudly when a test runs outside a setup hook. */
function api(): FastifyApp {
  if (composedFixture === null) {
    throw new Error('The composed application was not built for this test');
  }
  return composedFixture.api;
}

/** The database file the application under test holds, failing outside a setup hook. */
function composedDatabasePath(): string {
  if (composedFixture === null) {
    throw new Error('The composed application was not built for this test');
  }
  return composedFixture.databasePath;
}

/**
 * Drives one request with the application's log output captured.
 *
 * The two belong together: the tee has to be in place before the request is driven and taken back
 * afterwards, which is what {@link captureLogOutput} does around the call.
 */
async function requestCapturingLog(
  app: FastifyApp,
  send: () => Promise<InjectedResponse>,
): Promise<{ response: InjectedResponse; captured: string }> {
  let response: InjectedResponse | null = null;

  const captured = await captureLogOutput(app, async () => {
    response = await send();
  });

  if (response === null) {
    throw new Error('The captured request produced no response');
  }

  return { response, captured };
}


/** The pino destination stream the given application's logger writes through, or `null` if none. */
function loggerDestination(app: FastifyApp): LogDestination | null {
  for (const symbol of Object.getOwnPropertySymbols(app.log)) {
    if (symbol.description !== PINO_STREAM_SYMBOL_DESCRIPTION) {
      continue;
    }

    const candidate: unknown = Reflect.get(app.log, symbol);
    if (isLogDestination(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Captures everything the application's logger writes while `run` executes.
 *
 * The records are tee'd from the logger's destination stream, and every call is forwarded to that
 * stream, so the run's output still reaches stdout. Tapping `process.stdout.write` instead would
 * capture nothing here: pino's default destination writes to file descriptor 1 through sonic-boom and
 * never calls the `process.stdout` object's own `write`, which this application's 500 path was
 * measured against on this host.
 *
 * `run` is the request(s) under measurement; the macrotask yield afterwards gives the logger a turn to
 * flush the record before the tee is taken back. The stream is restored in a `finally`, because a
 * destination left patched would leak this test's capture into every later test in the same forked
 * worker.
 */
async function captureLogOutput(app: FastifyApp, run: () => Promise<void>): Promise<string> {
  const destination = loggerDestination(app);
  if (destination === null) {
    throw new Error('The application logger exposed no pino destination stream to capture');
  }

  const captured: string[] = [];
  const original = destination.write;
  destination.write = (...args: unknown[]): unknown => {
    const [chunk] = args;
    if (typeof chunk === 'string') {
      captured.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      captured.push(Buffer.from(chunk).toString('utf8'));
    }
    return original.apply(destination, args);
  };

  try {
    await run();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    destination.write = original;
  }

  return captured.join('');
}

/**
 * Asserts that the cause of a 500 reached the log.
 *
 * The evidence is at least one error-level record carrying the expected text. The captured output is
 * named in the failure, because if the write ever moves somewhere this tee does not see, an operator
 * needs what was captured in order to find it.
 */
function expectLoggedCause(captured: string, expected: string): void {
  const carriers = parseLogRecords(captured).filter(
    (record) => record['level'] === PINO_ERROR_LEVEL && JSON.stringify(record).includes(expected),
  );

  expect(
    carriers,
    `No error-level record carrying "${expected}" was captured. Captured output: ${captured === '' ? '(nothing)' : captured}`,
  ).not.toHaveLength(0);
}

/** One record the logger wrote, or `null` for a line that is not a JSON object. */
function toLogRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every log record in `text`, in the order the logger wrote them, ignoring anything else. */
function parseLogRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const record = toLogRecord(line);
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}

/**
 * The failure the storage stub throws.
 *
 * Written as something no other part of the system can produce, so that finding it in a response body
 * is a leak and finding it in the log is the cause.
 */
const STUB_FAILURE_MESSAGE = 'stub storage failure — must never appear in a response body';

/**
 * A storage port implementation that records every call and always fails.
 *
 * Only the 500 path needs it, so it does nothing else. Each failure appends the operation that was
 * reached, which is what names the port method in the log; the counter records the calls, which is
 * what proves the failure path was really taken even if the logger's record format ever changed.
 */
class ThrowingTaskRepository implements TaskRepository {
  /** Total number of port methods invoked since the last reset. */
  public calls = 0;

  /** Records the call and fails: a task that could not be stored. */
  public insert(task: Task): Promise<void> {
    return this.fail(`insert(${task.id})`);
  }

  /** Records the call and fails: a lookup that could not be answered. */
  public findById(id: string): Promise<Task | null> {
    return this.fail(`findById(${id})`);
  }

  /** Records the call and fails: a listing that could not be read. */
  public findAll(): Promise<Task[]> {
    return this.fail('findAll()');
  }

  /** Records the call and fails: a task that could not be replaced. */
  public update(task: Task): Promise<boolean> {
    return this.fail(`update(${task.id})`);
  }

  /** Records the call and fails: a task that could not be removed. */
  public delete(id: string): Promise<boolean> {
    return this.fail(`delete(${id})`);
  }

  /**
   * Counts the call and returns a rejection, so the use case above rejects exactly as it would over a
   * failing store rather than being reached through a synchronous throw.
   */
  private fail(operation: string): Promise<never> {
    this.calls += 1;
    return Promise.reject(new Error(`${STUB_FAILURE_MESSAGE} (${operation})`));
  }
}

/**
 * The use cases the routes drive, built over a repository that always fails.
 *
 * This is the one place in the suite that assembles a graph by hand, and it is deliberate: the failure
 * has to be attributable to storage alone, which no composed application can offer. The clock is the
 * production one, because a timestamp plays no part in the 500 path.
 */
function storageFailureDependencies(repository: TaskRepository): AppDependencies {
  return {
    createTask: new CreateTask({ repository, clock: systemClock }),
    updateTask: new UpdateTask({ repository, clock: systemClock }),
    deleteTask: new DeleteTask({ repository }),
    toggleTaskCompletion: new ToggleTaskCompletion({ repository, clock: systemClock }),
    getTask: new GetTask({ repository }),
    listTasks: new ListTasks({ repository }),
  };
}


describe('task routes (composed application)', () => {
  // One composed application per test, over its own temporary database file, so no test can observe
  // another's writes and no test depends on the order they run in.
  beforeEach(async () => {
    await composeForTest('http-tasks-');
  });

  afterEach(async () => {
    await releaseForTest();
  });

  describe('creating a task', () => {
    it('creates a task from a title alone, trimming it and applying every default', async () => {
      const response = await request(api(), 'POST', '/api/tasks', { title: '   Buy milk   ' });

      expect(response.statusCode).toBe(201);
      expect(headerValue(response, 'content-type')).toContain('application/json');

      const task = taskOf(response);
      expect(Object.keys(task).sort()).toEqual(TASK_FIELD_NAMES);
      expect(task.id).toMatch(UUID_PATTERN);
      expect(task.title).toBe('Buy milk');
      expect(task.description).toBe('');
      expect(task.priority).toBe('medium');
      expect(task.dueDate).toBeNull();
      expect(task.completed).toBe(false);
      expect(task.createdAt).toBe(task.updatedAt);
      expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
    });

    it('keeps the supplied description, priority and due date through a re-read', async () => {
      const created = await createTask(api(), {
        title: 'Buy milk',
        description: 'Two litres',
        priority: 'high',
        dueDate: '2026-02-14',
      });

      expect(created.description).toBe('Two litres');
      expect(created.priority).toBe('high');
      expect(created.dueDate).toBe('2026-02-14');
      expect(await readTask(api(), created.id)).toEqual(created);
    });

    it('accepts a title of exactly the bound once it is trimmed', async () => {
      const created = await createTask(api(), { title: `  ${'t'.repeat(200)}  ` });

      expect(created.title).toBe('t'.repeat(200));
      expect(created.title).toHaveLength(200);
    });

    it('accepts a description of exactly the bound once it is trimmed', async () => {
      const created = await createTask(api(), {
        title: 'Buy milk',
        description: `  ${'d'.repeat(2000)}  `,
      });

      expect(created.description).toBe('d'.repeat(2000));
      expect(created.description).toHaveLength(2000);
    });

    it('lists what was created as a bare array with no envelope around it', async () => {
      const first = await createTask(api(), { title: 'Buy milk' });
      const second = await createTask(api(), { title: 'Walk the dog' });

      const response = await request(api(), 'GET', '/api/tasks');

      expect(response.statusCode).toBe(200);
      expect(headerValue(response, 'content-type')).toContain('application/json');
      expect(Array.isArray(response.json())).toBe(true);
      expect(tasksOf(response).map((task) => task.id).sort()).toEqual([first.id, second.id].sort());
    });
  });

  describe('reading one task', () => {
    it('answers with the stored task exactly as it was created', async () => {
      const created = await createTask(api(), {
        title: 'Buy milk',
        description: 'Two litres',
        priority: 'low',
        dueDate: '2026-03-01',
      });

      const response = await request(api(), 'GET', `/api/tasks/${created.id}`);

      expect(response.statusCode).toBe(200);
      expect(taskOf(response)).toEqual(created);
    });
  });

  describe('updating a task', () => {
    /** One single-field patch and the field values it must produce. */
    interface FieldPatchCase {
      readonly label: string;
      readonly patch: Record<string, unknown>;
      readonly expected: Record<string, unknown>;
    }

    /**
     * A patch per field, so the partial update is proved field by field: each value differs from the
     * one the fixture creates, so an update that applied nothing cannot pass.
     */
    const FIELD_PATCH_CASES: readonly FieldPatchCase[] = [
      { label: 'title', patch: { title: 'Buy oat milk' }, expected: { title: 'Buy oat milk' } },
      {
        label: 'description',
        patch: { description: 'Toasted' },
        expected: { description: 'Toasted' },
      },
      { label: 'priority', patch: { priority: 'high' }, expected: { priority: 'high' } },
      { label: 'dueDate', patch: { dueDate: '2026-04-02' }, expected: { dueDate: '2026-04-02' } },
    ];

    /** The two ways the contract clears a field rather than setting it. */
    const CLEARING_CASES: readonly FieldPatchCase[] = [
      { label: 'an empty string', patch: { description: '' }, expected: { description: '' } },
      { label: 'null', patch: { dueDate: null }, expected: { dueDate: null } },
    ];

    /** A task with every optional field set, so a single-field patch has something to preserve. */
    async function createFullyPopulated(): Promise<Task> {
      return await createTask(api(), {
        title: 'Buy milk',
        description: 'Two litres',
        priority: 'low',
        dueDate: '2026-03-01',
      });
    }

    it('applies one patched field, advancing updatedAt and leaving createdAt alone', async () => {
      const created = await createFullyPopulated();
      await waitPastTimestampResolution();

      const updated = await patchTask(api(), created.id, { title: 'Buy oat milk' });

      // Every other field is compared, so a patch that changed two things fails here.
      expect(updated).toEqual({ ...created, title: 'Buy oat milk', updatedAt: updated.updatedAt });
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(created.updatedAt).getTime(),
      );
      expect(updated.createdAt).toBe(created.createdAt);

      // The following read must agree with what the update answered: what the client is told and what
      // the store holds are one task.
      expect(await readTask(api(), created.id)).toEqual(updated);
    });

    it.each(FIELD_PATCH_CASES)(
      'updates the $label and preserves every other field',
      async (testCase: FieldPatchCase) => {
        const created = await createFullyPopulated();
        await waitPastTimestampResolution();

        const updated = await patchTask(api(), created.id, testCase.patch);

        expect(updated).toEqual({ ...created, ...testCase.expected, updatedAt: updated.updatedAt });
        expect(updated.createdAt).toBe(created.createdAt);
        expect(await readTask(api(), created.id)).toEqual(updated);
      },
    );

    it.each(CLEARING_CASES)(
      'clears a set field when the patch supplies $label',
      async (testCase: FieldPatchCase) => {
        const created = await createFullyPopulated();
        await waitPastTimestampResolution();

        const updated = await patchTask(api(), created.id, testCase.patch);

        expect(updated).toEqual({ ...created, ...testCase.expected, updatedAt: updated.updatedAt });
        expect(await readTask(api(), created.id)).toEqual(updated);
      },
    );
  });

  describe('completing and reopening a task', () => {
    it('carries a patch holding only completed through the completion path', async () => {
      const created = await createTask(api(), { title: 'Buy milk' });
      await waitPastTimestampResolution();

      const completed = await patchTask(api(), created.id, { completed: true });

      expect(completed.completed).toBe(true);
      expect(completed).toEqual({ ...created, completed: true, updatedAt: completed.updatedAt });
      expect(new Date(completed.updatedAt).getTime()).toBeGreaterThan(
        new Date(created.updatedAt).getTime(),
      );

      await waitPastTimestampResolution();
      const reopened = await patchTask(api(), created.id, { completed: false });

      expect(reopened.completed).toBe(false);
      expect(reopened).toEqual({ ...completed, completed: false, updatedAt: reopened.updatedAt });
      expect(reopened.createdAt).toBe(created.createdAt);
    });

    it('applies completed together with another field as one partial update', async () => {
      const created = await createTask(api(), { title: 'Buy milk' });

      const edited = await patchTask(api(), created.id, { completed: true, title: 'Buy oat milk' });

      expect(edited.completed).toBe(true);
      expect(edited.title).toBe('Buy oat milk');
      expect(edited.description).toBe(created.description);
      expect(edited.priority).toBe(created.priority);
      expect(edited.dueDate).toBe(created.dueDate);
      expect(edited.createdAt).toBe(created.createdAt);
    });
  });

  describe('deleting a task', () => {
    it('deletes a task without a body and answers a repeat delete with 404', async () => {
      const created = await createTask(api(), { title: 'Buy milk' });

      await deleteTask(api(), created.id);
      expect(await listIds(api())).not.toContain(created.id);

      // The delete is not idempotent by contract, and the repeat goes through the rejecting path, so
      // the list is compared before and after it as well.
      const { body } = await rejectedRequest(
        api(),
        () => request(api(), 'DELETE', `/api/tasks/${created.id}`),
        404,
      );

      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.fields).toEqual({});
      expect(body.error.message).toContain(created.id);
    });

    it('leaves the other tasks in place when one is deleted', async () => {
      const kept = await createTask(api(), { title: 'Buy milk' });
      const removed = await createTask(api(), { title: 'Walk the dog' });

      await deleteTask(api(), removed.id);

      expect(await listIds(api())).toEqual([kept.id]);
      expect(await readTask(api(), kept.id)).toEqual(kept);
    });
  });
});


describe('task routes (composed application): query parameters', () => {
  // The same per-test fixture as every other composed subject: its own database file per test.
  beforeEach(async () => {
    await composeForTest('http-tasks-query-');
  });

  afterEach(async () => {
    await releaseForTest();
  });

  /**
   * The four-task fixture, one input per task.
   *
   * It is built so that every ordering the listing offers has exactly one expected result: the
   * priorities are all different across the tasks that share a level only where the tie-break is the
   * point, the due dates are distinct with exactly one absent — which pins the undated-last rule — and
   * `charlie` is the one task that gets completed, so the status filter has tasks on both sides of it.
   */
  const ALPHA_INPUT: Record<string, unknown> = {
    title: 'alpha',
    priority: 'low',
    dueDate: '2026-03-01',
  };
  const BRAVO_INPUT: Record<string, unknown> = {
    title: 'bravo',
    priority: 'high',
    dueDate: '2026-01-15',
  };
  const CHARLIE_INPUT: Record<string, unknown> = {
    title: 'charlie',
    priority: 'medium',
    dueDate: null,
  };
  const DELTA_INPUT: Record<string, unknown> = {
    title: 'delta',
    priority: 'high',
    dueDate: '2026-02-20',
  };

  /** The fixture's tasks, named rather than indexed, so every assertion reads a real task. */
  interface QueryFixture {
    readonly alpha: Task;
    readonly bravo: Task;
    readonly charlie: Task;
    readonly delta: Task;
  }

  /** Creates the fixture through the routes and completes `charlie`. */
  async function seedFixture(): Promise<QueryFixture> {
    const application = api();

    const alpha = await createTask(application, ALPHA_INPUT);
    const bravo = await createTask(application, BRAVO_INPUT);
    const charlie = await createTask(application, CHARLIE_INPUT);
    const delta = await createTask(application, DELTA_INPUT);

    const completedCharlie = await patchTask(application, charlie.id, { completed: true });

    return { alpha, bravo, charlie: completedCharlie, delta };
  }

  /** Every fixture task, in the order the fixture was created. */
  function fixtureTasks(fixture: QueryFixture): Task[] {
    return [fixture.alpha, fixture.bravo, fixture.charlie, fixture.delta];
  }

  /** The identifiers of the fixture tasks whose titles are named, ascending. */
  function fixtureIds(fixture: QueryFixture, titles: readonly string[]): string[] {
    return fixtureTasks(fixture)
      .filter((task) => titles.includes(task.title))
      .map((task) => task.id)
      .sort();
  }

  it('returns the whole list for no parameters and for the documented empty form', async () => {
    const fixture = await seedFixture();
    const expectedIds = idsNewestFirst(fixtureTasks(fixture));

    const withoutParameters = await readList(api());
    // The request's own example: an empty value means the parameter's default, never an error.
    const withEmptyValues = await readList(api(), '/api/tasks?status=&priority=&sort=');

    expect(withoutParameters.map((task) => task.id)).toEqual(expectedIds);
    expect(withEmptyValues.map((task) => task.id)).toEqual(expectedIds);
    expect(withEmptyValues).toEqual(withoutParameters);
  });

  it.each([
    { value: 'all', expected: ['alpha', 'bravo', 'charlie', 'delta'] },
    { value: 'open', expected: ['alpha', 'bravo', 'delta'] },
    { value: 'completed', expected: ['charlie'] },
  ])('filters by status=$value', async (testCase: { value: string; expected: string[] }) => {
    const fixture = await seedFixture();

    const listed = await readList(api(), `/api/tasks?status=${testCase.value}`);

    expect(sortedTitles(listed)).toEqual([...testCase.expected].sort());
    expect(listed.map((task) => task.id).sort()).toEqual(fixtureIds(fixture, testCase.expected));
  });

  it.each([
    { value: 'low', expected: ['alpha'] },
    { value: 'medium', expected: ['charlie'] },
    { value: 'high', expected: ['bravo', 'delta'] },
  ])('filters by priority=$value', async (testCase: { value: string; expected: string[] }) => {
    const fixture = await seedFixture();

    const listed = await readList(api(), `/api/tasks?priority=${testCase.value}`);

    expect(sortedTitles(listed)).toEqual([...testCase.expected].sort());
    expect(listed.map((task) => task.id).sort()).toEqual(fixtureIds(fixture, testCase.expected));
  });

  it('applies the status and the priority filter together', async () => {
    const fixture = await seedFixture();

    const openHigh = await readList(api(), '/api/tasks?status=open&priority=high');
    expect(sortedTitles(openHigh)).toEqual(['bravo', 'delta']);
    expect(openHigh.map((task) => task.id).sort()).toEqual(fixtureIds(fixture, ['bravo', 'delta']));

    // Nothing is both completed and high priority in the fixture, so the two conditions really are
    // combined rather than the second being ignored.
    expect(await readList(api(), '/api/tasks?status=completed&priority=high')).toEqual([]);
    expect(
      (await readList(api(), '/api/tasks?status=completed&priority=medium')).map((task) => task.id),
    ).toEqual([fixture.charlie.id]);
  });

  it('sorts by due date, earliest first, with the undated task last', async () => {
    await seedFixture();

    const listed = await readList(api(), '/api/tasks?sort=dueDate');

    expect(listed.map((task) => task.title)).toEqual(['bravo', 'delta', 'alpha', 'charlie']);
    expect(listed.at(-1)?.dueDate).toBeNull();
  });

  it('sorts by priority, high first, breaking a tie by identifier ascending', async () => {
    const fixture = await seedFixture();

    const listed = await readList(api(), '/api/tasks?sort=priority');

    expect(listed.map((task) => task.priority)).toEqual(['high', 'high', 'medium', 'low']);

    // The two high-priority tasks are ordered by identifier, which is what makes the order total and
    // reproducible rather than whichever row the store happened to return first.
    const highIds = listed.filter((task) => task.priority === 'high').map((task) => task.id);
    expect(highIds).toEqual([fixture.bravo.id, fixture.delta.id].sort());
  });

  it('sorts by creation time, most recently created first', async () => {
    const fixture = await seedFixture();

    const listed = await readList(api(), '/api/tasks?sort=createdAt');

    // The expected order is computed from the response bodies rather than from the wall clock, so it
    // holds even when the fixture's four creates landed inside one millisecond — in which case the
    // identifiers decide, which is the tie-break this asserts as well.
    expect(listed.map((task) => task.id)).toEqual(idsNewestFirst(fixtureTasks(fixture)));
    // `createdAt` is the default sort, so the same request without a parameter must agree.
    expect(listed.map((task) => task.id)).toEqual((await readList(api())).map((task) => task.id));
  });

  it('combines a status filter, a priority filter and a due-date sort', async () => {
    await seedFixture();

    const listed = await readList(api(), '/api/tasks?status=open&priority=high&sort=dueDate');

    expect(listed.map((task) => task.title)).toEqual(['bravo', 'delta']);
  });

  it('ignores a parameter the contract does not define', async () => {
    await seedFixture();

    const openIds = (await readList(api(), '/api/tasks?status=open')).map((task) => task.id);

    expect((await readList(api(), '/api/tasks?status=open&bogus=1')).map((task) => task.id)).toEqual(
      openIds,
    );
    expect((await readList(api(), '/api/tasks?bogus=1&bogus=2')).map((task) => task.id)).toEqual(
      (await readList(api())).map((task) => task.id),
    );
  });

  /**
   * One query parameter per row, with the message the contract fixes for that parameter.
   *
   * The strings are the contract's own text, so they are asserted literally: the module that owns
   * them fixes one message per parameter row, and reading that constant here would let the wording
   * drift from the contract without failing.
   */
  interface QueryParameterCase {
    readonly parameter: string;
    readonly message: string;
  }

  const QUERY_PARAMETER_CASES: readonly QueryParameterCase[] = [
    { parameter: 'status', message: 'status must be one of: all, open, completed' },
    { parameter: 'priority', message: 'priority must be one of: low, medium, high' },
    { parameter: 'sort', message: 'sort must be one of: dueDate, priority, createdAt' },
  ];

  it.each(QUERY_PARAMETER_CASES)(
    'rejects an unsupported $parameter value',
    async (testCase: QueryParameterCase) => {
      await seedFixture();
      const url = `/api/tasks?${testCase.parameter}=unsupported`;

      const { body } = await rejectedRequest(api(), () => request(api(), 'GET', url));

      expect(body.error.message).toBe(VALIDATION_ERROR_MESSAGE);
      expect(body.error.fields).toEqual({ [testCase.parameter]: testCase.message });
    },
  );

  it('reports every unsupported query value in one response', async () => {
    await seedFixture();

    const { body } = await rejectedRequest(
      api(),
      () => request(api(), 'GET', '/api/tasks?status=nope&sort=nope'),
    );

    expect(Object.keys(body.error.fields).sort()).toEqual(['sort', 'status']);
  });

  it.each(QUERY_PARAMETER_CASES)(
    'rejects a repeated $parameter parameter',
    async (testCase: QueryParameterCase) => {
      await seedFixture();
      const url = `/api/tasks?${testCase.parameter}=open&${testCase.parameter}=completed`;

      const { body } = await rejectedRequest(api(), () => request(api(), 'GET', url));

      // A parameter supplied twice carries the parameter's own field key and the message the
      // contract fixes for that parameter: the repetition is one of that row's rules, so it is not
      // reported with a wording of its own.
      expect(Object.keys(body.error.fields)).toEqual([testCase.parameter]);
      expect(fieldMessage(body, testCase.parameter)).toBe(testCase.message);
    },
  );
});


describe('task routes (composed application): rejected input', () => {
  beforeEach(async () => {
    await composeForTest('http-tasks-rejected-');
  });

  afterEach(async () => {
    await releaseForTest();
  });

  /**
   * Sends a body as raw text with the matching content type, so a body the parser has to reject can be
   * sent at all — `app.inject` would otherwise serialise a payload object for us.
   */
  async function sendRawBody(
    method: HttpMethod,
    url: string,
    rawBody: string,
  ): Promise<InjectedResponse> {
    return await api().inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      payload: rawBody,
    });
  }

  describe('body-level failures', () => {
    it('rejects a create with no body, with and without a declared JSON content type', async () => {
      // Which layer rejects an absent body depends on the request's declared media type: the
      // content-type parser rejects it first when JSON is declared, and the handler does when nothing
      // is declared. The status and the envelope are the same either way, so the summary alone is
      // accepted as either of the contract's two body-level messages.
      const declared = await rejectedRequest(api(), () =>
        api().inject({
          method: 'POST',
          url: '/api/tasks',
          headers: { 'content-type': 'application/json' },
        }),
      );
      const undeclared = await rejectedRequest(api(), () =>
        api().inject({ method: 'POST', url: '/api/tasks' }),
      );

      for (const { body } of [declared, undeclared]) {
        expect([VALIDATION_ERROR_MESSAGE, MALFORMED_BODY_MESSAGE]).toContain(body.error.message);
        expect(body.error.fields).toEqual({});
      }
    });

    it('rejects a body that is not valid JSON', async () => {
      const { body } = await rejectedRequest(api(), () =>
        sendRawBody('POST', '/api/tasks', '{"title":'),
      );

      expect(body.error.message).toBe(MALFORMED_BODY_MESSAGE);
      expect(body.error.fields).toEqual({});
    });

    it.each(['"title"', '[]', '42', 'null'])(
      'rejects a %s body as the wrong kind of JSON value',
      async (rawBody: string) => {
        const { body } = await rejectedRequest(api(), () =>
          sendRawBody('POST', '/api/tasks', rawBody),
        );

        expect(body.error.message).toBe(MALFORMED_BODY_MESSAGE);
        expect(body.error.fields).toEqual({});
      },
    );

    it('rejects a patch that supplies no field, naming none', async () => {
      const created = await createTask(api(), { title: 'Buy milk' });

      const { body } = await rejectedRequest(api(), () =>
        request(api(), 'PATCH', `/api/tasks/${created.id}`, {}),
      );

      expect(body.error.message).toBe(FIELD_MESSAGES.emptyPatch);
      expect(body.error.fields).toEqual({});
    });

    it('answers an unsupported media type with the framework status, through the contract envelope', async () => {
      // A body declared under a media type the server registers no parser for never reaches the
      // handler: the framework answers it with its own client-error status first. What the client
      // receives is still the one mapping — that status under the contract's validation class, with
      // the contract's envelope and its summary, never the framework's own body or wording, which the
      // envelope check excludes by requiring `error` to be the body's only key and to carry only
      // `code`, `message` and `fields`. `rejectedRequest` additionally asserts the status and that
      // nothing was created.
      const { body } = await rejectedRequest(
        api(),
        () =>
          api().inject({
            method: 'POST',
            url: '/api/tasks',
            headers: { 'content-type': 'application/xml' },
            payload: '<task><title>Buy milk</title></task>',
          }),
        415,
      );

      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe(VALIDATION_ERROR_MESSAGE);
      expect(body.error.fields).toEqual({});
    });
  });

  describe('field-level failures on a create', () => {
    /** One rejected create body, the field it must be reported against and the message it must carry. */
    interface RejectedCreateCase {
      readonly label: string;
      readonly input: Record<string, unknown>;
      readonly field: string;
      readonly message: string;
    }

    /**
     * Every rule a create enforces, one case each, with the message read from the domain's own message
     * record — so a reworded rule fails here rather than passing against a second copy of the string.
     */
    const REJECTED_CREATE_CASES: readonly RejectedCreateCase[] = [
      {
        label: 'a missing title',
        input: {},
        field: 'title',
        message: FIELD_MESSAGES.titleRequired,
      },
      {
        label: 'a whitespace-only title',
        input: { title: '   ' },
        field: 'title',
        message: FIELD_MESSAGES.titleRequired,
      },
      {
        label: 'a 201-character title',
        input: { title: 't'.repeat(201) },
        field: 'title',
        message: FIELD_MESSAGES.titleTooLong,
      },
      {
        label: 'a title that is not a string',
        input: { title: 42 },
        field: 'title',
        message: FIELD_MESSAGES.titleNotString,
      },
      {
        label: 'a null title',
        input: { title: null },
        field: 'title',
        message: FIELD_MESSAGES.titleNotString,
      },
      {
        label: 'a 2001-character description',
        input: { title: 'Buy milk', description: 'd'.repeat(2001) },
        field: 'description',
        message: FIELD_MESSAGES.descriptionTooLong,
      },
      {
        label: 'a description that is not a string',
        input: { title: 'Buy milk', description: 42 },
        field: 'description',
        message: FIELD_MESSAGES.descriptionNotString,
      },
      {
        label: 'a null description',
        input: { title: 'Buy milk', description: null },
        field: 'description',
        message: FIELD_MESSAGES.descriptionNotString,
      },
      {
        label: 'an unsupported priority',
        input: { title: 'Buy milk', priority: 'urgent' },
        field: 'priority',
        message: FIELD_MESSAGES.priorityInvalid,
      },
      {
        label: 'a due date that is not a real calendar date',
        input: { title: 'Buy milk', dueDate: '2026-02-30' },
        field: 'dueDate',
        message: FIELD_MESSAGES.dueDateNotCalendarDate,
      },
      {
        label: 'a due date in the wrong format',
        input: { title: 'Buy milk', dueDate: '2026-2-4' },
        field: 'dueDate',
        message: FIELD_MESSAGES.dueDateInvalidFormat,
      },
      {
        label: 'a completion flag',
        input: { title: 'Buy milk', completed: true },
        field: 'completed',
        message: FIELD_MESSAGES.completedOnCreate,
      },
      {
        label: 'an unknown property',
        input: { title: 'Buy milk', colour: 'red' },
        field: 'colour',
        message: FIELD_MESSAGES.unknownField,
      },
    ];

    it.each(REJECTED_CREATE_CASES)(
      'rejects $label and creates nothing',
      async (testCase: RejectedCreateCase) => {
        const { body } = await rejectedRequest(api(), () =>
          request(api(), 'POST', '/api/tasks', testCase.input),
        );

        expect(Object.keys(body.error.fields)).toEqual([testCase.field]);
        expect(fieldMessage(body, testCase.field)).toBe(testCase.message);
      },
    );
  });

  describe('read-only fields', () => {
    /**
     * The three system-owned fields, as a tuple so the message can be looked up by the field name
     * itself rather than through a second mapping written here.
     */
    const READ_ONLY_FIELDS = ['id', 'createdAt', 'updatedAt'] as const;

    /** A value for one of them, so the rejection is about the field being present at all. */
    const READ_ONLY_VALUES: Readonly<Record<(typeof READ_ONLY_FIELDS)[number], string>> = {
      id: 'not-generated-here',
      createdAt: '2026-02-01T09:15:00.000Z',
      updatedAt: '2026-02-01T09:15:00.000Z',
    };

    it.each(READ_ONLY_FIELDS)('rejects a create body carrying %s', async (field) => {
      const { body } = await rejectedRequest(api(), () =>
        request(api(), 'POST', '/api/tasks', { title: 'Buy milk', [field]: READ_ONLY_VALUES[field] }),
      );

      expect(Object.keys(body.error.fields)).toEqual([field]);
      expect(fieldMessage(body, field)).toBe(FIELD_MESSAGES.readOnly[field]);
    });

    it.each(READ_ONLY_FIELDS)('rejects a patch carrying %s', async (field) => {
      const created = await createTask(api(), { title: 'Buy milk' });

      const { body } = await rejectedRequest(api(), () =>
        request(api(), 'PATCH', `/api/tasks/${created.id}`, { [field]: READ_ONLY_VALUES[field] }),
      );

      expect(Object.keys(body.error.fields)).toEqual([field]);
      expect(fieldMessage(body, field)).toBe(FIELD_MESSAGES.readOnly[field]);
    });
  });

  describe('field-level failures on a patch', () => {
    it.each([
      { label: 'a title that is not a string', patch: { title: 42 }, field: 'title', message: FIELD_MESSAGES.titleNotString },
      { label: 'an empty title', patch: { title: '   ' }, field: 'title', message: FIELD_MESSAGES.titleRequired },
      { label: 'an unsupported priority', patch: { priority: 'urgent' }, field: 'priority', message: FIELD_MESSAGES.priorityInvalid },
      { label: 'a malformed due date', patch: { dueDate: '2026-2-4' }, field: 'dueDate', message: FIELD_MESSAGES.dueDateInvalidFormat },
      { label: 'a completion flag that is not a boolean', patch: { completed: 'true' }, field: 'completed', message: FIELD_MESSAGES.completedNotBoolean },
      { label: 'a null completion flag', patch: { completed: null }, field: 'completed', message: FIELD_MESSAGES.completedNotBoolean },
    ])('rejects $label in a patch', async (testCase: {
      label: string;
      patch: Record<string, unknown>;
      field: string;
      message: string;
    }) => {
      const created = await createTask(api(), { title: 'Buy milk' });

      const { body } = await rejectedRequest(api(), () =>
        request(api(), 'PATCH', `/api/tasks/${created.id}`, testCase.patch),
      );

      expect(Object.keys(body.error.fields)).toEqual([testCase.field]);
      expect(fieldMessage(body, testCase.field)).toBe(testCase.message);
    });
  });
});

describe('task routes (composed application): an identifier that matches no task', () => {
  beforeEach(async () => {
    await composeForTest('http-tasks-not-found-');
  });

  afterEach(async () => {
    await releaseForTest();
  });

  /** An identifier of the shape the create route generates that no task holds. */
  const UNKNOWN_ID = '11111111-2222-4333-8444-555555555555';

  /** One request aimed at an identifier no task holds, with the body its method takes. */
  interface UnknownIdentifierCase {
    readonly label: string;
    readonly method: HttpMethod;
    readonly payload?: Record<string, unknown>;
  }

  const UNKNOWN_IDENTIFIER_CASES: readonly UnknownIdentifierCase[] = [
    { label: 'a read', method: 'GET' },
    { label: 'an update', method: 'PATCH', payload: { title: 'Buy oat milk' } },
    { label: 'a completion change', method: 'PATCH', payload: { completed: true } },
    { label: 'a delete', method: 'DELETE' },
  ];

  it.each(UNKNOWN_IDENTIFIER_CASES)(
    'answers $label of an unknown identifier with 404, naming it',
    async (testCase: UnknownIdentifierCase) => {
      const url = `/api/tasks/${UNKNOWN_ID}`;

      const { body } = await rejectedRequest(
        api(),
        () => request(api(), testCase.method, url, testCase.payload),
        404,
      );

      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.fields).toEqual({});
      expect(body.error.message).toContain(UNKNOWN_ID);
    },
  );

  it('answers a malformed identifier with 404 rather than 400', async () => {
    // No format check exists anywhere on the path parameter, deliberately: a value matching no task
    // must be indistinguishable from one whose task was deleted.
    const { body } = await rejectedRequest(
      api(),
      () => request(api(), 'GET', '/api/tasks/not-a-uuid'),
      404,
    );

    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('not-a-uuid');
  });

  /**
   * The requests whose path ends at the slash, which the router matches with an empty `:id`.
   *
   * The router descends into the parametric child even when nothing follows the slash, so each of
   * these reaches its handler with `params.id === ''` — which is why the empty identifier is
   * accepted as supplied and answered from the task it names, of which there is none.
   */
  const TRAILING_SLASH_CASES: readonly UnknownIdentifierCase[] = [
    { label: 'a read', method: 'GET' },
    { label: 'an update', method: 'PATCH', payload: { title: 'Buy oat milk' } },
    { label: 'a delete', method: 'DELETE' },
  ];

  it.each(TRAILING_SLASH_CASES)(
    'answers $label of the empty identifier a trailing-slash path produces with 404 rather than 400',
    async (testCase: UnknownIdentifierCase) => {
      // The identifier is not missing from the path, it is empty: rejecting it as a missing
      // parameter is what would answer this real request with a 400.
      const { body } = await rejectedRequest(
        api(),
        () => request(api(), testCase.method, '/api/tasks/', testCase.payload),
        404,
      );

      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.fields).toEqual({});
    },
  );

  /**
   * Identifiers longer than the router's own default parameter limit of 100 characters.
   *
   * The contract accepts the identifier as supplied, so its length may not decide the answer: each of
   * these must be answered as an identifier that matches no task, exactly as a short one is.
   */
  const OVER_LONG_IDENTIFIER_LENGTHS: readonly number[] = [101, 120];

  it.each(UNKNOWN_IDENTIFIER_CASES)(
    'answers $label of an over-long identifier with 404, naming it',
    async (testCase: UnknownIdentifierCase) => {
      for (const length of OVER_LONG_IDENTIFIER_LENGTHS) {
        const id = 'a'.repeat(length);

        const { body } = await rejectedRequest(
          api(),
          () => request(api(), testCase.method, `/api/tasks/${id}`, testCase.payload),
          404,
        );

        expect(body.error.code).toBe('NOT_FOUND');
        expect(body.error.fields).toEqual({});
        expect(body.error.message).toContain(id);
      }
    },
  );

  it('answers the identifier of a deleted task with 404', async () => {
    const created = await createTask(api(), { title: 'Buy milk' });
    await deleteTask(api(), created.id);

    const { body } = await rejectedRequest(
      api(),
      () => request(api(), 'GET', `/api/tasks/${created.id}`),
      404,
    );

    expect(body.error.message).toContain(created.id);
  });

  /** A request whose method and path match no route at all. */
  interface UnmatchedRouteCase {
    readonly label: string;
    readonly method: HttpMethod;
    readonly url: string;
  }

  const UNMATCHED_ROUTE_CASES: readonly UnmatchedRouteCase[] = [
    { label: 'a path outside the API', method: 'GET', url: '/api/nope' },
    { label: 'a path outside the API', method: 'GET', url: '/api/tasks/nested/deeper' },
    { label: 'a method the task path does not serve', method: 'PUT', url: `/api/tasks/${UNKNOWN_ID}` },
    { label: 'a method the task path does not serve', method: 'POST', url: `/api/tasks/${UNKNOWN_ID}` },
  ];

  it.each(UNMATCHED_ROUTE_CASES)(
    'answers $label ($method $url) with 404 naming the method and the path, never with 405',
    async (testCase: UnmatchedRouteCase) => {
      const { body } = await rejectedRequest(
        api(),
        () => request(api(), testCase.method, testCase.url),
        404,
      );

      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.fields).toEqual({});
      expect(body.error.message).toContain(testCase.method);
      expect(body.error.message).toContain(testCase.url);
    },
  );
});

/** One raw HTTP response, read off a real socket rather than through the in-process injector. */
interface RawHttpResponse {
  /** The status line exactly as the transport wrote it, e.g. `431 Request Header Fields Too Large`. */
  readonly statusLine: string;
  /** The response headers, keyed by their lower-cased name and flattened to a string. */
  readonly headers: Record<string, string>;
  /** The response body: everything after the blank line that ends the headers. */
  readonly body: string;
}

/**
 * Delivers one request over a real socket and reads the whole response back verbatim.
 *
 * A request the transport refuses before a request exists cannot be delivered through `app.inject()`,
 * which runs the request through the router, so the transport's own paths are driven over a genuine
 * connection. The socket is destroyed in the `finally`, so a case that fails an assertion leaves no
 * connection open.
 *
 * @param port The bound port of the application under test.
 * @param requestLine The request line to send, without its trailing CRLF.
 */
async function rawHttpExchange(port: number, requestLine: string): Promise<RawHttpResponse> {
  const socket = connect({ port, host: '127.0.0.1' });
  const chunks: Buffer[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      socket.on('close', () => {
        resolve();
      });
      socket.once('connect', () => {
        socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\n\r\n`);
      });
    });
  } finally {
    socket.destroy();
  }

  const received = Buffer.concat(chunks).toString('utf8');
  const separator = received.indexOf('\r\n\r\n');
  const head = separator === -1 ? received : received.slice(0, separator);
  const [statusLine = '', ...headerLines] = head.split('\r\n');

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon !== -1) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }

  return {
    statusLine,
    headers,
    body: separator === -1 ? '' : received.slice(separator + 4),
  };
}


describe('task routes (composed application): the served surface', () => {
  beforeEach(async () => {
    await composeForTest('http-tasks-surface-');
  });

  afterEach(async () => {
    await releaseForTest();
  });

  it('answers a path that cannot be percent-decoded with the contract 400, not the framework body', async () => {
    // The router hands a path it cannot decode to the factory's own framework error handler rather
    // than answering it itself, so the failure arrives through the one mapping like every other.
    const { response, body } = await rejectedRequest(
      api(),
      () => request(api(), 'GET', '/api/tasks/%zz'),
      400,
    );

    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields).toEqual({});
    expect(body.error.message).toBe(VALIDATION_ERROR_MESSAGE);
    // The framework's own code and its own wording are internal detail: the mapping keeps the status
    // and the failure class, and nothing else about the failure reaches the client.
    expect(response.body).not.toContain('FST_ERR_BAD_URL');
    expect(response.body).not.toContain('is not a valid url component');
  });

  it('answers an over-long request line with the contract 431, not the framework body', async () => {
    // A request line past Node's own limit is refused by the transport before it becomes a request, so
    // it reaches neither a route nor the error handler nor the framework's framework-error channel:
    // `app.inject()` runs the request through the router and cannot deliver it, and a real connection
    // is the only way to drive the path.
    const app = api();
    await app.listen({ port: 0, host: '127.0.0.1' });

    const bound = app.server.address();
    if (typeof bound !== 'object' || bound === null) {
      throw new Error('The application did not bind a TCP address');
    }
    const address: AddressInfo = bound;

    const response = await rawHttpExchange(
      address.port,
      `GET /api/tasks/${'a'.repeat(20_000)} HTTP/1.1`,
    );

    // The raw status line, version included, so the reason phrase is asserted as the transport wrote
    // it rather than only its first token.
    expect(response.statusLine).toBe('HTTP/1.1 431 Request Header Fields Too Large');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');

    const body = expectErrorEnvelope(JSON.parse(response.body), 431);
    expect(body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE, fields: {} },
    });
    // The framework's own wording and its status key must not ride along beside the envelope.
    expect(response.body).not.toContain('Exceeded maximum allowed HTTP header size');
    expect(response.body).not.toContain('"statusCode"');

    // A long identifier the transport can still deliver has to reach the router and be answered as a
    // missing task: the bound is Node's own request-line size, not the router refusing a long
    // parameter before any route saw it.
    const { body: control } = await rejectedRequest(api(), () =>
      request(api(), 'GET', `/api/tasks/${'a'.repeat(8000)}`),
      404,
    );
    expect(control.error.code).toBe('NOT_FOUND');
  });

  /** A GET route the contract publishes, each of which must have no HEAD twin registered. */
  interface ServedRouteCase {
    readonly label: string;
    readonly url: string;
  }

  const SERVED_ROUTE_CASES: readonly ServedRouteCase[] = [
    { label: 'the task list', url: '/api/tasks' },
    { label: 'the health route', url: '/api/health' },
  ];

  it.each(SERVED_ROUTE_CASES)(
    'answers HEAD of $label with 404 naming the method and the path, and still serves its GET',
    async (testCase: ServedRouteCase) => {
      // The contract publishes six endpoints and defines no HEAD of any of them, so a HEAD has to
      // fall to the not-found handler — which is what proves no HEAD twin was registered beside the
      // GET route.
      const { body } = await rejectedRequest(api(), () => request(api(), 'HEAD', testCase.url), 404);

      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.fields).toEqual({});
      expect(body.error.message).toContain('HEAD');
      expect(body.error.message).toContain(testCase.url);

      expect((await request(api(), 'GET', testCase.url)).statusCode).toBe(200);
    },
  );

  it('answers HEAD of the single-task route with 404 rather than serving a HEAD twin of it', async () => {
    const created = await createTask(api(), { title: 'Buy milk' });

    const { body } = await rejectedRequest(
      api(),
      () => request(api(), 'HEAD', `/api/tasks/${created.id}`),
      404,
    );

    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('HEAD');
    expect(body.error.message).toContain(`/api/tasks/${created.id}`);

    // A registered twin would have answered this HEAD with the task it read; the route's own GET
    // still answers it, so the 404 above is the surface and not a missing task.
    expect((await readTask(api(), created.id)).id).toBe(created.id);
  });
});


describe('task routes (storage failure)', () => {
  /**
   * The storage stub every request in this subject reaches.
   *
   * No database is reserved here, deliberately: `buildApp` opens no file and the stub replaces the only
   * module that would, so a temporary database would be a fixture nothing uses.
   */
  const repository = new ThrowingTaskRepository();

  /** The application whose every use case reaches the stub, built once for the subject. */
  let failureApp: FastifyApp;

  /** The identifier the parameterized cases address; the stub fails whatever it is. */
  const ADDRESSED_ID = '11111111-2222-4333-8444-555555555555';

  beforeAll(async () => {
    // `error`, not `silent`: the 500 path has to be seen to log its cause, and nothing below error
    // level is of interest to this subject.
    const options: BuildAppOptions = { logLevel: 'error' };
    failureApp = buildApp(storageFailureDependencies(repository), options);
    await failureApp.ready();
  });

  afterAll(async () => {
    await failureApp.close();
  });

  beforeEach(() => {
    // Reset per test, so "the stub was reached" is asserted against the calls of that test alone.
    repository.calls = 0;
  });

  it('answers a list request with the generic 500 and logs its cause', async () => {
    const { response, captured } = await requestCapturingLog(failureApp, () =>
      failureApp.inject({ method: 'GET', url: '/api/tasks' }),
    );

    expectInternalError(response, [STUB_FAILURE_MESSAGE]);
    // The port method really was reached, so a 500 produced by anything else — a routing mistake, a
    // missing handler — cannot pass this test even if the record format changes.
    expect(repository.calls).toBeGreaterThan(0);
    expectLoggedCause(captured, STUB_FAILURE_MESSAGE);
  });

  it('answers a create request with the generic 500 and logs its cause', async () => {
    const { response, captured } = await requestCapturingLog(failureApp, () =>
      request(failureApp, 'POST', '/api/tasks', { title: 'Buy milk' }),
    );

    expectInternalError(response, [STUB_FAILURE_MESSAGE]);
    expect(repository.calls).toBeGreaterThan(0);
    expectLoggedCause(captured, STUB_FAILURE_MESSAGE);
  });

  it('logs the request context along with the cause of a 500', async () => {
    const { response, captured } = await requestCapturingLog(failureApp, () =>
      request(failureApp, 'GET', `/api/tasks/${ADDRESSED_ID}`),
    );

    expectInternalError(response, [STUB_FAILURE_MESSAGE]);

    const carriers = parseLogRecords(captured).filter(
      (record) =>
        record['level'] === PINO_ERROR_LEVEL && JSON.stringify(record).includes(STUB_FAILURE_MESSAGE),
    );
    expect(carriers).not.toHaveLength(0);

    // The failure record carries the request context itself, so an operator reading the log can see
    // which request failed.
    for (const record of carriers) {
      expect(record['method']).toBe('GET');
      expect(record['url']).toBe(`/api/tasks/${ADDRESSED_ID}`);
    }
  });

  /** One request aimed at a single task, so every remaining route's failure path is covered too. */
  interface FailingRequestCase {
    readonly label: string;
    readonly method: HttpMethod;
    readonly url: string;
    readonly payload?: Record<string, unknown>;
  }

  const FAILING_REQUEST_CASES: readonly FailingRequestCase[] = [
    { label: 'reading one task', method: 'GET', url: `/api/tasks/${ADDRESSED_ID}` },
    {
      label: 'updating a task',
      method: 'PATCH',
      url: `/api/tasks/${ADDRESSED_ID}`,
      payload: { title: 'Buy oat milk' },
    },
    {
      label: 'changing the completion of a task',
      method: 'PATCH',
      url: `/api/tasks/${ADDRESSED_ID}`,
      payload: { completed: true },
    },
    { label: 'deleting a task', method: 'DELETE', url: `/api/tasks/${ADDRESSED_ID}` },
  ];

  it.each(FAILING_REQUEST_CASES)(
    'answers $label with the same generic 500 when storage fails',
    async (testCase: FailingRequestCase) => {
      const { response } = await requestCapturingLog(failureApp, () =>
        request(failureApp, testCase.method, testCase.url, testCase.payload),
      );

      expectInternalError(response, [STUB_FAILURE_MESSAGE]);
      expect(repository.calls).toBeGreaterThan(0);
    },
  );
});

describe('task routes (storage failure in the composed application)', () => {
  beforeEach(async () => {
    // The real log level rather than `silent`: this composition is the one the process serves, so its
    // 500 path has to be seen to log the cause it really met.
    await composeForTest('http-tasks-storage-failure-', 'error');
  });

  afterEach(async () => {
    await releaseForTest();
  });

  /**
   * Makes the composed application's storage fail for real.
   *
   * The application's own connection is left untouched. A second connection to the same file drops the
   * table, so the next statement the adapter runs fails with a genuine SQLite error — the shape of
   * failure a running process meets — and no production module is altered to produce it.
   */
  function dropStoredTasks(): void {
    const other: DatabaseHandle = openDatabase(composedDatabasePath());
    try {
      other.exec('DROP TABLE tasks');
    } finally {
      other.close();
    }
  }

  it('answers a list request with the generic 500 and logs the SQLite failure', async () => {
    dropStoredTasks();

    const { response, captured } = await requestCapturingLog(api(), () =>
      request(api(), 'GET', '/api/tasks'),
    );

    // SQLite's own wording and its error class are what the body must not disclose; both appear in the
    // log record below, which is where the operator reads the cause.
    expectInternalError(response, ['no such table', 'SQLITE']);
    expectLoggedCause(captured, 'no such table');
  });

  it('answers a create request with the generic 500 and logs the SQLite failure', async () => {
    dropStoredTasks();

    const { response, captured } = await requestCapturingLog(api(), () =>
      request(api(), 'POST', '/api/tasks', { title: 'Buy milk' }),
    );

    expectInternalError(response, ['no such table', 'SQLITE']);
    expectLoggedCause(captured, 'no such table');
  });
});


describe('task routes (composed application): what a request writes to the log', () => {
  beforeEach(async () => {
    // The level the process serves at, not `silent`: the subject is that a successful request writes
    // nothing at all, which a silently configured logger could not show.
    await composeForTest('http-tasks-logging-', 'info');
  });

  afterEach(async () => {
    await releaseForTest();
  });

  it('writes no log record for a successful health, list or create request', async () => {
    const captured = await captureLogOutput(api(), async () => {
      // One request of each successful kind: the liveness read, the listing read and a write. The
      // contract requires silence for all three, and a per-request record would name the URL of the
      // write's task on the read that follows it.
      expect((await request(api(), 'GET', '/api/health')).statusCode).toBe(200);
      expect((await request(api(), 'GET', '/api/tasks')).statusCode).toBe(200);
      expect((await request(api(), 'POST', '/api/tasks', { title: 'Buy milk' })).statusCode).toBe(201);
    });

    expect(
      parseLogRecords(captured),
      `Expected nothing to be logged on the success path. Captured output: ${captured === '' ? '(nothing)' : captured}`,
    ).toEqual([]);
  });
});

