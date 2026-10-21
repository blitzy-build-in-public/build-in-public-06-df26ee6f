/**
 * Wire types for the task API.
 *
 * This module is the single declaration of the contract between the browser and the
 * JSON HTTP API: the eight fields every task carries, the filter and sort vocabulary
 * the list endpoint accepts, the two request bodies a client may send, and the error
 * envelope every failure response uses. There is no generated shared package, so this
 * file is the coupling point with `backend/src/interface/http`.
 *
 * It imports nothing, declares no runtime value and exports only types, so it erases
 * completely at build time and may be imported by any module in `frontend/src` —
 * including components, which need to name a `Task` without reaching the API client.
 */

/**
 * The priority levels a task may be tagged with.
 *
 * `'medium'` is the level the server applies when a create request omits the field,
 * so a task always carries one of these three values.
 */
export type TaskPriority = 'low' | 'medium' | 'high';

/**
 * A task exactly as the API returns it.
 *
 * Every field is always present — an absent due date is `null`, an empty description
 * is `''` — so a client never has to distinguish a missing key from an empty value.
 * No field here is optional and none may be added: this is the shape of every task
 * object in every response body.
 */
export interface Task {
  /** Server-generated UUID. Immutable after creation and never accepted from a client. */
  id: string;
  /** Trimmed, between 1 and 200 characters after trimming. */
  title: string;
  /** Trimmed, at most 2000 characters after trimming; `''` when empty, never `null`. */
  description: string;
  /** The task's priority tag; always one of the three levels, `'medium'` by default. */
  priority: TaskPriority;
  /** A `YYYY-MM-DD` calendar date, or `null` when the task has none. Past dates are allowed. */
  dueDate: string | null;
  completed: boolean;
  /** ISO-8601 UTC timestamp with milliseconds, set by the server, never changed by a client. */
  createdAt: string;
  /** ISO-8601 UTC timestamp with milliseconds, advanced to the moment of every update. */
  updatedAt: string;
}

/**
 * The completion filter of a list request.
 *
 * `'all'` applies no completion filter; `'open'` keeps tasks whose `completed` is
 * false; `'completed'` keeps tasks whose `completed` is true. An empty or absent
 * `status` query value means `'all'`. This is a filter vocabulary for the list
 * request, not a field of the task entity.
 */
export type TaskStatus = 'all' | 'open' | 'completed';

/**
 * The key the list response is ordered by, applied by the server after filtering.
 *
 * - `'createdAt'`: most recently created task first. This is what an empty or absent
 *   `sort` query value means.
 * - `'dueDate'`: earliest due date first, with every task whose `dueDate` is `null`
 *   placed after all dated tasks.
 * - `'priority'`: `'high'`, then `'medium'`, then `'low'`.
 *
 * Any tie is broken by `id` ascending, so the order is total and reproducible.
 */
export type TaskSort = 'dueDate' | 'priority' | 'createdAt';

/**
 * The list view's active filters, sent as the `status`, `priority` and `sort` query
 * parameters of `GET /api/tasks`.
 *
 * `priority: null` means "all priorities" — the server applies no priority filter.
 * `status` and `sort` always hold one of their literal values, because their default
 * is the literal itself: an empty or absent query value means `'all'` for status and
 * `'createdAt'` for sort.
 *
 * This shape is shared verbatim by `App.tsx`, `state/useTasks.ts` and
 * `components/FilterBar.tsx`, so it must not be widened, narrowed or nested.
 */
export interface TaskFilters {
  /** Completion filter; `'all'` applies no completion filter. */
  status: TaskStatus;
  /** Priority filter, or `null` for all priorities. */
  priority: TaskPriority | null;
  /** The ordering the server applies. */
  sort: TaskSort;
}

/**
 * The body of `POST /api/tasks`.
 *
 * Only `title` is required. The server defaults each field that is absent:
 * `description` becomes `''`, `priority` becomes `'medium'` and `dueDate` becomes
 * `null`.
 *
 * `completed` is deliberately absent — a new task is always created incomplete, and a
 * create body that supplies it is rejected with 400. `id`, `createdAt` and `updatedAt`
 * are read-only and are likewise absent: supplying one is rejected with 400.
 */
export interface CreateTaskInput {
  /** Required. Trimmed before it is validated, so a whitespace-only title is rejected. */
  title: string;
  /** Optional; omitted means `''`. Pass `''` to store no description. */
  description?: string;
  /** Optional; omitted means `'medium'`. */
  priority?: TaskPriority;
  /** Optional; omitted means `null`. Pass `null` to store no due date. */
  dueDate?: string | null;
}

/**
 * The body of `PATCH /api/tasks/:id`.
 *
 * Only the fields present are applied, and a body carrying none is rejected with 400
 * ("At least one field must be supplied"). `dueDate: null` clears the due date and
 * `description: ''` clears the description; unknown properties are rejected rather
 * than ignored.
 *
 * `updatedAt` always advances to the moment the update is applied and `createdAt`
 * never changes. Neither is sendable, nor is `id`, which is absent here by
 * construction.
 */
export type UpdateTaskInput = Partial<
  Pick<Task, 'title' | 'description' | 'priority' | 'dueDate' | 'completed'>
>;

/**
 * The envelope every 4xx and 5xx response carries — a validation failure, an unknown
 * task or route, and an internal failure alike. No response uses the server
 * framework's default error shape.
 */
export interface ApiErrorBody {
  error: {
    /**
     * A stable, machine-readable failure class a client may branch on:
     * `'VALIDATION_ERROR'` (400), `'NOT_FOUND'` (404) or `'INTERNAL_ERROR'` (500).
     * The union is declared inline here and in `ApiError` in `api/client.ts`, by
     * design; the two must stay character-identical.
     */
    code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR';
    /**
     * A short human-readable summary safe to display. It names the specific failure
     * even when that failure belongs to no single field, so a client always has
     * something specific to show.
     */
    message: string;
    /**
     * Field-level messages, keyed by the name of the control each belongs beside —
     * `title`, `description`, `priority`, `dueDate` or `completed`, or a query
     * parameter's name. Always present, and `{}` for a failure that is not
     * field-scoped, such as an unknown task, a malformed body or an internal failure.
     */
    fields: Record<string, string>;
  };
}
