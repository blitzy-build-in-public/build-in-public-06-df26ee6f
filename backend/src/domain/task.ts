/**
 * The `Task` entity: its shape, its defaults, and the three pure transitions that
 * produce a new task from an existing one.
 *
 * Nothing here imports another module, reads the clock or performs I/O: a caller
 * supplies the identifier and the current instant, and every transition returns a new
 * object rather than mutating its argument. The field rules and the messages they
 * produce live in `validation.ts`; this module only normalises values, so that a
 * created or patched task always carries all eight fields.
 */

/** The three valid priority levels. */
export type TaskPriority = 'low' | 'medium' | 'high';

/** A task as the API returns it: always all eight fields, never a partial object. */
export interface Task {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  /** A `YYYY-MM-DD` calendar date, or `null` when the task has no due date. */
  dueDate: string | null;
  completed: boolean;
  /** ISO 8601 UTC with milliseconds; never changes after creation. */
  createdAt: string;
  /** ISO 8601 UTC with milliseconds; advances to the moment of every update. */
  updatedAt: string;
}

/**
 * Untrusted create input as it arrives from the wire. Every value is `unknown` because
 * the domain owns the kind as well as the value checks: `validation.ts` must accept the
 * input before `createTask` is called.
 */
export type NewTaskInput = Readonly<Record<string, unknown>>;

/**
 * Untrusted patch input; only the keys present are applied. Every value is `unknown` for
 * the same reason as {@link NewTaskInput}: `validation.ts` decides validity.
 */
export type TaskPatch = Readonly<Record<string, unknown>>;

/** The priority a task takes when none is supplied. */
export const DEFAULT_PRIORITY: TaskPriority = 'medium';

/** Maximum length of a trimmed title. */
export const TITLE_MAX_LENGTH = 200;

/** Maximum length of a trimmed description. */
export const DESCRIPTION_MAX_LENGTH = 2000;

const priorities: TaskPriority[] = ['low', 'medium', 'high'];

/**
 * Every valid priority, and the single source of the three level names. Frozen so that
 * a consumer iterating or extending it cannot alter the set the domain validates against.
 */
export const TASK_PRIORITIES: readonly TaskPriority[] = Object.freeze(priorities);

/**
 * Trims a title. A value that is not a string — including an absent one — normalises to
 * `''`, which the required-title rule then rejects.
 */
export function normalizeTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Trims a description. A value that is not a string, including an absent one, becomes `''`. */
export function normalizeDescription(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Maps a value to a priority level. A value that is not one of the level names in
 * {@link TASK_PRIORITIES} takes {@link DEFAULT_PRIORITY}, which keeps normalisation
 * total so that `createTask` always yields a complete task; rejecting an unsupported
 * priority is a rule of `validation.ts` and is reported from there.
 */
function normalizePriority(value: unknown): TaskPriority {
  const matched = TASK_PRIORITIES.find((priority) => priority === value);
  return matched ?? DEFAULT_PRIORITY;
}

/** True when `key` is present on `record`, including when its value is `''` or `null`. */
function hasKey(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Keeps a supplied date string exactly as given; any other kind means "no due date". */
function toDueDate(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Builds a task from untrusted create input together with the caller-supplied identity
 * and instant.
 *
 * Precondition: `validateNewTask(input)` reported no errors, so every rule and its
 * message is decided once, in `validation.ts`.
 *
 * An absent description becomes `''`, an absent priority becomes {@link DEFAULT_PRIORITY},
 * an absent due date becomes `null`, and a new task is always incomplete, with `createdAt`
 * and `updatedAt` both set to the moment of creation.
 */
export function createTask(input: NewTaskInput, context: { id: string; now: Date }): Task {
  const timestamp = context.now.toISOString();
  // Index access throughout: the input is an untrusted bag, and this form reads it the
  // same way under every strict compiler configuration.
  return {
    id: context.id,
    title: normalizeTitle(input['title']),
    description: normalizeDescription(input['description']),
    priority: normalizePriority(input['priority']),
    dueDate: toDueDate(input['dueDate']),
    completed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Applies the fields present in `patch` to `task` and returns a new task; the argument is
 * never mutated. `id` and `createdAt` are immutable, while `updatedAt` always advances to
 * `now` because it records the moment the write is applied.
 *
 * Precondition: `validatePatch(patch)` reported no errors.
 */
export function applyPatch(task: Task, patch: TaskPatch, now: Date): Task {
  // Presence, not truthiness: `''` clears the description and `null` clears the due date,
  // so a truthy test would silently drop both.
  return {
    id: task.id,
    title: hasKey(patch, 'title') ? normalizeTitle(patch['title']) : task.title,
    description: hasKey(patch, 'description')
      ? normalizeDescription(patch['description'])
      : task.description,
    priority: hasKey(patch, 'priority') ? normalizePriority(patch['priority']) : task.priority,
    dueDate: hasKey(patch, 'dueDate') ? toDueDate(patch['dueDate']) : task.dueDate,
    completed: hasKey(patch, 'completed') ? patch['completed'] === true : task.completed,
    createdAt: task.createdAt,
    updatedAt: now.toISOString(),
  };
}

/**
 * Completes or reopens a task and returns a new task, leaving the argument untouched.
 * Every field other than `completed` and `updatedAt` is carried over unchanged.
 *
 * `completed` is already a boolean here — the interface narrows it and `validation.ts`
 * rejects any other kind — so it is not re-validated.
 */
export function setCompletion(task: Task, completed: boolean, now: Date): Task {
  return {
    ...task,
    completed,
    updatedAt: now.toISOString(),
  };
}
