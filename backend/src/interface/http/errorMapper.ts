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
import { STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';

import type {
  ConnectionError,
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

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

/**
 * The security-hardening headers every response of this API carries, stated once for every emitter.
 *
 * The API answers JSON under a content type it states itself, binds loopback, returns no credential
 * and holds no state a browser would read across origins, so this is hardening rather than a remedy
 * for a demonstrated exposure: `nosniff` stops a browser from second-guessing the declared media
 * type, `DENY` refuses to let any document frame a response at all, and `no-store` keeps a response
 * carrying the user's own task data out of every cache along the way. It is declared here because
 * this module also owns the writers for the two failures that never reach a route — the reply the
 * framework builds before any route context exists, and the socket a refused request is answered on,
 * in each case where the factory's response hook cannot reach — so every emitter reads this one list
 * instead of each stating the policy.
 */
export const RESPONSE_HARDENING_HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Cache-Control', 'no-store'],
] as const;

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
 * The status a failure the transport itself reports keeps under the contract.
 *
 * Such a failure never becomes a request: the socket's own error handler answers it before a route is
 * matched, so its status is read from the transport's own code rather than from a framework error. A
 * request line or header block past Node's limit is 431, a request that timed out mid-flight is 408,
 * and every other failure to parse the request line is a bad request.
 */
function transportStatusCode(code: string): number {
  switch (code) {
    case 'HPE_HEADER_OVERFLOW':
      return 431;
    case 'ERR_HTTP_REQUEST_TIMEOUT':
      return 408;
    default:
      return 400;
  }
}

/**
 * Maps a failure the socket's own error handler reports to the contract's status and body.
 *
 * The body is the one every client failure carries — the contract's validation class with an empty
 * field map, because such a failure belongs to no field — so a request the transport refused is
 * shaped exactly like a request a route rejected. This is the one place that answer is built for the
 * transport's path.
 */
function mapTransportFailure(code: string): { statusCode: number; body: ApiErrorBody } {
  return {
    statusCode: transportStatusCode(code),
    body: envelope('VALIDATION_ERROR', VALIDATION_ERROR_MESSAGE, {}),
  };
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
  // Status and code are read off the error, which carries both, so neither is restated here.
  if (error instanceof ValidationError) {
    return {
      statusCode: error.statusCode,
      body: envelope(error.code, error.message, error.fields),
    };
  }

  // A missing record: the domain's message already names the identifier, so it is not rebuilt here,
  // and the status and the code come from the error for the same reason as above.
  if (error instanceof TaskNotFoundError) {
    return { statusCode: error.statusCode, body: envelope(error.code, error.message, {}) };
  }

  if (isFastifyError(error)) {
    // A failure the transport met before any request was parsed reaches no route at all: the socket
    // answers it, so it is mapped from the transport's own code. It keeps that failure's status under
    // the contract's one validation class, and the transport's own wording is not echoed.
    if (error.code === 'HPE_HEADER_OVERFLOW' || error.code === 'ERR_HTTP_REQUEST_TIMEOUT') {
      return mapTransportFailure(error.code);
    }

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
 * Answers a failure with the status and the body the contract maps it to, logging the cause of a 5xx.
 *
 * This is the writer for every failure that reaches a route or one of the framework's own error
 * paths, and the failures the transport meets before a request exists are answered by
 * {@link answerTransportError} below through the same mapping, so nothing can answer outside the
 * contract's envelope. The server's error handler calls it for every failure a route or a use case
 * throws. The application factory also passes it to the framework as the framework's own error
 * handler, which is what covers the two failures the framework answers before a route is matched — a
 * path it cannot percent-decode and a path parameter past the router's limit — and which would
 * otherwise reach the client as the framework's default error shape.
 *
 * A failure that maps to a 5xx is logged at error level through the request logger, carrying the error
 * itself and the context of the request it failed on — which is what the framework's own per-request
 * records would otherwise supply, and which the factory switches off because nothing may log on the
 * success path. A 4xx is an expected outcome and is not logged.
 */
export function answerWithErrorContract(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const { statusCode, body } = mapError(error);
  if (statusCode >= 500) {
    request.log.error(
      { err: error, method: request.method, url: request.url },
      'Unexpected error handling request',
    );
  }

  // The hardening policy is stated on the reply as well as by the factory's response hook, because
  // the framework answers two of the failures handed to this writer — a path it cannot percent-decode
  // and a parameter past the router's limit — on a reply it builds before the route context exists,
  // where that hook's chain never runs. Reading the one list keeps the emitters from stating it twice.
  for (const [name, value] of RESPONSE_HARDENING_HEADERS) {
    reply.header(name, value);
  }

  reply.status(statusCode).send(body);
}

/**
 * Answers a failure the transport met before any request existed: the socket's own client-error
 * handler.
 *
 * A request line or a header block past Node's own limit, or a request that times out mid-flight, is
 * reported on the socket instead of to a route, so it reaches neither a route handler nor the error
 * handler nor the framework's framework-error channel. Handed those failures here, the writer states
 * the contract's answer on the socket itself, so even a request the transport refused is shaped by
 * the one mapping and no response leaves the API as the framework's default error shape.
 *
 * Nothing is logged: a client-side parse failure is the client's fault and an expected 4xx, not a
 * server failure to report.
 *
 * @param error The failure the transport reported; its `code` names the transport's own condition.
 * @param socket The connection the refused request arrived on. A connection already gone or no longer
 *   writable is left alone, because nothing can be delivered on it.
 */
export function answerTransportError(error: ConnectionError, socket: Socket): void {
  if (socket.destroyed || !socket.writable) {
    return;
  }

  const { statusCode, body } = mapTransportFailure(error.code);
  const payload = JSON.stringify(body);
  // The hardening policy is stated on the socket as well as by the factory's response hook: a request
  // the transport refused never becomes a request, so no hook runs for it and this head is the only
  // place that response can be shaped.
  const hardeningHeaders = RESPONSE_HARDENING_HEADERS.map(
    ([name, value]) => `${name}: ${value}\r\n`,
  ).join('');
  const head =
    `HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode] ?? 'Error'}\r\n` +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    'Content-Type: application/json; charset=utf-8\r\n' +
    hardeningHeaders +
    'Connection: close\r\n' +
    '\r\n';

  socket.write(head + payload);
  socket.end();
}

/**
 * Registers the server's error handler and its not-found handler: the single installation point of
 * the error contract.
 *
 * Both answer through this module's own writer, so the failure a route throws and the request no route
 * matches are shaped by the same code, and neither handler is installed anywhere else. The framework's
 * two error paths of its own are handed the same writer by the application factory.
 */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    answerWithErrorContract(error, request, reply);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(notFoundBody(request));
  });
}
