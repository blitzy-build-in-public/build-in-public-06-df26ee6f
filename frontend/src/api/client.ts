/**
 * The browser application's HTTP client — the only module in `frontend/src` that calls `fetch`.
 *
 * Every request the interface makes goes through this file: it owns the routes, the query string,
 * the request bodies and the translation of every failure into one error type. `App.tsx`
 * constructs a single client with `createTaskApi()` and hands it to `useTasks`; components never
 * reach the API, which is what the `frontend-components-not-to-api-client` architecture rule
 * enforces.
 *
 * Two properties of the base URL are load-bearing. It stays relative (`/api` by default): the Vite
 * development server proxies every `/api` request to the API process, and `preview.proxy` inherits
 * the same entry for the built bundle, so no request may name a scheme or a host. And `fetch` is
 * read off the global scope at call time rather than captured in a binding, so a test that
 * replaces the global sees its replacement.
 *
 * The client performs exactly one request per call and reports what the server said. It caches
 * nothing, applies no optimistic update and re-implements none of the server's validation: the
 * field messages a rejected request returns are carried back unaltered, so a form can place each
 * beside the control it belongs to.
 */

import type { CreateTaskInput, Task, TaskFilters, UpdateTaskInput } from './types';

/**
 * The three failure classes the error contract defines: a rejected request, an unknown task or
 * route, and an internal failure. A caller may branch on these values.
 *
 * It is this module's own declaration of the union `ApiErrorBody` declares in `./types`, which is
 * what keeps the two character-identical.
 */
type ApiErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR';

/**
 * Reported when a request never reached the server at all: an unreachable API, an aborted request,
 * a DNS failure. It is the client's own sentence, because no server response carried one.
 */
const NETWORK_FAILURE_MESSAGE =
  'The server could not be reached. Check that it is running, then try again.';

/**
 * Reported when a successful response carried no readable JSON body. Generic by construction: such
 * a body may come from a proxy rather than the API, so nothing about it is safe to repeat.
 */
const UNREADABLE_BODY_MESSAGE = 'The server returned a response that could not be read.';

/** Sent on every request, including the ones that carry no body. */
const ACCEPT_JSON: Record<string, string> = { Accept: 'application/json' };

/** Sent on every request that carries a JSON body. */
const JSON_BODY_HEADERS: Record<string, string> = {
  ...ACCEPT_JSON,
  'Content-Type': 'application/json',
};

/**
 * Every failure this client can report, in one type: a rejected request, an unknown task, a
 * server-side failure, and a request that never reached the server.
 *
 * `useTasks` branches on `instanceof ApiError` to decide what to show, so no other error type ever
 * escapes this module — not a `DOMException` from an aborted request, not a `TypeError` from an
 * unreachable server, not a JSON syntax error from an unreadable body.
 */
export class ApiError extends Error {
  /** The HTTP status of the failure, or `0` when the request never reached the server. */
  readonly status: number;

  /** The failure class, which a caller may branch on. */
  readonly code: ApiErrorCode;

  /**
   * Field-level messages, keyed by the name of the control each belongs beside. Always an object,
   * and `{}` for a failure that belongs to no single field, so a caller can read it without
   * checking and without losing the server's wording.
   */
  readonly fields: Record<string, string>;

  /**
   * @param status - The HTTP status, or `0` for a request that never reached the server.
   * @param code - The failure class.
   * @param message - A short summary safe to display. It is the server's own message whenever the
   *   failure response carried one, and a generic sentence when it did not.
   * @param fields - Field-level messages; `{}` when the failure belongs to no single field.
   * @param options - Standard error options, used only to attach the underlying failure as `cause`
   *   for a developer reading a test failure. It never reaches `message`.
   */
  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    fields: Record<string, string> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/** Whether a parsed JSON value is an object, excluding `null` and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is one of the three failure classes the contract defines. */
function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return value === 'VALIDATION_ERROR' || value === 'NOT_FOUND' || value === 'INTERNAL_ERROR';
}

/** Keeps the string entries of a field map, so an absent or malformed one becomes an empty map. */
function toFieldMap(value: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!isRecord(value)) {
    return fields;
  }
  for (const [field, message] of Object.entries(value)) {
    if (typeof message === 'string') {
      fields[field] = message;
    }
  }
  return fields;
}

/**
 * The failure class paired with a status, for a response whose body could not be read as the error
 * envelope. `400` is a rejected request, `404` an unknown task or route, and everything else an
 * internal failure.
 */
