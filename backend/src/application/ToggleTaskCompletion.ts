/**
 * Completes or reopens a task: the application-layer operation behind the interface's
 * completion checkbox.
 *
 * Both directions are this one call. The client sends the state it wants the task to hold
 * rather than a request to invert the current one, so applying the same request twice leaves
 * the same result and a retried request cannot produce two different outcomes. The value
 * therefore arrives as a `boolean` — the route has already rejected any other kind of
 * `completed` — and nothing is validated here: a boolean in, the stored task out.
 *
 * The task is read, the domain's narrow transition is applied, and the whole record is written
 * back, so `updatedAt` advances to the instant the injected clock reports while every other
 * field, `createdAt` included, is preserved. A write that replaced no row means the task was
 * deleted between the read and the write; that is reported as not-found rather than recreated,
 * because an upsert would silently undo the delete. Concurrency is last write wins: there is no
 * version to compare and no conflict result to return.
 *
 * Nothing about the due date is read, compared or cleared. Overdue is derived in the browser
 * from `completed` and the date, never stored and never sent, so completing a task is what
 * removes its overdue flag.
 */
import { setCompletion, type Task } from '../domain/task.js';
import { TaskNotFoundError } from '../domain/errors.js';
import type { TaskRepository } from './TaskRepository.js';
import type { Clock } from './Clock.js';

/** A completion change: which task, and the state its `completed` flag should take. */
interface ToggleTaskCompletionInput {
  /** Identifier of the task to complete or reopen. */
  id: string;
  /** `true` completes the task, `false` reopens it. */
  completed: boolean;
}

/** The ports a {@link ToggleTaskCompletion} is constructed with. */
interface ToggleTaskCompletionDependencies {
  /** Where the task is read from and written back to. */
  repository: TaskRepository;
  /** Source of the instant the update is applied at. */
  clock: Clock;
}

/**
 * Applies the requested completion state to an existing task and returns that task as stored.
 *
 * The use case is constructed with the two ports it needs and holds no other state; both are
 * supplied by the composition root, so the store and the clock are replaceable without a change
 * here.
 */
export class ToggleTaskCompletion {
  private readonly repository: TaskRepository;
  private readonly clock: Clock;

  constructor({ repository, clock }: ToggleTaskCompletionDependencies) {
    this.repository = repository;
    this.clock = clock;
  }

  /**
   * Sets `completed` on the task holding `input.id` and reports the task as it was written.
   *
   * The clock is read once, and that single instant is the `updatedAt` of both the returned task
   * and the stored row, so a subsequent read of the same task returns what this call resolved
   * with, provided no further write intervened.
   *
   * @param input The task's identifier and the completion state to apply.
   * @returns The updated task, with `completed` set and `updatedAt` advanced.
   * @throws {TaskNotFoundError} When no task holds the identifier, and also when the write
   *   replaced no row because the task was deleted after it was read.
   */
  async execute({ id, completed }: ToggleTaskCompletionInput): Promise<Task> {
    const existing = await this.repository.findById(id);

    if (existing === null) {
      throw new TaskNotFoundError(id);
    }

    const updated = setCompletion(existing, completed, this.clock.now());
    const changed = await this.repository.update(updated);

    if (!changed) {
      throw new TaskNotFoundError(id);
    }

    return updated;
  }
}
