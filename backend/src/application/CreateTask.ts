/**
 * The create use case behind `POST /api/tasks`.
 *
 * It is the application layer's whole answer to "add a task": validate the untrusted create input
 * with the domain's rules, build the entity from it, store it through the repository port and hand
 * the stored task back. No rule, bound, trim or message is written here — `validation.ts` owns
 * every check and its wording, and `task.ts` owns the defaults — so a create cannot drift from an
 * update, and a second copy of a message can never appear.
 *
 * Identity and time are the only two things this file supplies. The identifier comes from
 * `randomUUID` (the one `node:` built-in the application layer may use) and the instant from the
 * injected {@link Clock}; neither the system clock nor a caller-supplied timestamp is consulted,
 * which is what lets a test pin both the identifier's shape and the two timestamps.
 */

import { randomUUID } from 'node:crypto';

import { ValidationError, VALIDATION_ERROR_MESSAGE } from '../domain/errors.js';
import { createTask, type NewTaskInput, type Task } from '../domain/task.js';
import { validateNewTask } from '../domain/validation.js';
import type { Clock } from './Clock.js';
import type { TaskRepository } from './TaskRepository.js';

/**
 * The ports a {@link CreateTask} use case is constructed with.
 *
 * Both are declared by this layer and implemented outside it — the SQLite adapter and the system
 * clock by the composition root, an in-memory store and a frozen clock by the tests — so the names
 * `repository` and `clock` are the shape every caller constructs this class with.
 */
export interface CreateTaskDependencies {
  /** Where the created task is stored. */
  readonly repository: TaskRepository;
  /** The only source of the instant written to `createdAt` and `updatedAt`. */
  readonly clock: Clock;
}

/**
 * Creates a task and stores it.
 *
 * A create is one validation, one entity and one insert. The task returned is the object that was
 * persisted rather than a re-read of it, so the `201` body equals what a subsequent
 * `GET /api/tasks/:id` returns and no per-task read is added to the listing path.
 */
export class CreateTask {
  private readonly repository: TaskRepository;
  private readonly clock: Clock;

  /** @param dependencies The persistence and time ports, both required. */
  constructor({ repository, clock }: CreateTaskDependencies) {
    this.repository = repository;
    this.clock = clock;
  }

  /**
   * Validates `input`, builds the task from it, stores it and returns it.
   *
   * An unacceptable input — an absent or whitespace-only title, a title or description over its
   * bound, a priority that is not one of the three levels, a due date that is malformed or is not
   * a real calendar date, a supplied `completed`, or an unknown property — raises a
   * {@link ValidationError} whose `fields` map holds one message per offending field name, keyed by
   * the names the form uses, and stores nothing. A storage failure propagates untouched: turning
   * either failure into a response is the interface layer's single mapping.
   *
   * @param input The untrusted create body. It is passed to the domain as it arrived, because the
   *   domain owns the kind checks as well as the value checks; it is never mutated.
   * @returns The persisted task: `completed` false, an absent description `''`, an absent priority
   *   `medium`, an absent due date `null`, and `createdAt` and `updatedAt` both set to the instant
   *   the clock was read for this operation.
   */
  async execute(input: NewTaskInput): Promise<Task> {
    const errors = validateNewTask(input);
    if (Object.keys(errors).length > 0) {
      throw new ValidationError(VALIDATION_ERROR_MESSAGE, errors);
    }

    // One clock read serves both timestamps, so they are identical on a new task, and the
    // identifier is generated here rather than accepted from the caller, so a client can never
    // choose or reuse one. The insert is the port's own operation rather than an upsert: a task
    // that already holds this identifier is an error, never an overwrite.
    const task = createTask(input, { id: randomUUID(), now: this.clock.now() });

    await this.repository.insert(task);

    return task;
  }
}
