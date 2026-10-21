import type { FastifyInstance } from 'fastify';

/**
 * Registers the API's liveness route.
 *
 * `GET /api/health` answers 200 with `{ status: 'ok' }` for as long as the process is serving
 * requests. It is a liveness probe only: it reads no storage, reports no version and requires no
 * credentials. The path and the body are fixed, because the end-to-end suite waits on this exact
 * response before it starts driving the interface.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });
}
