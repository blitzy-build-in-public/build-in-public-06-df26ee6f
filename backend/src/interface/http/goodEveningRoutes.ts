import type { FastifyInstance } from 'fastify';

/**
 * Registers the API's greeting route.
 *
 * `GET /good-evening` answers 200 with the plain-text body `Good evening`. It is a fixed answer:
 * it reads no storage, requires no credentials and reports nothing about the process. The media
 * type is stated explicitly, because a string payload sent without one is answered as
 * `text/plain; charset=utf-8`, which is not the media type the contract names.
 *
 * The path is unprefixed, unlike the task and liveness families under `/api`, because the published
 * wire contract fixes `/good-evening` exactly and so outranks the prefix convention; the departure
 * is deliberate.
 *
 * Layering: the HTTP interface layer, beside the other per-family route modules. It imports the
 * framework's type and nothing else, so the route reaches no store, no use case and no
 * infrastructure module.
 */
export function registerGoodEveningRoutes(app: FastifyInstance): void {
  app.get('/good-evening', async (_request, reply) => {
    return reply.status(200).type('text/plain').send('Good evening');
  });
}
