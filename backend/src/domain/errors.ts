/**
 * Domain error types.
 *
 * These are the only failure types the domain and the application layer raise. Each one carries the
 * HTTP status the interface must return, so the single HTTP error mapper selects a response by the
 * error's type rather than by inspecting the text of its message.
 *
 * This module imports nothing: the domain layer has no third-party runtime dependency, no Node
 * built-in module and performs no I/O.
 *
 * Both classes extend `Error` directly and need no prototype-restoration shim — at the ES2022
 * target a subclass of `Error` inherits the native prototype chain, so `instanceof` works in every
 * runtime this project targets.
 */

/** The summary used when a validation failure belongs to no single field. */
export const VALIDATION_ERROR_MESSAGE = 'Request validation failed';

/**
 * A rule violation: input of the right shape whose values are not acceptable.
 *
 * Carries the per-field messages the interface places beside the offending controls, together with
 * the 400 status it must return.
 */
export class ValidationError extends Error {
  /** Stable machine-readable code of the error contract. */
  readonly code = 'VALIDATION_ERROR';

  /** Field name to message, keyed by the field names the interface's form uses. */
  readonly fields: Record<string, string>;

  /** The status the interface returns for this failure. */
  readonly statusCode = 400;

  /**
   * @param message Summary shown when no single field owns the failure; defaults to
   *   {@link VALIDATION_ERROR_MESSAGE}.
   * @param fields Per-field messages. Defaults to an empty map so the interface can always emit a
   *   `fields` key, including for a failure that belongs to no field.
   */
  constructor(message: string = VALIDATION_ERROR_MESSAGE, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

/**
 * A read, update, completion change or delete that matched no task.
 *
 * Carries the 404 status the interface must return, and names the identifier in its message so the
 * client can report which task disappeared.
 */
export class TaskNotFoundError extends Error {
  /** Stable machine-readable code of the error contract. */
  readonly code = 'NOT_FOUND';

  /** The identifier that matched no task. */
  readonly id: string;

  /** The status the interface returns for this failure. */
  readonly statusCode = 404;

  /** @param id The identifier that matched no task; the message names it. */
  constructor(id: string) {
    super(`Task ${id} was not found`);
    this.name = 'TaskNotFoundError';
    this.id = id;
  }
}
