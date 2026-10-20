/**
 * Shared request helpers for the Playwright end-to-end suite.
 *
 * Scope authority: the file creation plan row `e2e/support/api.ts` — "request helpers, including
 * clearing tasks between specs" (test support, priority Medium), reinforced by the repository tree
 * line for `e2e/support/api.ts` ("request-fixture helpers, including clearing all tasks") and by the
 * end-to-end determinism rule that each spec clears the data it asserts on through this module.
 *
 * Every helper takes the built-in `request` fixture (`APIRequestContext`) as its first parameter, so
 * this module owns no request context of its own. Every path is relative: the fixture resolves it
 * against `use.baseURL` (the Vite origin), so the request travels the Vite `/api` proxy to the API
 * process and no host and no port is named anywhere in this module.
 *
 * This file is outside every tsconfig in the plan — there is no root tsconfig and no e2e tsconfig,
 * and type-aware linting covers only the backend and frontend workspaces — so it is written to
 * strict-mode standards by hand (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`): no
 * `any`, no non-null assertion, no `@ts-expect-error` and no lint suppression.
 */
import { expect, type APIRequestContext } from '@playwright/test';

/** Priority level carried by every task. */
export type TaskPriorityDto = 'low' | 'medium' | 'high';

/** Completion filter accepted by the list route; an omitted or empty value means `all`. */
export type TaskStatusFilter = 'all' | 'open' | 'completed';

/** Sort key accepted by the list route; an omitted or empty value means `createdAt`. */
export type TaskSortOption = 'dueDate' | 'priority' | 'createdAt';

/**
 * A task as it crosses the wire. All eight fields are always present: an absent due date is `null`
 * and an empty description is `""`, so a client never distinguishes a missing key from an empty value.
 */
