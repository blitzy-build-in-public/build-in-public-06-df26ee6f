/**
 * The product's field rules, each with the single message it produces.
 *
 * This is the server-side validation the request requires. The HTTP layer establishes shape
 * only — that the body is a JSON object, that its properties are known, that query values are
 * single strings — and every semantic rule is decided here, so a rule and its message exist
 * once and the interface, the frontend and the tests all read the same strings.
 *
 * The module imports `./task.js` and nothing else: no third-party package, no `node:` built-in,
 * no other layer, no clock and no I/O. What it deliberately does not own: object-ness and the
 * empty-patch rejection belong to `interface/http/requestParsing.ts`, the error types a caller
 * raises belong to `errors.ts`, and the query-parameter messages belong to
 * `application/taskQuery.ts`.
 */

import {
  DESCRIPTION_MAX_LENGTH,
  TASK_PRIORITIES,
  TITLE_MAX_LENGTH,
  normalizeDescription,
  normalizeTitle,
  type NewTaskInput,
  type TaskPatch,
  type TaskPriority,
} from './task.js';

/** One message per offending field name, keyed by the name the form uses. Empty means valid. */
export type FieldErrors = Record<string, string>;

/**
 * The single copy of every validation message, frozen so that no consumer can alter it.
 *
 * The two length messages are built from the entity's own bounds, so changing a bound moves its
 * message with it. The nested `readOnly` map is frozen as well, and its keys are exactly what
 * {@link ReadOnlyField} names.
 */
export const FIELD_MESSAGES = Object.freeze({
  titleRequired: 'Title is required',
  titleTooLong: `Title must be ${TITLE_MAX_LENGTH} characters or fewer`,
  titleNotString: 'Title must be a string',
  descriptionTooLong: `Description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer`,
  descriptionNotString: 'Description must be a string',
  priorityInvalid: 'Priority must be one of: low, medium, high',
  dueDateInvalidFormat: 'Due date must be a date in YYYY-MM-DD format',
  dueDateNotCalendarDate: 'Due date must be a valid calendar date',
  completedNotBoolean: 'Completed must be true or false',
  completedOnCreate: 'Completed cannot be set when creating a task',
  unknownField: 'Unknown field',
  emptyPatch: 'At least one field must be supplied',
  readOnly: Object.freeze({
    id: 'id cannot be changed',
    createdAt: 'createdAt cannot be changed',
    updatedAt: 'updatedAt cannot be changed',
  }),
});

/** A field the system owns, which a request body may therefore never carry. */
export type ReadOnlyField = keyof typeof FIELD_MESSAGES.readOnly;

/**
 * Narrows a property name to a system-owned field, so the read-only message can be looked up by
 * name without a cast.
 *
 * @param value A property name taken from an untrusted request body.
 * @returns `true` when `value` is `id`, `createdAt` or `updatedAt`.
 */
export function isReadOnlyField(value: string): value is ReadOnlyField {
  return Object.prototype.hasOwnProperty.call(FIELD_MESSAGES.readOnly, value);
}

/** The eight entity field names a request body may carry, per the stored model. */
const KNOWN_FIELD_NAMES: readonly string[] = [
  'id',
  'title',
  'description',
  'priority',
  'dueDate',
  'completed',
  'createdAt',
  'updatedAt',
];

/**
 * The `YYYY-MM-DD` digit shape, shared by the due-date rule and {@link isValidCalendarDate} and
 * written with `[0-9]` rather than `\d` so it mirrors the pattern the stored column's SQL `GLOB`
 * check applies.
 */
const DUE_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** The two places a create and a patch differ; every other rule is shared by both. */
interface ValidationMode {
  /** A create requires a title; a patch validates one only when it supplies one. */
  readonly titleRequired: boolean;
  /** A create rejects `completed` outright; a patch requires a boolean. */
  readonly completed: 'rejected' | 'boolean';
}

const CREATE_MODE: ValidationMode = { titleRequired: true, completed: 'rejected' };
const PATCH_MODE: ValidationMode = { titleRequired: false, completed: 'boolean' };

/** True when `key` is present on `record`, including when its value is `''` or `null`. */
function hasKey(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * The message for the `title` field, or `null` when the supplied title is acceptable.
 *
 * An absent title is an error only where the mode requires one; a supplied title must be a
 * string, and is trimmed before its length is measured.
 */
function titleMessage(input: Readonly<Record<string, unknown>>, required: boolean): string | null {
  if (!hasKey(input, 'title')) {
    return required ? FIELD_MESSAGES.titleRequired : null;
  }

  const value = input['title'];
  if (typeof value !== 'string') {
    return FIELD_MESSAGES.titleNotString;
  }

  // Trimming precedes the bound, so a whitespace-only title is empty rather than long, and the
  // bound applies to what a reader would actually see.
  const trimmed = normalizeTitle(value);
  if (trimmed.length === 0) {
    return FIELD_MESSAGES.titleRequired;
  }
  return trimmed.length > TITLE_MAX_LENGTH ? FIELD_MESSAGES.titleTooLong : null;
}

/**
 * The message for the `description` field, or `null` when it is acceptable or absent. An absent
 * description is valid and means `""`; `""` is valid and clears the description; `null` is not a
 * description.
 */
function descriptionMessage(input: Readonly<Record<string, unknown>>): string | null {
  if (!hasKey(input, 'description')) {
    return null;
  }

  const value = input['description'];
  if (typeof value !== 'string') {
    return FIELD_MESSAGES.descriptionNotString;
  }
  return normalizeDescription(value).length > DESCRIPTION_MAX_LENGTH
    ? FIELD_MESSAGES.descriptionTooLong
    : null;
}

/**
 * The message for the `dueDate` field, or `null` when it is acceptable or absent.
 *
 * An absent due date is valid and means no due date, and so is `null`, which clears one. Any
 * other value must be a real `YYYY-MM-DD` calendar date; a past date is always accepted.
 */
function dueDateMessage(input: Readonly<Record<string, unknown>>): string | null {
  if (!hasKey(input, 'dueDate')) {
    return null;
  }

  const value = input['dueDate'];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !DUE_DATE_PATTERN.test(value)) {
    return FIELD_MESSAGES.dueDateInvalidFormat;
  }
  return isValidCalendarDate(value) ? null : FIELD_MESSAGES.dueDateNotCalendarDate;
}

