/**
 * The partial-update use case behind `PATCH /api/tasks/:id`.
 *
 * A patch changes only the fields it carries: the domain's `applyPatch` tests for the presence of a
 * key rather than its truthiness, so `""` clears a description and `null` clears a due date, while a
 * field the body omits is carried over untouched. `createdAt` is immutable and `updatedAt` always
 * advances to the instant the clock is read for this operation.
 *
 * This module depends on the domain and on the two ports it is constructed with, and on nothing
 * else: no framework, no driver, no HTTP type and no clock of its own. Every rule and every message
 * it reports comes from `domain/validation.ts`, so the interface layer, this use case and the
 * frontend all read the same strings.
 */

import {
  TaskNotFoundError,
  ValidationError,
  VALIDATION_ERROR_MESSAGE,
} from '../domain/errors.js';
import { applyPatch, type Task, type TaskPatch } from '../domain/task.js';
import { validatePatch } from '../domain/validation.js';
import type { Clock } from './Clock.js';
import type { TaskRepository } from './TaskRepository.js';

/** The ports an update is performed through; both are supplied by the composition root. */
interface UpdateTaskDependencies {
  /** Where the task is read from and written back to. */
  readonly repository: TaskRepository;
  /** The single source of the instant that becomes the task's new `updatedAt`. */
  readonly clock: Clock;
}

/**
 * The task to change and the fields to change on it.
 *
 * `patch` stays the domain's open, untrusted `TaskPatch` rather than a narrowed shape: the domain
 * owns the kind checks and their messages, so narrowing the type here would force a second copy of
 * those rules into this layer.
 */
interface UpdateTaskInput {
  /** Identifier of the task to update. */
  readonly id: string;
  /** The fields to change; only the keys present are applied. */
  readonly patch: TaskPatch;
}

/**
 * Applies a partial update to one stored task.
 *
 * The patch is validated before the task is read, so an unacceptable value is reported against its
 * field even when the identifier matches nothing. A task that cannot be found when it is read, and
 * one that has been deleted by the time the write lands, both surface as `TaskNotFoundError` rather
 * than being recreated — a write aimed at a record that no longer exists is never silently a
 * success.
 *
 * Concurrency is last write wins: the whole updated record is written back, the write that commits
 * last survives, and there is no version to compare and no conflict result to report.
 */
export class UpdateTask {
  private readonly repository: TaskRepository;
  private readonly clock: Clock;

  /** @param dependencies The persistence port and the time port this use case operates through. */
  constructor({ repository, clock }: UpdateTaskDependencies) {
    this.repository = repository;
    this.clock = clock;
  }

  /**
   * Applies the supplied fields to the task holding `id` and returns it.
   *
   * Only the keys present in `patch` change; the identity and `createdAt` are preserved and
   * `updatedAt` becomes the instant read from the clock for this operation, so the returned task is
   * exactly what a subsequent read yields.
   *
   * @param input The task's identifier and the fields to change.
   * @returns The updated task.
   * @throws {ValidationError} A supplied field fails one of the domain's rules; `fields` carries one
   *   message per offending field name.
   * @throws {TaskNotFoundError} No task holds `id`, or the record was deleted between the read and
   *   the write.
   */
  async execute({ id, patch }: UpdateTaskInput): Promise<Task> {
    const errors = validatePatch(patch);
    if (Object.keys(errors).length > 0) {
      throw new ValidationError(VALIDATION_ERROR_MESSAGE, errors);
    }

    const existing = await this.repository.findById(id);
    if (existing === null) {
      throw new TaskNotFoundError(id);
    }

    // One clock read per operation, so the timestamp persisted with this write is the instant it
    // reports; `applyPatch` returns a new task and leaves `existing` untouched.
    const updated = applyPatch(existing, patch, this.clock.now());

    const changed = await this.repository.update(updated);
    if (!changed) {
      // The row is gone: report it as missing rather than inserting it back, which would undo a
      // delete that happened after this operation read the task.
      throw new TaskNotFoundError(id);
    }

    return updated;
  }
}