function codeForStatus(status: number): ApiErrorCode {
  if (status === 400) {
    return 'VALIDATION_ERROR';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  return 'INTERNAL_ERROR';
}

/**
 * The message for a response whose body carried no readable envelope — a proxy error page, a
 * truncated body, HTML. One short sentence per class of failure, and deliberately free of any
 * internal detail: no stack, no driver message, no file path and no record data. A failure body
 * that *is* readable always supplies the server's own message instead of this one.
 */
function fallbackMessage(status: number): string {
  if (status === 400) {
    return 'The request was rejected. Check the values you supplied and try again.';
  }
  if (status === 404) {
    return 'The requested item no longer exists on the server.';
  }
  return 'The server could not complete the request. Try again in a moment.';
}

/**
 * Translates a non-2xx response into the `ApiError` the contract describes.
 *
 * A body that parses as the error envelope supplies the code, the displayable message and the field
 * messages. The envelope is narrowed rather than asserted from the wire type, so a response that
 * omits or malforms `fields` still yields `fields: {}` and a caller can read it unconditionally,
 * and a body that is absent or unreadable yields a class derived from the status with one short
 * generic sentence: nothing internal is ever surfaced to the caller.
 */
function toApiError(value: unknown, status: number): ApiError {
  const outer: Record<string, unknown> = isRecord(value) ? value : {};
  const envelope: Record<string, unknown> = isRecord(outer['error']) ? outer['error'] : {};

  const rawCode = envelope['code'];
  const rawMessage = envelope['message'];

  return new ApiError(
    status,
    isApiErrorCode(rawCode) ? rawCode : codeForStatus(status),
    typeof rawMessage === 'string' && rawMessage !== '' ? rawMessage : fallbackMessage(status),
    toFieldMap(envelope['fields']),
  );
}

/**
 * Reads a response body as JSON, resolving `undefined` when the body is empty or is not JSON at
 * all. Tolerance is the point: a failure body is untrusted, and a `204` has nothing to parse.
 */
async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Issues one request against the client's base and resolves with its response, translating every
 * failure into an `ApiError` first: a rejection from `fetch` itself — an unreachable server, an
 * aborted request, a DNS failure — becomes a `status: 0` failure, and any non-2xx status becomes
 * the failure its body or its status describes.
 *
 * Any 2xx status is a success, so a route may answer 200, 201 or 204 without this module having to
 * know which one it chose.
 */
async function send(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    // Read off the global scope at call time, never captured in a module-scope binding: a test
    // replaces `fetch` before it constructs the client and expects this call to see it.
    response = await fetch(path, init);
  } catch (cause) {
    throw new ApiError(0, 'INTERNAL_ERROR', NETWORK_FAILURE_MESSAGE, {}, { cause });
  }

  if (!response.ok) {
    throw toApiError(await readJsonBody(response), response.status);
  }

  return response;
}

/**
 * Reads the body of a successful response, throwing a generic `ApiError` when there is nothing
 * readable in it rather than letting a JSON syntax error escape the module.
 */
async function readBody(response: Response): Promise<unknown> {
  const body = await readJsonBody(response);
  if (body === undefined) {
    throw new ApiError(response.status, 'INTERNAL_ERROR', UNREADABLE_BODY_MESSAGE);
  }
  return body;
}

/**
 * Narrows a successful list response to the array the route returns.
 *
 * The check made here is the container kind, which is what a caller's iteration needs; the shape of
 * each task is the documented wire contract, whose only producer is the server.
 */
function isTaskList(body: unknown): body is Task[] {
  return Array.isArray(body);
}

/** Narrows a successful single-task response; see `isTaskList` for what the check covers. */
function isTask(body: unknown): body is Task {
  return isRecord(body);
}

/** Narrows the health response to the single field its contract declares. */
function isHealthBody(body: unknown): body is { status: string } {
  return isRecord(body) && typeof body['status'] === 'string';
}

/** Reads the array of tasks a successful list response resolved with. */
async function readTaskList(response: Response): Promise<Task[]> {
  const body = await readBody(response);
  if (!isTaskList(body)) {
    throw new ApiError(response.status, 'INTERNAL_ERROR', UNREADABLE_BODY_MESSAGE);
  }
  return body;
}

/** Reads the task a successful create, update or toggle response resolved with. */
async function readTask(response: Response): Promise<Task> {
  const body = await readBody(response);
  if (!isTask(body)) {
    throw new ApiError(response.status, 'INTERNAL_ERROR', UNREADABLE_BODY_MESSAGE);
  }
  return body;
}

