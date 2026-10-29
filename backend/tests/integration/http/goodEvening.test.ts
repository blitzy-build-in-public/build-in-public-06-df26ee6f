/**
 * Integration suite for the API's greeting route: `GET /good-evening`.
 *
 * What is asserted, and why it is worth a suite of its own. The route answers 200 with exactly
 * `Good evening` under exactly `Content-Type: text/plain`, and nothing else: it reads no storage,
 * requires no credential and reports nothing about the process. The media type is the assertion this
 * file exists for. A string payload sent without a content type is answered by the framework as
 * `text/plain; charset=utf-8`, so the handler states `text/plain` on the reply itself; comparing the
 * header by exact equality — rather than asking whether it merely contains `text/plain` — is what
 * makes that call's removal fail here instead of passing quietly. The body is compared against the
 * literal, so an envelope, a wrapper or a trailing newline fails here rather than at a client.
 *
 * The path is a contract of its own, outside the `/api` prefix the other six routes share. The
 * request fixes it, and the API's own port is where it is served; the Vite development server
 * forwards only `/api` to this API, so the endpoint is a direct-call surface rather than one reachable
 * through the browser's origin. A trailing slash, a case change and the same path under `/api` each
 * match nothing, which is what pins the route to its exact path rather than leaving it to convention.
 *
 * The method behaviour is one GET with no HEAD twin and no 405: the factory switches the framework's
 * HEAD twins off for the whole instance, and the error contract deliberately defines no 405, so a POST
 * or a HEAD of this path falls to the not-found handler and is answered with the contract's 404
 * envelope. An injected HEAD does carry the buffered body, which is how the envelope is read below;
 * the same request against a real socket shows a content length and no body, because Node transmits no
 * body for HEAD. The route restates none of the application's shared behaviour: the response-hardening
 * hook and the one error mapping reach it by registration, so only their effects are asserted here.
 *
 * How it runs. The suite drives the real object graph through `composeApp`, the one module
 * permitted to wire infrastructure into the HTTP layer, over a database file reserved per test by
 * `../../support/tempDatabase.ts`: never the developer's `backend/data/todo.db`. Every request goes
 * through `app.inject()`, so nothing here binds a socket, reaches the network or reads an environment
 * variable; no timestamp is asserted, so no assertion depends on the wall clock, and nothing on any
 * path below logs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeApp, type AppConfig } from '../../../src/main.js';
import { buildApp } from '../../../src/interface/http/buildApp.js';
import { createTempDatabase, type TempDatabase } from '../../support/tempDatabase.js';

/** The greeting route's path, named once so every request and assertion uses the same string. */
const GOOD_EVENING_PATH = '/good-evening';

/** The same path with its case changed, which matches no route: case is part of the contract. */
const CASE_CHANGED_PATH = '/Good-Evening';

/**
 * The greeting path under the `/api` prefix the other six routes share. It matches nothing, which is
 * what pins the new route to its own unprefixed path instead of inside the API's prefix.
 */
const PREFIXED_MISS_PATH = '/api/good-evening';

/** The liveness route, asserted by the preservation case against its unchanged contract. */
const HEALTH_PATH = '/api/health';

/** The listing route, asserted by the preservation case against its unchanged contract. */
const TASKS_PATH = '/api/tasks';

/** A path no route of the API publishes, asserted against the error contract's 404. */
const UNMATCHED_PATH = '/no-such-route';

/** The one body the greeting route may answer with: the literal, with no envelope and no newline. */
const EXPECTED_GOOD_EVENING_BODY = 'Good evening';

/**
 * The one body the liveness route may answer with.
 *
 * Held as a constant and asserted together with `Object.keys`, so a body that grew a version or a
 * task count fails here rather than passing on `status` alone.
 */
const EXPECTED_HEALTH_BODY = { status: 'ok' };

/**
 * The exact response media type the greeting route must answer with.
 *
 * The handler states it on the reply; a string payload sent without one is answered as
 * `text/plain; charset=utf-8`, which is why the assertion below compares the whole header value.
 */
