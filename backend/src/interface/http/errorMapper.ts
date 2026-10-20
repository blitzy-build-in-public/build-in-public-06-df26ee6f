/**
 * The HTTP layer's single error-mapping module.
 *
 * Every 4xx and 5xx response the API emits is shaped here, and `installErrorHandling` is the one
 * place the server's error handler and its not-found handler are registered, so the error contract
 * has a single implementation and no route handler builds a failure response of its own.
 *
 * Layering: this module belongs to the HTTP interface layer and imports only the domain's error
 * types — never an infrastructure module — so it can see what kind of failure occurred without
 * ever seeing how storage produced it.
 */
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';

import {
  TaskNotFoundError,
  VALIDATION_ERROR_MESSAGE,
  ValidationError,
} from '../../domain/errors.js';

/** The stable, machine-readable failure classes a client may branch on. */
export type ApiErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR';

/**
 * The one error envelope: a code, a displayable summary and field-level messages.
 *
 * `fields` is always present — keyed by the form's own field names for a rule violation, `{}` for a
 * failure that belongs to no field — so a client never has to tell an absent map from an empty one.
 */
export interface ApiErrorBody {
  error: {
    /** Machine-readable failure class; {@link ApiErrorCode} is the full set. */
    code: ApiErrorCode;
    /** Short, human-readable summary that is safe to display. */
    message: string;
    /** Field name to message; `{}` when the failure is not field-scoped. */
    fields: Record<string, string>;
  };
}

/**
 * The summary for a request body that is absent or cannot be parsed as a JSON object.
 *
 * Exported because the request parser rejects a body that is not a JSON object with the identical
 * text, so the string is written once instead of repeated in a second module.
 */
export const MALFORMED_BODY_MESSAGE = 'Request body must be a valid JSON object';

/**
 * The fixed summary every 500 carries.
 *
 * It is deliberately generic: the status alone tells the client the request failed for a reason
 * outside its control, while the cause is logged server-side and never disclosed — no stack, no
 * driver message, no file path and no record data.
 */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/** Builds the envelope, so its three keys exist in one order on every failure path. */
function envelope(
  code: ApiErrorCode,
  message: string,
  fields: Record<string, string>,
): ApiErrorBody {
  return { error: { code, message, fields } };
}

/**
 * Narrows a thrown value to the shape the server framework uses for its own errors.
 *
 * It tests only that the value is an object, because the members read from it afterwards — `code`
 * and `statusCode` — are treated as optional: an object thrown by application code is not a
 * framework error, so it falls through to the internal-failure branch.
 */
function isFastifyError(value: unknown): value is FastifyError {
  return typeof value === 'object' && value !== null;
}

/**
 * Maps a thrown value to the status and the body the client receives.
 *
 * The branch order decides the contract: the domain's own failures win over the framework's
 * generic client-error handling, and an unclassifiable value — a storage failure, a busy timeout,
 * a programming error or a non-`Error` throw — becomes the fixed generic 500 rather than an
 * unhandled rejection.
 */
export function mapError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  // A rule violation: the field map travels to the client, and the message is forwarded because it
  // carries the specific text of a failure that belongs to no field, such as an empty patch body.
  if (error instanceof ValidationError) {
    return { statusCode: 400, body: envelope('VALIDATION_ERROR', error.message, error.fields) };
  }

  // A missing record: the domain's message already names the identifier, so it is not rebuilt here.
  if (error instanceof TaskNotFoundError) {
    return { statusCode: 404, body: envelope('NOT_FOUND', error.message, {}) };
  }

  if (isFastifyError(error)) {
    // The content-type-parser failures are the only way an absent or unparsable JSON body reaches
    // this handler; both mean the same thing to the client: send a JSON object.
    if (
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      return { statusCode: 400, body: envelope('VALIDATION_ERROR', MALFORMED_BODY_MESSAGE, {}) };
    }

    // Any other framework failure carrying a client-error status keeps that status under the
    // contract's one validation code. Its own message is not echoed: it is internal detail.
    const statusCode = error.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return { statusCode, body: envelope('VALIDATION_ERROR', VALIDATION_ERROR_MESSAGE, {}) };
    }
  }

  return { statusCode: 500, body: envelope('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE, {}) };
}

/**
 * Builds the 404 body for a request whose method and path match no route.
 *
 * An unmatched route never reaches the error handler, so this function — installed as the not-found
 * handler below — is what answers it. Naming the method and the path is what distinguishes an
 * unknown route from a task that no longer exists; the contract deliberately defines no 405.
 */
export function notFoundBody(request: FastifyRequest): ApiErrorBody {
  return envelope('NOT_FOUND', `No route matches ${request.method} ${request.url}`, {});
}

/**
 * Registers the server's error handler and its not-found handler: the single installation point of
 * the error contract.
 *
 * A failure that maps to a 5xx is logged with the request context, which is how an operator reads
 * the cause while the client receives a generic body. A 4xx is an expected outcome and is not
 * logged, and nothing is logged on the success path.
 */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body } = mapError(error);
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unexpected error handling request');
    }
    reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(notFoundBody(request));
  });
}
