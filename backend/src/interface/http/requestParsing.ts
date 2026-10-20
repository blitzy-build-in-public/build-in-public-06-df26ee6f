/**
 * Request-shape parsing: the one place a request's *shape* is established before a use case runs.
 *
 * The division this module exists to hold is the one the architecture fixes. Whether a body is a
 * JSON object, whether a query parameter arrived once or repeatedly and whether a path parameter is
 * a string are questions about the *form* of a request, and they are answered here. Whether a title
 * is non-empty, a priority is a level name or a due date is a real calendar date are rules about a
 * task, and they are answered once, in `domain/validation.ts`, together with the messages the
 * interface displays; the query parameters' accepted values are answered once, in
 * `application/taskQuery.ts`. Every check below therefore either rejects a value of the wrong JSON
 * kind or delegates to the module that owns the rule, so no rule and no message is written twice
 * and the browser, the API and the tests cannot disagree about what a valid request is.
 *
 * Layering: the HTTP interface layer. It imports the domain and the application — the port whose
 * semantics it asks for — and never an infrastructure module, so it can see the shape of a request
 * without ever seeing how a task is stored. Nothing here logs, awaits, reads a clock or performs
 * I/O, and no task content is ever logged.
 */

import { parseTaskQuery } from '../../application/taskQuery.js';
import type { TaskQuery } from '../../application/taskQuery.js';
import { VALIDATION_ERROR_MESSAGE, ValidationError } from '../../domain/errors.js';
import type { NewTaskInput, TaskPatch } from '../../domain/task.js';
import { FIELD_MESSAGES, validateNewTask, validatePatch } from '../../domain/validation.js';
import { MALFORMED_BODY_MESSAGE } from './errorMapper.js';

/**
 * True when `value` is a JSON object: not `null`, not an array and not a primitive.
 *
 * This is the only structural check the layer performs itself, and it is a local type predicate
 * because the values it is handed are `unknown` at the type level: a request body arrives as
 * whatever the content-type parser produced.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows a parsed request body to a JSON object, or rejects it as a body-level failure.
 *
 * An absent or unparsable body never reaches this function: the content-type parser rejects it
 * first and the error mapper answers with the same summary. What is left for this check is a body
 * that *parsed* and turned out to be the wrong kind of JSON value — `null`, an array, a string or a
 * number — which is reported with an empty field map, because no field name could carry it.
 *
 * @throws {ValidationError} with an empty `fields` map when `raw` is not a JSON object.
 */
function requireObjectBody(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    throw new ValidationError(MALFORMED_BODY_MESSAGE, {});
  }
  return raw;
}

/**
 * Parses an untrusted create body into the create input the domain validates and consumes.
 *
 * The body is checked for being a JSON object and then handed to `validateNewTask`, which owns the
 * key set, the read-only fields, `completed` supplied on a create, unknown properties, the trimming
 * order, the length bounds, the priority levels and the calendar-date rule — each with the message
 * the form displays. The body is returned exactly as it arrived, with no key added, removed,
 * renamed or normalised: trimming and defaulting belong to `createTask`, which runs only once
 * validation has passed.
 *
 * @param raw The parsed request body, of unknown shape.
 * @returns The same body, as untrusted create input.
 * @throws {ValidationError} with a field map when a rule is violated, or with an empty field map
 *   when the body is not a JSON object.
 */
export function parseCreateBody(raw: unknown): NewTaskInput {
  const body = requireObjectBody(raw);

  const errors = validateNewTask(body);
  if (Object.keys(errors).length > 0) {
    throw new ValidationError(VALIDATION_ERROR_MESSAGE, errors);
  }

  return body;
}

/**
 * Parses an untrusted patch body into the patch the domain validates and applies.
 *
 * Three checks, in this order, because each is a different kind of failure: the body must be a JSON
 * object; it must supply at least one field, since an empty patch changes nothing and no field name
 * could carry that failure, so it is reported with an empty field map; and the fields it does
 * supply must pass `validatePatch`, which owns every key and value rule — including `completed`
 * having to be a boolean and `""` and `null` being valid ways to clear the description and the due
 * date. The body is returned unchanged.
 *
 * @param raw The parsed request body, of unknown shape.
 * @returns The same body, as an untrusted patch.
 * @throws {ValidationError} with an empty field map for a body that is not a JSON object or that
 *   supplies no fields, or with the per-field messages of `validatePatch`.
 */
