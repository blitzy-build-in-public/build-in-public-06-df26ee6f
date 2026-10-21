/**
 * The delete use case: removes the task a `DELETE /api/tasks/:id` request names.
 *
 * Deleting is unconditional and permanent, because the product has no soft delete — the stored
 * schema holds no deleted marker and a removed task is really gone, so the next listing read no
 * longer shows it. The confirmation that must precede a deletion is the interface's obligation,
 * not the API's: this use case takes no confirm flag and keeps no pending-deletion state.
 *
 * Nothing here reads the clock or validates the identifier. A delete writes no timestamp, and a
 * malformed identifier is deliberately indistinguishable from a deleted one — both match no task
 * and are reported as a 404 rather than a 400.
 *
 * The miss is reported by the port's boolean answer rather than by a read first: one statement
 * both removes the row and says whether a row was there, so there is no window in which the task
 * could vanish between a lookup and the write that follows it.
 */
import { TaskNotFoundError } from '../domain/errors.js';
import type { TaskRepository } from './TaskRepository.js';

/** Removes the task an identifier names, reporting a missing record as {@link TaskNotFoundError}. */
export class DeleteTask {
  /** The persistence port, the only dependency this use case has. */
  private readonly repository: TaskRepository;

  /** @param deps.repository Where tasks are stored; constructed once in the composition root. */
  constructor({ repository }: { repository: TaskRepository }) {
    this.repository = repository;
  }

  /**
   * Removes the task holding this identifier.
   *
   * Resolves with no value once the task is gone, which is what the route answers with an empty
   * 204 body. Throws {@link TaskNotFoundError} — carrying the identifier and the 404 status the
   * interface maps to a response — when no task holds it, so a repeat of the same delete is a
   * 404 rather than a silent success.
   *
   * @param input.id The identifier of the task to remove.
   */
  async execute({ id }: { id: string }): Promise<void> {
    const removed = await this.repository.delete(id);

    if (!removed) {
      throw new TaskNotFoundError(id);
    }
  }
}
