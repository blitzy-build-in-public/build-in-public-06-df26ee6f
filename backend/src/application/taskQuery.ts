/**
 * Query semantics: the filtering and the sorting of a task list, owned in one place.
 *
 * The persistence adapter reads and writes rows and returns them unordered; every ordering the
 * product offers is decided here, on the array `ListTasks` already holds. That asymmetry is
 * deliberate: one implementation of the order means the interface, the API and the tests can never
 * disagree about it, and one `SELECT` plus one in-memory pass is what keeps the first list render
 * inside its sub-second budget at a thousand tasks.
 *
 * Nothing here performs I/O, reads a clock, awaits a promise or holds state. The three message
 * strings the query parameters produce are owned here because this module decides those rejections;
 * the HTTP layer parses the request's shape and reads the wording from
 * {@link QUERY_PARAMETER_MESSAGES}, so no rejection message is written twice.
 */

import { VALIDATION_ERROR_MESSAGE, ValidationError } from '../domain/errors.js';
import { TASK_PRIORITIES } from '../domain/task.js';
import type { Task, TaskPriority } from '../domain/task.js';

/** Which tasks a listing includes, by completion state. */
export type TaskStatus = 'all' | 'open' | 'completed';

/** The order a listing is returned in. */
export type TaskSort = 'dueDate' | 'priority' | 'createdAt';

/**
 * A validated listing request. Every property is always present — an absent or empty query
 * parameter is resolved to the default below — so `ListTasks` can pass the object straight through.
 */
export interface TaskQuery {
  status: TaskStatus;
  /** The priority to restrict the list to, or `null` for every priority. */
  priority: TaskPriority | null;
  sort: TaskSort;
}

/**
 * The raw query record {@link parseTaskQuery} accepts, already shape-checked by the interface
 * layer: every value is either a single string or `undefined` for an absent parameter (an empty
 * parameter arrives as `''`), because `requestParsing.ts` rejects a repeated parameter with 400
 * before this module is reached.
 */
export type TaskQueryInput = Readonly<Record<string, string | undefined>>;

/** The accepted `status` values, frozen so the set this module validates against cannot change. */
const TASK_STATUSES = Object.freeze(['all', 'open', 'completed'] as const);

/** The accepted `sort` values, frozen for the same reason as {@link TASK_STATUSES}. */
const TASK_SORTS = Object.freeze(['dueDate', 'priority', 'createdAt'] as const);

/** The status a listing takes when none is supplied. */
const DEFAULT_STATUS: TaskStatus = 'all';

/** The sort a listing takes when none is supplied. */
const DEFAULT_SORT: TaskSort = 'createdAt';

/** Rejection message for an unsupported `status` value. */
const STATUS_MESSAGE = 'status must be one of: all, open, completed';

/** Rejection message for an unsupported `priority` value. */
const PRIORITY_MESSAGE = 'priority must be one of: low, medium, high';

/** Rejection message for an unsupported `sort` value. */
const SORT_MESSAGE = 'sort must be one of: dueDate, priority, createdAt';

/**
 * The rejection message for each of the three query parameters, keyed by the parameter's own name.
 *
 * The contract's validation table fixes one message per parameter row and lists a repeated value
 * among that row's rules, so a parameter supplied twice is rejected with the same documented text
 * as one carrying an unsupported value. It is exported for the reason the three constants above stay
 * private: the shape check in `interface/http/requestParsing.ts` must report a repetition with this
 * wording, and reading it from the module that owns it is what keeps the text in one place — the
 * same arrangement `MALFORMED_BODY_MESSAGE` has with `interface/http/errorMapper.ts`.
 */
export const QUERY_PARAMETER_MESSAGES: Readonly<Record<'status' | 'priority' | 'sort', string>> =
  Object.freeze({
    status: STATUS_MESSAGE,
    priority: PRIORITY_MESSAGE,
    sort: SORT_MESSAGE,
  });

/**
 * Sort weight of each priority level: `high` first, then `medium`, then `low`. A frozen rank map
 * rather than nested conditions, so the order is stated once and read directly.
 */
const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = Object.freeze({
  low: 2,
  medium: 1,
  high: 0,
});

/** True when `value` is a status this module accepts. */
function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

/** True when `value` is a sort this module accepts. */
function isTaskSort(value: string): value is TaskSort {
  return TASK_SORTS.some((sort) => sort === value);
}

/** The matching priority level, or `null` when `value` is not one of the three level names. */
function narrowPriority(value: string): TaskPriority | null {
  return TASK_PRIORITIES.find((priority) => priority === value) ?? null;
}

/**
 * Resolves a raw parameter to the value it carries, or to `undefined` when it carries none.
 *
 * An empty value means "not supplied", which is what makes the request's own documented form
 * `GET /api/tasks?status=&priority=&sort=` a request for the defaults rather than a validation
 * failure.
 */
