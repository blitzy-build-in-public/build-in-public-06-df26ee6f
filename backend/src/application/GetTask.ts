/**
 * The single-read use case behind `GET /api/tasks/:id`.
 *
 * A read changes nothing and derives nothing: it hands the identifier to the persistence port and
 * returns the stored task exactly as the port resolved it, so every field a client receives is the
 * stored value — a `null` due date stays `null`, an empty description stays `''` — and no caller has
 * to tell an absent key from an empty one. Nothing here filters, sorts, enriches or reformats: the
 * listing use case owns filtering and sorting, and the presentation rules a browser needs (the
 * overdue flag, the priority label) belong to the interface and are never computed on the server.
 *
 * A miss is reported as the domain's own failure, not as a value: the port resolves `null` for an
 * identifier it does not hold, and this use case raises `TaskNotFoundError` for it so the HTTP layer
 * can answer 404 by the error's type. Returning `null` instead would let a handler serialise it as
 * a 200 body. The identifier is taken exactly as supplied — a value that matches no task is a 404
 * whether or not it looks like one the system generated, so "malformed" and "deleted" are
 * deliberately indistinguishable to a client.
 *
 * Layer: this module belongs to the application layer and imports only the domain and its own
 * persistence port — no framework, no storage driver and no adapter.
 */
import { TaskNotFoundError } from '../domain/errors.js';
import type { Task } from '../domain/task.js';
import type { TaskRepository } from './TaskRepository.js';

/**
 * Reads one stored task by identifier.
 *
 * The composition root constructs it as `new GetTask({ repository })`; tests construct it with the
 * same port over their in-memory implementation.
 */
export class GetTask {
  private readonly repository: TaskRepository;

  /**
   * @param deps The persistence port. No clock is injected: a read writes nothing and therefore
   *   reads no time.
   */
  constructor({ repository }: { repository: TaskRepository }) {
    this.repository = repository;
  }

  /**
   * Returns the task holding `id`.
   *
   * @param input The identifier, already accepted by the interface layer as supplied.
   * @throws {TaskNotFoundError} when no task holds the identifier; the error names it and carries
   *   the 404 status the interface returns.
   */
  async execute({ id }: { id: string }): Promise<Task> {
    const task = await this.repository.findById(id);
    if (task === null) {
      throw new TaskNotFoundError(id);
    }
    return task;
  }
}