export interface TaskDto {
  id: string;
  title: string;
  description: string;
  priority: TaskPriorityDto;
  /** `YYYY-MM-DD` calendar date or `null` — never a full ISO timestamp. */
  dueDate: string | null;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Optional filter and sort for the list route; an omitted value means the server's default. */
export interface TaskQuery {
  status?: TaskStatusFilter;
  priority?: TaskPriorityDto;
  sort?: TaskSortOption;
}

/** Body of the create route; every field but `title` is optional and takes its server-side default. */
export interface TaskCreatePayload {
  title: string;
  description?: string;
  priority?: TaskPriorityDto;
  dueDate?: string | null;
}

/**
 * Body of the patch route: any non-empty subset of the mutable fields. The type expresses the
 * fields only — non-emptiness is the server's rule, asserted by the specs that submit an empty patch.
 */
export interface TaskPatchPayload {
  title?: string;
  description?: string;
  priority?: TaskPriorityDto;
  dueDate?: string | null;
  completed?: boolean;
}

/** Machine-readable failure code of the error envelope. */
export type ApiErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR';

/**
 * The one error envelope every 4xx and 5xx response carries. `fields` is always present — `{}` when
 * the failure is not field-scoped — keyed by exactly the form's field names or a query parameter name.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields: Record<string, string>;
  };
}

/** A by-id response carrying its status, so a spec can assert a 200 task and a 404 envelope alike. */
export interface TaskResponse {
  status: number;
  body: TaskDto | ApiErrorBody;
}

/**
 * Narrows a `TaskResponse.body` to the error envelope so a spec can assert its `code`, `message` and
 * `fields` without casting to `any`.
 */
export function isApiErrorBody(value: TaskDto | ApiErrorBody): value is ApiErrorBody {
  return 'error' in value;
}

// Paths stay relative because the `request` fixture resolves them against `use.baseURL`.
const TASKS_PATH = '/api/tasks';
const taskPath = (id: string): string => `/api/tasks/${encodeURIComponent(id)}`;

/**
 * Builds the list route's query string. A parameter is appended only when its value is defined: an
 * omitted and an empty value both mean "use the server's default", so omitting keeps the URL readable
 * and the assertion messages honest. One value per name by construction, because a repeated parameter
 * is a 400 naming it. Returns `''` for an absent or empty query, so `listTasks(request)` exercises the
 * server's defaults rather than an empty parameter set.
 */
function buildQueryString(query?: TaskQuery): string {
  if (query === undefined) {
    return '';
  }
  const params = new URLSearchParams();
  if (query.status !== undefined) {
    params.append('status', query.status);
  }
  if (query.priority !== undefined) {
    params.append('priority', query.priority);
  }
  if (query.sort !== undefined) {
    params.append('sort', query.sort);
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/**
 * Parses a body that was already read once into a string. The `as T` assertion is what keeps `any`
 * out of this module, since `JSON.parse` is typed `any`.
 */
function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

/**
 * Deletes every task the API holds so each spec starts from a known store.
 * Asserts 200 on the read and 204 on every delete; resolves with nothing, and is safe on an empty store.
 */
export async function clearAllTasks(request: APIRequestContext): Promise<void> {
  const listResponse = await request.get(TASKS_PATH);
  const listText = await listResponse.text();
  expect(listResponse.status(), `GET ${TASKS_PATH} failed: ${listText}`).toBe(200);
  const tasks = parseJson<TaskDto[]>(listText);
  for (const task of tasks) {
    const deleteResponse = await request.delete(taskPath(task.id));
    expect(deleteResponse.status(), `DELETE ${taskPath(task.id)} failed`).toBe(204);
  }
}

/**
 * Creates a task and returns the server's copy of it. Asserts 201. The payload is sent exactly as
 * given — never validated, defaulted or rewritten here, because specs submit invalid bodies on purpose.
 */
export async function createTask(
  request: APIRequestContext,
  payload: TaskCreatePayload,
): Promise<TaskDto> {
  const response = await request.post(TASKS_PATH, { data: payload });
  const text = await response.text();
  expect(response.status(), `POST ${TASKS_PATH} failed: ${text}`).toBe(201);
  return parseJson<TaskDto>(text);
}

/**
 * Updates the supplied fields of one task and returns the server's copy of it. Asserts 200.
 */
export async function patchTask(
  request: APIRequestContext,
  id: string,
  payload: TaskPatchPayload,
): Promise<TaskDto> {
  const response = await request.patch(taskPath(id), { data: payload });
  const text = await response.text();
  expect(response.status(), `PATCH ${taskPath(id)} failed: ${text}`).toBe(200);
  return parseJson<TaskDto>(text);
}

/**
 * Lists tasks through the server's own filtering and sorting. Asserts 200 and returns the bare JSON
 * array in the order the server returned it — never re-sorted or re-filtered here, because the API's
 * ordering, including its id tie-break, is what the sort specs assert against.
 */
export async function listTasks(
  request: APIRequestContext,
  query?: TaskQuery,
): Promise<TaskDto[]> {
  const url = `${TASKS_PATH}${buildQueryString(query)}`;
  const response = await request.get(url);
  const text = await response.text();
  expect(response.status(), `GET ${url} failed: ${text}`).toBe(200);
  return parseJson<TaskDto[]>(text);
}

/**
 * Reads one task and asserts nothing about the status, returning the status together with the parsed
 * body so a spec can assert a 200 task and a 404 error envelope verbatim.
 */
export async function getTaskResponse(
  request: APIRequestContext,
  id: string,
): Promise<TaskResponse> {
  const response = await request.get(taskPath(id));
  const text = await response.text();
  return { status: response.status(), body: parseJson<TaskDto | ApiErrorBody>(text) };
}

/**
 * Deletes a task and returns the status code without asserting it, so a spec can prove 204 on the
 * first delete and 404 on the repeat. The body is deliberately not read: a successful delete is 204
 * with an empty body, and `APIResponse.json()` throws on a body that is not JSON-parsable.
 */
export async function deleteTask(request: APIRequestContext, id: string): Promise<number> {
  const response = await request.delete(taskPath(id));
  return response.status();
}