/**
 * The task API as the browser uses it: one method per operation, each resolving with what the
 * server committed.
 *
 * This is a plain structural interface on purpose. `App.tsx` builds the one implementation through
 * `createTaskApi()`, `useTasks` accepts it as a parameter, and the tests hand it an object literal
 * of fakes, so an implementation is any object with these six methods — no class, no brand, no
 * member a caller has to supply to satisfy the type.
 *
 * There is no single-task read: every screen is driven by the list, so a task is refreshed by
 * refetching the list rather than by reading it back by id.
 */
export interface TaskApi {
  /**
   * Lists tasks, filtered and sorted by the server — `GET /api/tasks?status=&priority=&sort=`.
   *
   * All three query parameters are always sent, in that order. "All priorities" is sent as an empty
   * `priority` value, which an empty or absent parameter means to the server: its default. Filtering
   * and sorting therefore live in exactly one place, and the interface holds no ordering of its own.
   */
  listTasks(filters: TaskFilters): Promise<Task[]>;

  /** Creates a task — `POST /api/tasks` — resolving with the created task. */
  createTask(input: CreateTaskInput): Promise<Task>;

  /**
   * Applies the supplied fields to one task — `PATCH /api/tasks/:id` — resolving with the updated
   * task.
   *
   * The patch is sent exactly as given, so the server stays the only validator: an empty patch
   * reaches it, and its 400 comes back as an `ApiError` rather than being prevented here.
   */
  updateTask(id: string, patch: UpdateTaskInput): Promise<Task>;

  /**
   * Completes or reopens one task — `PATCH /api/tasks/:id` with `{ completed }` alone.
   *
   * A body carrying only `completed` is what the server routes to its completion use case, which is
   * why the toggle is a method of its own rather than a patch a caller assembles.
   */
  toggleTask(id: string, completed: boolean): Promise<Task>;

  /** Deletes one task — `DELETE /api/tasks/:id` — resolving with nothing on `204`. */
  deleteTask(id: string): Promise<void>;

  /** Reports whether the API process is serving requests — `GET /api/health`. */
  getHealth(): Promise<{ status: string }>;
}

/**
 * Creates the task API client, whose every request is relative to `baseUrl`.
 *
 * The default relative `/api` base is what both the development server and the built bundle need:
 * the Vite development server proxies `/api` to the API process and `preview.proxy` inherits that
 * entry, so no request may name a scheme or a host. A trailing slash is normalised away, so
 * `createTaskApi('/api/')` behaves exactly like the default.
 *
 * @param baseUrl - The base path every route is appended to; defaults to `/api`.
 * @returns The client. Construct one per application and pass it to `useTasks`.
 */
export function createTaskApi(baseUrl: string = '/api'): TaskApi {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const taskPath = (id: string): string => `${base}/tasks/${encodeURIComponent(id)}`;

  return {
    async listTasks(filters: TaskFilters): Promise<Task[]> {
      const query = new URLSearchParams();
      query.set('status', filters.status);
      // An empty value is the contract's spelling of "no priority filter", so the parameter is
      // always present and the empty values are never encoded away.
      query.set('priority', filters.priority ?? '');
      query.set('sort', filters.sort);

      const response = await send(`${base}/tasks?${query.toString()}`, { headers: ACCEPT_JSON });
      return readTaskList(response);
    },

    async createTask(input: CreateTaskInput): Promise<Task> {
      const response = await send(`${base}/tasks`, {
        method: 'POST',
        headers: JSON_BODY_HEADERS,
        body: JSON.stringify(input),
      });
      return readTask(response);
    },

    async updateTask(id: string, patch: UpdateTaskInput): Promise<Task> {
      const response = await send(taskPath(id), {
        method: 'PATCH',
        headers: JSON_BODY_HEADERS,
        body: JSON.stringify(patch),
      });
      return readTask(response);
    },

    async toggleTask(id: string, completed: boolean): Promise<Task> {
      const response = await send(taskPath(id), {
        method: 'PATCH',
        headers: JSON_BODY_HEADERS,
        body: JSON.stringify({ completed }),
      });
      return readTask(response);
    },

    async deleteTask(id: string): Promise<void> {
      // A successful delete answers 204, which carries no content: the response is deliberately not
      // read, because parsing an absent body would throw.
      await send(taskPath(id), { method: 'DELETE', headers: ACCEPT_JSON });
    },

    async getHealth(): Promise<{ status: string }> {
      const response = await send(`${base}/health`, { headers: ACCEPT_JSON });
      const body = await readBody(response);
      if (!isHealthBody(body)) {
        throw new ApiError(response.status, 'INTERNAL_ERROR', UNREADABLE_BODY_MESSAGE);
      }
      return body;
    },
  };
}

