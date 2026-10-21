/**
 * The five task routes: the HTTP delivery layer's entire surface for tasks.
 *
 * This module carries no rule, no message and no decision of its own. It parses the *shape* of a
 * request with `requestParsing.ts`, hands the result to exactly one use case, and sends what that
 * use case resolved with. Every semantic rule — the bounds, the trimming order, the priority
 * levels, the calendar-date check, the query defaults — is owned by the domain (or, for query
 * values, by the application's query module) and arrives here already applied; a handler therefore
 * has nothing left to validate and nothing to decide.
 *
 * Failures are not answered here either. A `ValidationError` or a `TaskNotFoundError` raised by a
 * use case propagates out of the handler untouched, and the one error mapping installed by the
 * application factory turns it into the response contract's 400 or 404 — so no route builds an
 * error body, no route catches anything, and a storage failure reaches the same handler as the
 * 500 it must become. Nothing here logs and nothing awaits outside a use case call.
 *
 * Layering: the HTTP interface layer. It imports the application and the domain, never an
 * infrastructure module, so a handler can see the ports' operations without ever seeing how a task
 * is stored.
 */

import type { FastifyInstance } from 'fastify';

import type { CreateTask } from '../../application/CreateTask.js';
import type { DeleteTask } from '../../application/DeleteTask.js';
import type { GetTask } from '../../application/GetTask.js';
import type { ListTasks } from '../../application/ListTasks.js';
import type { ToggleTaskCompletion } from '../../application/ToggleTaskCompletion.js';
import type { UpdateTask } from '../../application/UpdateTask.js';
import { parseCreateBody, parseId, parsePatchBody, parseQuery } from './requestParsing.js';

/**
 * The composed use cases the task routes drive.
 *
 * `AppDependencies` is declared here, where it is consumed, rather than beside the factory that
 * fills it: a route module importing the factory for the type alone would close a `taskRoutes`
 * to `buildApp` to `taskRoutes` cycle, which the architecture rules reject even for a type-only
 * import. The application factory re-exports this interface, so it remains available under the
 * name the composition root uses.
 *
 * Each member is the whole use case rather than one of its methods, so a route sends one command
 * and reads one answer, and the object graph is built in exactly one place.
 */
export interface AppDependencies {
  /** Serves `POST /api/tasks`: validates and stores a new task. */
  createTask: CreateTask;
  /** Serves `PATCH /api/tasks/:id` when the body carries more than just `completed`. */
  updateTask: UpdateTask;
  /** Serves `DELETE /api/tasks/:id`: removes the task the path names. */
  deleteTask: DeleteTask;
  /** Serves `PATCH /api/tasks/:id` when `completed` is the body's only field. */
  toggleTaskCompletion: ToggleTaskCompletion;
  /** Serves `GET /api/tasks/:id`: reads one task. */
  getTask: GetTask;
  /** Serves `GET /api/tasks`: lists the tasks the query selects. */
  listTasks: ListTasks;
}

/**
 * Registers the five task routes on the API application.
 *
 * Called once, by the application factory, with the use cases the composition root constructed.
 * The routes are registered in the contract's own order — list, create, read, update, delete — and
 * each one parses its request's shape, calls one use case and sends the result. The listing route
 * sends the array the use case returned unchanged: filtering and ordering are the application
 * layer's, so nothing is reshaped, counted or wrapped on the way out.
 *
 * @param app The application instance to register the routes on.
 * @param deps The use cases the handlers call, each of which may only be invoked through its route
 *   contract.
 */
export function registerTaskRoutes(app: FastifyInstance, deps: AppDependencies): void {
  // Lists the tasks the query selects: 200 with the bare array the use case returns, already
  // filtered and sorted. An unsupported or repeated query value is rejected by `parseQuery`.
  app.get('/api/tasks', async (request, reply) => {
    const query = parseQuery(request.query);
    const tasks = await deps.listTasks.execute(query);
    return reply.status(200).send(tasks);
  });

  // Creates a task: 201 with the persisted task, whose absent description, priority and due date
  // arrive as `''`, `medium` and `null`. An unacceptable field is rejected by the domain rules,
  // which the use case raises as a `ValidationError` carrying the field map.
  app.post('/api/tasks', async (request, reply) => {
    const input = parseCreateBody(request.body);
    const task = await deps.createTask.execute(input);
    return reply.status(201).send(task);
  });

  // Reads one task: 200 with the stored task, or 404 through the `TaskNotFoundError` the use case
  // raises for an identifier that matches nothing.
  app.get('/api/tasks/:id', async (request, reply) => {
    const id = parseId(request.params);
    const task = await deps.getTask.execute({ id });
    return reply.status(200).send(task);
  });

  // Updates a task, in one of two ways decided by the body's key set: a body whose only field is
  // `completed` is the checkbox toggle and goes to the completion use case, which applies the
  // requested state; any other body — `completed` alongside other fields included — is a partial
  // update and goes to the update use case. Both answer 200 with the task as written.
  app.patch('/api/tasks/:id', async (request, reply) => {
    const id = parseId(request.params);
    const patch = parsePatchBody(request.body);

    const keys = Object.keys(patch);
    if (keys.length === 1 && keys[0] === 'completed') {
      // `parsePatchBody` has already rejected any value that is not a boolean, so the only question
      // left is which of the two states was asked for.
      const completed = patch.completed === true;
      return reply.status(200).send(await deps.toggleTaskCompletion.execute({ id, completed }));
    }

    return reply.status(200).send(await deps.updateTask.execute({ id, patch }));
  });

  // Deletes a task: 204 with no body once it is gone. The delete is not idempotent by contract — a
  // second delete of the same identifier finds no task and answers 404 through the use case's
  // `TaskNotFoundError`.
  app.delete('/api/tasks/:id', async (request, reply) => {
    const id = parseId(request.params);
    await deps.deleteTask.execute({ id });
    return reply.status(204).send();
  });
}