export function parsePatchBody(raw: unknown): TaskPatch {
  const body = requireObjectBody(raw);

  if (Object.keys(body).length === 0) {
    throw new ValidationError(FIELD_MESSAGES.emptyPatch, {});
  }

  const errors = validatePatch(body);
  if (Object.keys(errors).length > 0) {
    throw new ValidationError(VALIDATION_ERROR_MESSAGE, errors);
  }

  return body;
}

/**
 * The query parameters the listing contract accepts. Any other parameter is ignored, whether it
 * appears once or repeatedly: only these three are part of the contract.
 */
const LIST_QUERY_PARAMETERS = Object.freeze(['status', 'priority', 'sort'] as const);

/**
 * Builds the failure for a parameter that arrived with more than one value.
 *
 * The template is written once for all three parameters. It is a statement about the request's
 * shape, which the domain does not own, so it belongs here rather than in a message record — and
 * the parameter's own name is the field key, so the interface can place the message beside the
 * control that produced it.
 */
function singleValueError(name: string): ValidationError {
  const message = `${name} must be a single value`;
  return new ValidationError(message, { [name]: message });
}

/**
 * Parses an untrusted query record into the listing query the use cases consume.
 *
 * The query parser yields a string for a parameter supplied once and an array for one supplied
 * repeatedly, and no route schema pre-validates it, so this function establishes the shape: a
 * known parameter carrying anything but a single string is rejected under its own name. An absent
 * parameter and a parameter supplied as an empty string are the same thing — a request for the
 * default — which is what makes the documented form `GET /api/tasks?status=&priority=&sort=` a
 * valid request rather than a failure. Everything semantic is left to `parseTaskQuery`, which
 * resolves an absent or empty value to its default and rejects an unsupported value with the
 * parameter's name as the field key.
 *
 * @param raw The parsed query record, of unknown shape.
 * @returns The complete listing query, with every default applied.
 * @throws {ValidationError} when a known parameter carries more than one value, or when
 *   {@link parseTaskQuery} rejects a value outside its accepted set.
 */
export function parseQuery(raw: unknown): TaskQuery {
  // The query parser always yields an object, so this guard is defensive only: a value of another
  // kind is read as no parameters at all, which resolves to the defaults, rather than as a failure
  // mode the contract does not define.
  const source: Record<string, unknown> = isPlainObject(raw) ? raw : {};

  // Only the parameters that were supplied are collected, so an absent one resolves to its default
  // in `parseTaskQuery` exactly as an empty one does.
  const parameters: Record<string, string | undefined> = {};
  for (const name of LIST_QUERY_PARAMETERS) {
    const value = source[name];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string') {
      throw singleValueError(name);
    }
    parameters[name] = value;
  }

  return parseTaskQuery(parameters);
}

/**
 * The failure for the path parameter, which no registered route can produce — see {@link parseId}.
 */
const MISSING_ID_MESSAGE = 'Path parameter id is required';

/**
 * Reads the `id` path parameter, without judging it.
 *
 * The guard is defensive rather than reachable: a registered route always supplies `:id`, so
 * `params.id` is a non-empty string on every request this function sees, but `request.params` is
 * `unknown` at the type level and the return type has to be honest about that rather than assert
 * the value's presence.
 *
 * No format check of any kind is performed, deliberately. An identifier matching no task must yield
 * 404 rather than 400, so a malformed identifier is indistinguishable by design from one whose task
 * was deleted; the `TaskNotFoundError` a use case raises is what produces that status, and this
 * function passes the raw string through untouched.
 *
 * @param params The path parameters, of unknown shape.
 * @returns The identifier as the client supplied it.
 * @throws {ValidationError} with an empty field map only on the unreachable case above, naming the
 *   missing parameter.
 */
export function parseId(params: unknown): string {
  if (isPlainObject(params)) {
    const id = params['id'];
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }

  throw new ValidationError(MISSING_ID_MESSAGE, {});
}
