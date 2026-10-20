/**
 * The application factory of the API's HTTP delivery layer.
 *
 * It assembles the single Fastify instance the process serves from: the framework's bundled pino
 * logger at the configured level with the four framework behaviours this product depends on stated
 * rather than inherited — no per-request logging, no HEAD twins, the framework's own error paths
 * handed to the error contract, and a router parameter bound that lets the supplied identifier reach
 * the route — the error contract's one installation, and the two route modules that together register
 * the six routes under `/api`. It constructs nothing else — no database, no repository, no clock —
 * because the composed use cases it drives are handed to it, and it does not listen, because choosing
 * the address and binding the socket is the entry point's job. That is what lets the whole surface,
 * failure paths included, be driven in-process through `app.inject()`.
 *
 * Layering: the HTTP interface layer. It imports the two sibling route modules and the error
 * mapper, never an infrastructure module, so it can wire the port-facing use cases without ever
 * naming how a task is stored.
 */
import Fastify, { LogController, type FastifyInstance } from 'fastify';

import { answerWithErrorContract, installErrorHandling } from './errorMapper.js';
import { registerHealthRoutes } from './healthRoutes.js';
import type { AppDependencies } from './taskRoutes.js';
import { registerTaskRoutes } from './taskRoutes.js';

/**
 * The composed use cases the routes drive.
 *
 * The interface is declared by `./taskRoutes.js`, which consumes it, and re-exported here so the
 * composition root can take the whole composition surface — the factory and the dependencies it
 * takes — from this one module. A route module importing this factory for the type alone would
 * close a `taskRoutes` to `buildApp` to `taskRoutes` cycle, which the architecture rules reject
 * even for a type-only import, so the declaration stays where it is used and this file only
 * forwards the name.
 */
export type { AppDependencies };

/**
 * The settings the factory cannot obtain from the composed use cases.
 *
 * `logLevel` is the pino level for the application's logger, read from `LOG_LEVEL` by the
 * composition root (`info` by default) and passed in. The factory neither reads the environment nor
 * applies a default of its own, so the level has exactly one place where it is decided.
 */
export interface BuildAppOptions {
  /** Pino level for the application logger, for example `info`, `warn` or `silent`. */
  logLevel: string;
}

/**
 * The longest path parameter the router is allowed to match.
 *
 * The contract accepts the identifier as supplied and answers a value that matches no task with 404,
 * so the router must not refuse an identifier for its length: a long one has to reach the use case
 * exactly as a short one does, or a task that was deleted and a request that was refused become
 * distinguishable. This bound is Node's own request-line size, so every request the transport can
 * deliver is matched by the router, and a longer one never reaches the router at all.
 */
const MAX_PATH_PARAMETER_LENGTH = 16 * 1024;

/**
 * Builds the API application, ready to be injected into or listened on by the caller.
 *
 * Registration order is deliberate: the error handler and the not-found handler are installed
 * before any route, so every route registered into the same encapsulation context is answered
 * through the one mapping in `errorMapper.ts` — the 400 a rejected field produces, the 404 an
 * identifier that matches no task produces, and the 500 a storage failure becomes. Neither handler
 * is installed anywhere else, in this file or in any other.
 *
 * The returned instance is not listening. The caller decides when and where it listens, which is
 * what keeps the factory synchronous and the routes testable without a socket.
 *
 * @param deps The composed use cases, each reached only through its route's contract.
 * @param options The logger level for this application.
 * @returns The configured application, with all six routes registered and not listening.
 */
export function buildApp(deps: AppDependencies, options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    // Fastify's bundled pino logger is what logs the cause of a 500 while the client receives a
    // generic body, so only its level is supplied here — no second logger is added beside it.
    logger: { level: options.logLevel },

    // The framework logs every request it serves at info level by default — an `incoming request`
    // record carrying the whole request object, URL included, followed by a `request completed`
    // record. Both are written on the success path, which the contract requires to be silent, so
    // per-request logging is switched off through the log controller. The 500 path keeps its request
    // context from the log call in `errorMapper.ts`, which supplies the context itself.
    logController: new LogController({ disableRequestLogging: true }),

    // The framework registers a HEAD twin of every GET route by default, which would serve nine
    // method-and-path pairs where the contract names six endpoints. With the twins off, a HEAD falls
    // to the not-found handler and is answered with the contract's 404, because the contract defines
    // no 405.
    exposeHeadRoutes: false,

    // Two failures the framework otherwise answers itself, without ever reaching the error handler: a
    // path it cannot percent-decode and a path parameter past the router's limit. Handing both to the
    // contract's one writer is what keeps their responses in the contract's envelope instead of the
    // framework's default error shape.
    frameworkErrors: answerWithErrorContract,

    // The router's own limit would refuse a long identifier before any route saw it. Stating it here
    // is what lets the identifier be accepted as supplied and answered as a missing task.
    routerOptions: { maxParamLength: MAX_PATH_PARAMETER_LENGTH },
  });

  // Before the routes: both handlers must already be in place for everything registered below.
  installErrorHandling(app);

  registerTaskRoutes(app, deps);
  registerHealthRoutes(app);

  return app;
}