/**
 * Applies every field rule to `input` and returns one message per offending field, so that a
 * form can place each message beside its control. The first failing rule for a field wins and
 * independent fields all report.
 *
 * Only the two differences the mode carries are conditional; every other rule is shared, so a
 * create and a patch can never drift apart.
 */
function validateFields(
  input: Readonly<Record<string, unknown>>,
  mode: ValidationMode,
): FieldErrors {
  const errors: FieldErrors = {};

  // Unknown and system-owned properties first: a mistyped property is reported against the name
  // the client sent rather than silently dropped, and `id`, `createdAt` and `updatedAt` are named
  // as read-only wherever they appear.
  for (const key of Object.keys(input)) {
    if (!KNOWN_FIELD_NAMES.includes(key)) {
      errors[key] = FIELD_MESSAGES.unknownField;
    } else if (isReadOnlyField(key)) {
      errors[key] = FIELD_MESSAGES.readOnly[key];
    }
  }

  if (hasKey(input, 'completed')) {
    if (mode.completed === 'rejected') {
      // A new task is always created incomplete, so the value is irrelevant and this one branch
      // covers `true`, `false`, `null` and the strings alike.
      errors['completed'] = FIELD_MESSAGES.completedOnCreate;
    } else if (typeof input['completed'] !== 'boolean') {
      // `null` and the strings "true"/"false" are not booleans; only the two literals are.
      errors['completed'] = FIELD_MESSAGES.completedNotBoolean;
    }
  }

  const title = titleMessage(input, mode.titleRequired);
  if (title !== null) {
    errors['title'] = title;
  }

  const description = descriptionMessage(input);
  if (description !== null) {
    errors['description'] = description;
  }

  // An absent priority is valid: the default is supplied when the task is built, so no message
  // exists for its absence. A supplied one must be a level name from the entity's own set.
  if (hasKey(input, 'priority') && !isValidPriority(input['priority'])) {
    errors['priority'] = FIELD_MESSAGES.priorityInvalid;
  }

  const dueDate = dueDateMessage(input);
  if (dueDate !== null) {
    errors['dueDate'] = dueDate;
  }

  return errors;
}

/**
 * Validates an untrusted create body and returns one message per offending field.
 *
 * Precondition: `input` is a plain object. Whether a body is an object at all is the HTTP
 * layer's shape concern, rejected before this function is reached, and a body that is not one
 * therefore has no field to report against.
 *
 * On top of the shared rules a create requires a title and rejects `completed` in any form.
 */
export function validateNewTask(input: NewTaskInput): FieldErrors {
  return validateFields(input, CREATE_MODE);
}

/**
 * Validates an untrusted patch body and returns one message per offending field.
 *
 * Precondition: `patch` is a plain object, as for {@link validateNewTask}.
 *
 * Every field is optional here, but a supplied one must be valid, and `completed` must be a
 * boolean. A patch naming no fields returns an empty map: rejecting an empty patch is a
 * body-level failure the HTTP layer raises, since no field name could carry it.
 */
export function validatePatch(patch: TaskPatch): FieldErrors {
  return validateFields(patch, PATCH_MODE);
}

/**
 * Narrows an untrusted value to a priority level.
 *
 * The check is membership in the entity's own set of level names, so this guard and the entity's
 * normalisation cannot disagree about what a level is.
 *
 * @param value Any value taken from a request body.
 * @returns `true` when `value` is `low`, `medium` or `high`.
 */
export function isValidPriority(value: unknown): value is TaskPriority {
  return TASK_PRIORITIES.some((priority) => priority === value);
}

/**
 * Whether an untrusted value is a real calendar date in `YYYY-MM-DD` form.
 *
 * The parts are parsed arithmetically rather than through `Date`: `new Date('2026-02-30')` rolls
 * the impossible day over into 2 March and would accept it, and `Date.UTC` maps the years 0-99
 * into 1900-1999, which would mishandle a year below 100. `Number` on a fixed-width digit slice
 * has neither problem.
 *
 * @param value Any value taken from a request body.
 * @returns `true` only for a four-digit year, a two-digit month and a two-digit day that exists
 *   in that month.
 */
export function isValidCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string' || !DUE_DATE_PATTERN.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  if (month < 1 || month > 12) {
    return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * The number of days in a month of a given year.
 *
 * @param year The four-digit year, used only for February's length.
 * @param month The month number, already known to be between 1 and 12.
 * @returns 28 or 29 for February, 30 for April, June, September and November, 31 otherwise.
 */
function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/** The Gregorian leap rule, as the calendar the stored dates are written and read in. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Re-exported so that the trimming rule has exactly one implementation: the entity normalises a
 * title and a description, and this module validates the value those normalisers produce.
 */
export { normalizeDescription, normalizeTitle } from './task.js';
