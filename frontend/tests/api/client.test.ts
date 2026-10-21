/**
 * Unit suite for the browser's only HTTP caller, `createTaskApi` in `src/api/client.ts`.
 *
 * It pins the wire boundary the rest of the interface depends on: the route, method, header and
 * body of each of the six calls, the filter query string `listTasks` builds, and the translation
 * of every failure — a 400 carrying field-level messages, a 404, a 500, a 500 whose body is not
 * the error envelope, and a request that never reached the server — into one `ApiError` carrying
 * the status, the code and the field map. The global `fetch` is replaced for every case, so the
 * suite opens no socket, starts no server and touches no database.
 *
 * The suite stands alone in `frontend/tests/api` and imports no shared helper: the modules under
 * `frontend/tests/support` belong to the suites that use them, and the fixtures this file needs are
 * two task literals nothing else consumes.
 */

import { ApiError, createTaskApi } from '../../src/api/client';
import type { TaskApi } from '../../src/api/client';
import type {
  ApiErrorBody,
  CreateTaskInput,
  Task,
  TaskFilters,
  UpdateTaskInput,
} from '../../src/api/types';

/** A fixed task identifier, so a path assertion compares against the same value the request used. */
const TASK_ID = '9c8f5b1e-6f2a-4a1d-9c77-2f0b1d3e4a55';

/** A second fixed identifier, for the cases that need two different tasks in one response. */
const OTHER_TASK_ID = '1f4c2d7a-8b93-4e06-a1f5-7c9d0e2b3a44';

/** The creation moment of a fixture task; a fixed string, never the wall clock. */
const CREATED_AT = '2026-02-01T09:15:00.000Z';

/** The moment an edit fixture reports, later than `CREATED_AT` and likewise fixed. */
const UPDATED_AT = '2026-02-02T08:30:00.000Z';

/**
 * The filter set most cases send: all three parameters present, `priority: null` meaning "all
 * priorities", and the two literal defaults.
 */
const DEFAULT_FILTERS: TaskFilters = { status: 'all', priority: null, sort: 'createdAt' };

/** Matches a URL that names a scheme and a host, which no request of this client may do. */
const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** The client's requests, recorded by the stubbed global `fetch`. */
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A JSON response of the given status, which is how every success and most failures are stubbed. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A failure response carrying the contract's error envelope, so no case restates its shape.
 *
 * @param status - The HTTP status the server answers with.
 * @param code - The stable, machine-readable failure class.
 * @param message - The displayable summary.
 * @param fields - Field-level messages; `{}` when the failure belongs to no single field.
 */
function errorResponse(
  status: number,
  code: ApiErrorBody['error']['code'],
  message: string,
  fields: Record<string, string>,
): Response {
  return jsonResponse({ error: { code, message, fields } }, status);
}

/** A complete eight-field task with fixed timestamps, overridable per case. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 'Buy milk',
    description: '',
    priority: 'medium',
    dueDate: null,
    completed: false,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/**
 * The URL and init of the `index`-th recorded request.
 *
 * The lookup goes through `at` and guards against a missing call because the compiler treats an
 * indexed read as possibly absent. `input` is narrowed in the order the DOM types allow: a string
 * URL, a `URL` object, then a `Request`, whose `url` is the last case.
 */
function sentRequest(index = 0): { url: string; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls.at(index);
  if (call === undefined) {
    throw new Error(`Expected fetch to have been called at least ${index + 1} time(s).`);
  }
  const [input, init] = call;
  if (typeof input === 'string') {
    return { url: input, init };
  }
  if (input instanceof URL) {
    return { url: input.href, init };
  }
  return { url: input.url, init };
}

/** The path of a recorded request's URL, without its query string. */
function pathOf(url: string): string {
  const separator = url.indexOf('?');
  return separator === -1 ? url : url.slice(0, separator);
}

/** The query parameters of a recorded request's URL, read one parameter at a time. */
function queryParamsOf(url: string): URLSearchParams {
  const separator = url.indexOf('?');
  return new URLSearchParams(separator === -1 ? '' : url.slice(separator + 1));
}

/** The request body of a recorded call, parsed from the JSON string the client sent. */
function jsonBodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error('Expected the request to carry a JSON string body.');
  }
  return JSON.parse(body) as unknown;
}

/** Whether a parsed JSON value is a plain object rather than `null`, an array or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The request body of a recorded call, narrowed to the plain object the client serialised. */
function jsonObjectOf(init: RequestInit | undefined): Record<string, unknown> {
  const body = jsonBodyOf(init);
  if (!isRecord(body)) {
    throw new Error('Expected the request body to be a JSON object.');
  }
  return body;
}