const PLAIN_TEXT_MEDIA_TYPE = 'text/plain';

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
  /** The response body exactly as it was sent, which is what a plain-text contract has to read. */
  readonly body: string;
  /** The response body parsed as JSON. */
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
 * Reads a parsed response body as the plain JSON object the routes answer with.
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
 * @throws Error when the body is not the contract's envelope, so a method or path that answered
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
 * The greeting route over the real object graph: the database, the SQLite adapter, the six use cases
 * and the HTTP application, composed by `composeApp` exactly as the process composes them.
 *
 * A fresh composition and a fresh database file per test, so the preservation case below asks the
 * same application the greeting cases do, and no test's data reaches another's.
 */
describe('GET /good-evening (composed application)', () => {
  beforeEach(async () => {
    const reserved = createTempDatabase('http-good-evening-');
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

    // Awaited for explicitness, so the seven routes — the greeting route included — are in place
    // before the first request is injected rather than at the moment it is.
    await composed.app.ready();
  });

  afterEach(async () => {
    await releaseResources('Releasing the good-evening suite resources failed.');
  });

  it('answers 200 with exactly "Good evening" and a text/plain media type', async () => {
    const application = requireApp();

    const response = await application.inject({ method: 'GET', url: GOOD_EVENING_PATH });

    expect(response.statusCode).toBe(200);

    // The header is compared by exact equality rather than by containment: the handler states
    // `text/plain` on the reply itself, and without that call the framework answers this string
    // payload as `text/plain; charset=utf-8`, which this assertion fails on.
    expect(headerValue(response, 'content-type')).toBe(PLAIN_TEXT_MEDIA_TYPE);

    // The body is the string itself — no envelope, no wrapper, no trailing newline — so a client
    // reads exactly the words the contract names and nothing beside them.
    expect(response.body).toBe(EXPECTED_GOOD_EVENING_BODY);

    // The route states none of the application's shared behaviour, so the hardening policy reaches
    // this reply only by registration: one `onSend` hook covers every response the router dispatches.
    // Asserted on the route's own 200 rather than left to the replies the hook cannot reach.
    expect(headerValue(response, 'x-content-type-options')).toBe('nosniff');
    expect(headerValue(response, 'x-frame-options')).toBe('DENY');
    expect(headerValue(response, 'cache-control')).toBe('no-store');
  });

  it('answers consecutive requests with identical status, media type and body', async () => {
    const application = requireApp();

    const first = await application.inject({ method: 'GET', url: GOOD_EVENING_PATH });
    const second = await application.inject({ method: 'GET', url: GOOD_EVENING_PATH });

    expect(first.statusCode).toBe(200);
    expect(first.body).toBe(EXPECTED_GOOD_EVENING_BODY);

    // No first-call-only behaviour and no accumulated state between requests: the second answer is
    // the first answer, which is what makes the route safe to call as often as a caller likes.
    expect(second.statusCode).toBe(first.statusCode);
    expect(headerValue(second, 'content-type')).toBe(headerValue(first, 'content-type'));
    expect(second.body).toBe(first.body);
  });

  it('answers the exact path, leaving a trailing slash, a case change and an unmatched path to the not-found handler', async () => {
    const application = requireApp();

    // The path itself is the route the contract publishes ...
    const exact = await application.inject({ method: 'GET', url: GOOD_EVENING_PATH });
    expect(exact.statusCode).toBe(200);

    // ... and its query string is not part of it: the router matches the path and hands the query to
    // the route, which reads nothing from the request at all.
    const withQuery = await application.inject({ method: 'GET', url: `${GOOD_EVENING_PATH}?x=1` });
    expect(withQuery.statusCode).toBe(200);
    expect(withQuery.body).toBe(EXPECTED_GOOD_EVENING_BODY);

    // Each of the three below matches no route, so the not-found handler `buildApp` installs answers
    // it with the error contract's 404 rather than with a body of its own. A route answering any of
    // them would have turned an exact path into a pattern.
    const trailingSlash = await application.inject({ method: 'GET', url: `${GOOD_EVENING_PATH}/` });
    expect(trailingSlash.statusCode).toBe(404);
    expect(errorCodeFrom(trailingSlash)).toBe('NOT_FOUND');

    const caseChanged = await application.inject({ method: 'GET', url: CASE_CHANGED_PATH });
    expect(caseChanged.statusCode).toBe(404);
    expect(errorCodeFrom(caseChanged)).toBe('NOT_FOUND');

    const prefixed = await application.inject({ method: 'GET', url: PREFIXED_MISS_PATH });
    expect(prefixed.statusCode).toBe(404);
    expect(errorCodeFrom(prefixed)).toBe('NOT_FOUND');
  });

  it('answers POST of the new path with the not-found contract and no 405', async () => {
    const application = requireApp();

    const response = await application.inject({ method: 'POST', url: GOOD_EVENING_PATH });

    // The method belongs to the route rather than to the handler, so the handler is never reached
    // here; and because the contract defines no 405, the answer is the same 404 an unknown path gets
    // rather than a method-specific status.
    expect(response.statusCode).toBe(404);
    expect(errorCodeFrom(response)).toBe('NOT_FOUND');
  });

  it('answers HEAD of the new path with the not-found contract and still serves its GET', async () => {
    const application = requireApp();

    const response = await application.inject({ method: 'HEAD', url: GOOD_EVENING_PATH });

    // The contract publishes seven endpoints and defines no HEAD of any of them, so a HEAD has to
    // fall to the not-found handler — which is what proves no HEAD twin was registered beside the
    // greeting route.
    expect(response.statusCode).toBe(404);
    expect(errorCodeFrom(response)).toBe('NOT_FOUND');

    const envelope = jsonObjectFrom(response);
    const error = envelope['error'];

    if (!isJsonObject(error)) {
      throw new Error(
        `The response body is not the error contract's envelope: ${JSON.stringify(envelope)}`,
      );
    }

    // The envelope in full: no field to report, and a message naming the method and the path that
    // matched nothing, which is what distinguishes an unregistered method from a missing task.
    expect(error['fields']).toStrictEqual({});
    expect(error['message']).toContain('HEAD');
    expect(error['message']).toContain(GOOD_EVENING_PATH);

    // The GET the twin was never registered for still answers, so nothing above rests on the route
    // having been disturbed by the HEAD that preceded it.
    const get = await application.inject({ method: 'GET', url: GOOD_EVENING_PATH });
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe(EXPECTED_GOOD_EVENING_BODY);
  });

  it('leaves the existing endpoints serving in the same composition', async () => {
    const application = requireApp();

    // The liveness route, byte-for-byte the body it answered before the greeting route existed:
    // `Object.keys` is asserted separately, so a body that grew a version or a task count fails here
    // instead of passing on `status` alone.
    const health = await application.inject({ method: 'GET', url: HEALTH_PATH });
    expect(health.statusCode).toBe(200);

    const healthBody = jsonObjectFrom(health);
    expect(Object.keys(healthBody)).toStrictEqual(['status']);
    expect(healthBody).toStrictEqual(EXPECTED_HEALTH_BODY);

    // The listing route still answers a JSON array; what a task looks like is the task routes' own
    // suite's business, so this suite reads the shape alone.
    const listing = await application.inject({ method: 'GET', url: TASKS_PATH });
    expect(listing.statusCode).toBe(200);
    expect(Array.isArray(listing.json())).toBe(true);

    // A path no route matches still gets the contract's 404, so the greeting route was added beside
    // the existing handlers rather than in front of them.
    const unmatched = await application.inject({ method: 'GET', url: UNMATCHED_PATH });
    expect(unmatched.statusCode).toBe(404);
    expect(errorCodeFrom(unmatched)).toBe('NOT_FOUND');
  });

  it('starts the application with every route registered, without binding a socket', async () => {
    const application = requireApp();

    // The application is the one the process itself serves from, composed over the real migrations
    // and use cases, so the request below answers only because the factory registered the greeting
    // route beside the six existing ones before the composition returned.
    await application.ready();

    const response = await application.inject({ method: 'GET', url: GOOD_EVENING_PATH });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(EXPECTED_GOOD_EVENING_BODY);

    // The direct evidence that this suite drives the application in-process: nothing here bound a
    // socket or took a port from the host the parallel clones share.
    expect(application.server.listening).toBe(false);
  });
});