function suppliedValue(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Resolves the `status` parameter to a status.
 *
 * An unsupported value is recorded in `fields` under the parameter's own name and the default is
 * returned, so that one parse can report every offending parameter at once instead of stopping at
 * the first — the complete field map the domain's own rules produce, and the one the interface
 * needs to place a message beside each control in a single pass.
 */
function parseStatus(value: string | undefined, fields: Record<string, string>): TaskStatus {
  const candidate = suppliedValue(value);
  if (candidate === undefined) {
    return DEFAULT_STATUS;
  }
  if (!isTaskStatus(candidate)) {
    fields['status'] = STATUS_MESSAGE;
    return DEFAULT_STATUS;
  }
  return candidate;
}

/** Resolves the `priority` parameter to a priority or to `null` for no filter, recording a rejection. */
function parsePriority(
  value: string | undefined,
  fields: Record<string, string>,
): TaskPriority | null {
  const candidate = suppliedValue(value);
  if (candidate === undefined) {
    return null;
  }
  const priority = narrowPriority(candidate);
  if (priority === null) {
    fields['priority'] = PRIORITY_MESSAGE;
    return null;
  }
  return priority;
}

/** Resolves the `sort` parameter to a sort, recording an unsupported value under its own name. */
function parseSort(value: string | undefined, fields: Record<string, string>): TaskSort {
  const candidate = suppliedValue(value);
  if (candidate === undefined) {
    return DEFAULT_SORT;
  }
  if (!isTaskSort(candidate)) {
    fields['sort'] = SORT_MESSAGE;
    return DEFAULT_SORT;
  }
  return candidate;
}

/**
 * Turns a shape-checked query record into the complete {@link TaskQuery} the use cases consume.
 *
 * Absent and empty parameters both take their default; an unsupported value raises a
 * `ValidationError` whose field key is the parameter's own name, so the HTTP layer can place the
 * message beside the control that produced it. Any other parameter in the record is ignored: the
 * record is whatever the client sent, and only these three are part of the contract.
 *
 * Every parameter is resolved before the rejection is raised, so a request that got more than one
 * of them wrong is answered with a field key for each rather than for whichever came first.
 *
 * @throws {ValidationError} when `status`, `priority` or `sort` carries a value outside the
 *   accepted set.
 */
export function parseTaskQuery(raw: TaskQueryInput): TaskQuery {
  const fields: Record<string, string> = {};

  const status = parseStatus(raw['status'], fields);
  const priority = parsePriority(raw['priority'], fields);
  const sort = parseSort(raw['sort'], fields);

  if (Object.keys(fields).length > 0) {
    throw new ValidationError(VALIDATION_ERROR_MESSAGE, fields);
  }

  // Exactly three properties: a caller reading the result cannot depend on a raw parameter.
  return { status, priority, sort };
}

/** True when `task` belongs in a listing of the given status. */
function matchesStatus(task: Task, status: TaskStatus): boolean {
  switch (status) {
    case 'all':
      return true;
    case 'open':
      return !task.completed;
    case 'completed':
      return task.completed;
  }
}

/** True when `task` belongs in a listing restricted to `priority`; `null` restricts nothing. */
function matchesPriority(task: Task, priority: TaskPriority | null): boolean {
  return priority === null || task.priority === priority;
}

/**
 * Returns the tasks a query selects, as a new array; `tasks` is treated as read-only and is never
 * reordered or mutated. The two conditions combine with AND, so a query restricted by both status
 * and priority returns the tasks that satisfy each.
 */
export function filterTasks(tasks: readonly Task[], query: TaskQuery): Task[] {
  return tasks.filter(
    (task) => matchesStatus(task, query.status) && matchesPriority(task, query.priority),
  );
}

/** Compares two identifiers, which orders tasks sharing every other sort key. */
function compareById(a: Task, b: Task): number {
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * Compares two due dates: ascending, with every task that has no due date after every dated task.
 * `YYYY-MM-DD` is fixed-width, so the strings order exactly as the dates they represent without
 * being parsed and without a time zone entering the comparison.
 */
function compareDueDateValues(a: string | null, b: string | null): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Orders by due date, earliest first, with undated tasks last. The id tie-break makes the order
 * total: two distinct tasks never compare equal, so the same list always comes back in the same
 * order.
 */
export function compareByDueDate(a: Task, b: Task): number {
  return compareDueDateValues(a.dueDate, b.dueDate) || compareById(a, b);
}

/**
 * Orders by priority, `high` first, then `medium`, then `low`. The id tie-break makes the order
 * total, so tasks of one level keep a stable, reproducible order.
 */
export function compareByPriority(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || compareById(a, b);
}

/**
 * Orders by creation time, most recently created first. ISO 8601 UTC timestamps are fixed-width
 * too, so they order correctly as strings. The id tie-break makes the order total.
 */
export function compareByCreatedAt(a: Task, b: Task): number {
  if (a.createdAt === b.createdAt) {
    return compareById(a, b);
  }
  return a.createdAt > b.createdAt ? -1 : 1;
}

/** The comparator the given sort selects, so `sortTasks` has one place to choose from. */
function comparatorFor(sort: TaskSort): (a: Task, b: Task) => number {
  switch (sort) {
    case 'dueDate':
      return compareByDueDate;
    case 'priority':
      return compareByPriority;
    case 'createdAt':
      return compareByCreatedAt;
  }
}

/**
 * Returns the tasks in the requested order, as a new array; the caller's array is never sorted in
 * place, so a use case can hand in the list the repository returned and still read it unchanged.
 */
export function sortTasks(tasks: readonly Task[], sort: TaskSort): Task[] {
  return [...tasks].sort(comparatorFor(sort));
}
