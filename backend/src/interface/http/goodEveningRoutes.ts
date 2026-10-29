import type { FastifyInstance } from 'fastify';

/**
 * Registers the API's greeting route.
 *
 * `GET /good-evening` answers 200 with the plain-text body `Good evening`. It is a fixed answer:
 * it reads no storage, requires no credentials and reports nothing about the process. The media
 * type is stated explicitly, because a string payload sent without one is answered as
 * `text/plain; charset=utf-8`, which is not the media type the contract names.
 */
export function registerGoodEveningRoutes(app: FastifyInstance): void {
  app.get('/good-evening', async (_request, reply) => {
    return reply.status(200).type('text/plain').send('Good evening');
  });
}