/** The value of a request header, read through `Headers` so an object or a list both resolve. */
function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

/**
 * Awaits a promise that must reject with an `ApiError`, asserting the class through Vitest's own
 * `rejects` matchers and returning the error, so a case can also read its status, code, message
 * and fields without a non-null assertion.
 */
async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  await expect(promise).rejects.toBeInstanceOf(ApiError);
  await expect(promise).rejects.toBeInstanceOf(Error);
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw new Error(`Expected an ApiError, but received ${String(error)}.`, { cause: error });
  }
  throw new Error('Expected the request to reject, but it resolved with a value.');
}

describe('createTaskApi', () => {
  describe('request addresses', () => {
    it('addresses every request relatively, so no request names a scheme or a host', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([makeTask()]));
      fetchMock.mockResolvedValueOnce(jsonResponse(makeTask(), 201));
      fetchMock.mockResolvedValueOnce(jsonResponse(makeTask()));
      fetchMock.mockResolvedValueOnce(jsonResponse(makeTask()));
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

      const api = createTaskApi();
      await api.listTasks(DEFAULT_FILTERS);
      await api.createTask({ title: 'Buy milk' });
      await api.updateTask(TASK_ID, { title: 'Renamed' });
      await api.toggleTask(TASK_ID, true);
      await api.deleteTask(TASK_ID);
      await api.getHealth();

      expect(fetchMock).toHaveBeenCalledTimes(6);

      for (let index = 0; index < 6; index += 1) {
        const { url } = sentRequest(index);
        expect(url.startsWith('/api/')).toBe(true);
        expect(ABSOLUTE_URL.test(url)).toBe(false);
      }
    });
  });

  describe('listTasks', () => {
    it('resolves the array of tasks the route returned', async () => {
      const tasks = [
        makeTask(),
        makeTask({
          id: OTHER_TASK_ID,
          title: 'Book tickets',
          priority: 'high',
          dueDate: '2026-02-14',
        }),
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse(tasks));

      const result = await createTaskApi().listTasks(DEFAULT_FILTERS);

      expect(result).toHaveLength(2);
      expect(result.at(0)?.id).toBe(TASK_ID);
      expect(result.at(1)?.priority).toBe('high');
      expect(result).toEqual(tasks);
    });

    it('sends a body-less GET carrying exactly the three filter parameters', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await createTaskApi().listTasks({ status: 'open', priority: 'high', sort: 'dueDate' });

      const { url, init } = sentRequest();
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.body ?? null).toBeNull();
      expect(pathOf(url)).toBe('/api/tasks');

      const params = queryParamsOf(url);
      expect([...params.keys()].sort()).toEqual(['priority', 'sort', 'status']);
      expect(params.get('status')).toBe('open');
      expect(params.get('priority')).toBe('high');
      expect(params.get('sort')).toBe('dueDate');
    });

    it('encodes "all priorities" as a present priority parameter with an empty value', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await createTaskApi().listTasks({ status: 'open', priority: null, sort: 'dueDate' });

      const params = queryParamsOf(sentRequest().url);
      expect(params.has('priority')).toBe(true);
      expect(params.get('priority')).toBe('');
      expect(params.get('status')).toBe('open');
    });

    it('leaves the default status to the server, sending either "all" or an empty value', async () => {
      // Judgement call: the plan fixes neither spelling of the default status. The server treats
      // both `status=all` and an empty `status` as "no completion filter", so only the presence of
      // the parameter and its membership of that pair are pinned; a raw query string is not.
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await createTaskApi().listTasks({ status: 'all', priority: null, sort: 'createdAt' });

      const params = queryParamsOf(sentRequest().url);
      const status = params.get('status');
      expect(params.has('status')).toBe(true);
      expect(status === 'all' || status === '').toBe(true);
      expect(params.get('priority')).toBe('');
      expect(params.get('sort')).toBe('createdAt');
    });
  });

  describe('createTask', () => {
    it('sends POST /api/tasks as JSON and resolves the created task with its server defaults', async () => {
      const created = makeTask({
        title: 'Buy milk',
        description: '',
        priority: 'medium',
        dueDate: null,
        completed: false,
      });
      fetchMock.mockResolvedValueOnce(jsonResponse(created, 201));

      const result = await createTaskApi().createTask({ title: 'Buy milk' });

      const { url, init } = sentRequest();
      expect(url).toBe('/api/tasks');
      expect(init?.method).toBe('POST');
      expect(headerOf(init, 'content-type')).toContain('application/json');
      expect(jsonBodyOf(init)).toEqual({ title: 'Buy milk' });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      expect(result).toEqual(created);
      expect(result.description).toBe('');
      expect(result.priority).toBe('medium');
      expect(result.dueDate).toBeNull();
      expect(result.completed).toBe(false);
    });

    it('passes every optional field through and never sends completed', async () => {
      const input: CreateTaskInput = {
        title: 'Book tickets',
        description: 'Row 12, aisle seat',
        priority: 'high',
        dueDate: '2026-02-14',
      };
      const created = makeTask({ ...input, id: OTHER_TASK_ID });
      fetchMock.mockResolvedValueOnce(jsonResponse(created, 201));

      const result = await createTaskApi().createTask(input);

      const body = jsonObjectOf(sentRequest().init);
      expect(body).toEqual(input);
      expect(Object.keys(body)).not.toContain('completed');
      expect(result).toEqual(created);
    });
  });

  describe('updateTask', () => {
    it('sends PATCH /api/tasks/:id carrying only the supplied fields', async () => {
      const patch: UpdateTaskInput = { title: 'Renamed', priority: 'high' };
      const updated = makeTask({ title: 'Renamed', priority: 'high', updatedAt: UPDATED_AT });
      fetchMock.mockResolvedValueOnce(jsonResponse(updated));

      const result = await createTaskApi().updateTask(TASK_ID, patch);

      const { url, init } = sentRequest();
      expect(url).toBe(`/api/tasks/${TASK_ID}`);
      expect(init?.method).toBe('PATCH');
      expect(headerOf(init, 'content-type')).toContain('application/json');

      const body = jsonObjectOf(init);
      expect(Object.keys(body).sort()).toEqual(['priority', 'title']);
      expect(body).toEqual(patch);
      expect(result).toEqual(updated);
    });

    it('sends a clearing patch as it stands, so an empty description and a null due date survive', async () => {
      const patch: UpdateTaskInput = { description: '', dueDate: null };
      const updated = makeTask({ description: '', dueDate: null });
      fetchMock.mockResolvedValueOnce(jsonResponse(updated));

      const result = await createTaskApi().updateTask(TASK_ID, patch);

      expect(jsonObjectOf(sentRequest().init)).toEqual({ description: '', dueDate: null });
      expect(result.description).toBe('');
      expect(result.dueDate).toBeNull();
    });
  });

  describe('toggleTask', () => {
    it.each([true, false])(
      'sends PATCH /api/tasks/:id with { completed: %s } alone',
      async (completed) => {
        const toggled = makeTask({ completed, updatedAt: UPDATED_AT });
        fetchMock.mockResolvedValueOnce(jsonResponse(toggled));

        const result = await createTaskApi().toggleTask(TASK_ID, completed);

        const { url, init } = sentRequest();
        expect(url).toBe(`/api/tasks/${TASK_ID}`);
        expect(init?.method).toBe('PATCH');
        expect(headerOf(init, 'content-type')).toContain('application/json');

        const body = jsonObjectOf(init);
        expect(Object.keys(body)).toEqual(['completed']);
        expect(body['completed']).toBe(completed);
        expect(result).toEqual(toggled);
      },
    );

    it('addresses the same path as updateTask, which is what routes a toggle to the completion case', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(makeTask()));
      fetchMock.mockResolvedValueOnce(jsonResponse(makeTask({ completed: true })));

      const api = createTaskApi();
      await api.updateTask(TASK_ID, { title: 'Renamed' });
      await api.toggleTask(TASK_ID, true);

      expect(sentRequest(1).url).toBe(sentRequest(0).url);
      expect(sentRequest(1).url).toBe(`/api/tasks/${TASK_ID}`);
    });
  });

  describe('deleteTask', () => {
    it('sends DELETE /api/tasks/:id and resolves with nothing, never reading the empty body', async () => {
      // A 204 carries no content, so its `.json()` rejects: a client that parsed the body would
      // fail this case, which is exactly what the case proves.
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const api = createTaskApi();
      await expect(api.deleteTask(TASK_ID)).resolves.toBeUndefined();

      const { url, init } = sentRequest();
      expect(url).toBe(`/api/tasks/${TASK_ID}`);
      expect(init?.method).toBe('DELETE');
      expect(init?.body ?? null).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getHealth', () => {
    it('sends a body-less GET /api/health and resolves the reported status', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

      await expect(createTaskApi().getHealth()).resolves.toEqual({ status: 'ok' });

      const { url, init } = sentRequest();
      expect(url).toBe('/api/health');
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.body ?? null).toBeNull();
    });
  });

  describe('failure responses', () => {
    /** One call that is expected to reach a task the server no longer holds. */
    type NotFoundCall = (api: TaskApi, id: string) => Promise<unknown>;

    const notFoundCases: Array<[string, NotFoundCall]> = [
      ['updateTask', (api, id) => api.updateTask(id, { title: 'Renamed' })],
      ['toggleTask', (api, id) => api.toggleTask(id, true)],
      ['deleteTask', (api, id) => api.deleteTask(id)],
    ];

    it('maps a 400 to an ApiError carrying the field-level messages the form places beside each control', async () => {
      const fields = {
        title: 'Title is required',
        dueDate: 'Due date must be a date in YYYY-MM-DD format',
      };
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, 'VALIDATION_ERROR', 'Request validation failed', fields),
      );

      const error = await expectApiError(
        createTaskApi().createTask({ title: 'Buy milk', dueDate: '2026-02-30' }),
      );

      expect(error.name).toBe('ApiError');
      expect(error.status).toBe(400);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Request validation failed');
      expect(error.fields).toEqual(fields);
      // The keys are exactly the names the form uses, so each message can sit beside its control.
      expect(Object.keys(error.fields).sort()).toEqual(['dueDate', 'title']);
      for (const field of Object.keys(error.fields)) {
        expect(['title', 'description', 'priority', 'dueDate']).toContain(field);
      }
    });

    it.each(notFoundCases)(
      'maps a 404 from %s to an ApiError that names the identifier and carries no field messages',
      async (_method, call) => {
        // The sentence the server's TaskNotFoundError emits for this id, per the error contract.
        const message = `Task ${TASK_ID} was not found`;
        fetchMock.mockResolvedValueOnce(errorResponse(404, 'NOT_FOUND', message, {}));

        const error = await expectApiError(call(createTaskApi(), TASK_ID));

        expect(error.status).toBe(404);
        expect(error.code).toBe('NOT_FOUND');
        expect(error.message).toBe(message);
        expect(error.message).toContain(TASK_ID);
        expect(error.fields).toEqual({});
      },
    );

    it('maps a 500 to a generic ApiError that carries no internal detail', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(500, 'INTERNAL_ERROR', 'Internal server error', {}),
      );

      const error = await expectApiError(createTaskApi().createTask({ title: 'Buy milk' }));

      expect(error.status).toBe(500);
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.message).toBe('Internal server error');
      expect(error.fields).toEqual({});
      expect(error.message).not.toMatch(
        /SQLITE|better-sqlite3|\/src\/|at [A-Za-z_$]+ \(|\.ts:\d+/i,
      );
    });

    it('still rejects with an ApiError when a 500 body is not the error envelope', async () => {
      // The realistic case is a proxy error page: the development server proxies /api, so a
      // backend that is down surfaces as a 500 whose body is HTML. The interface can offer its
      // retry control only for an ApiError, so the client yields one rather than a parse error.
      fetchMock.mockResolvedValueOnce(
        new Response('<!doctype html><html><body>Internal Server Error</body></html>', {
          status: 500,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      const error = await expectApiError(createTaskApi().listTasks(DEFAULT_FILTERS));

      expect(error.status).toBe(500);
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.fields).toEqual({});
      expect(error.message).not.toContain('doctype');
    });

    it('rejects a failing list rather than resolving a fallback empty list', async () => {
      // No `[]` fallback may exist: a silent empty list would hide a storage failure from the
      // user, whose screen is required to offer a retry instead.
      fetchMock.mockResolvedValueOnce(
        errorResponse(500, 'INTERNAL_ERROR', 'Internal server error', {}),
      );

      await expect(createTaskApi().listTasks(DEFAULT_FILTERS)).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('transport failures', () => {
    const transportFailures: Array<[string, Error]> = [
      ['a transport failure', new TypeError('Failed to fetch')],
      ['an aborted request', new DOMException('aborted', 'AbortError')],
    ];

    it.each(transportFailures)(
      'converts %s into an ApiError, so no caller ever sees a foreign error type',
      async (_name, cause) => {
        fetchMock.mockRejectedValueOnce(cause);

        const error = await expectApiError(createTaskApi().deleteTask(TASK_ID));

        // Judgement call: the plan fixes no numeric status for a request that never reached the
        // server — the contract's codes describe HTTP responses, and there is no response here — so
        // only the shape of the value is pinned, never `0` or any status the plan does not state.
        expect(typeof error.status).toBe('number');
        expect(Number.isInteger(error.status)).toBe(true);
        expect(error.code).toBe('INTERNAL_ERROR');
        expect(error.fields).toEqual({});
        expect(error.message.length).toBeGreaterThan(0);
      },
    );
  });
});
