/**
 * Unit suite for the `DeleteTask` use case: the removal of a task, and the not-found path that a
 * repeat delete or an unknown identifier takes.
 *
 * The use case is constructed with `InMemoryTaskRepository` and no clock — `DeleteTask` takes the
 * repository alone because a deletion writes no timestamp — so no SQLite file, driver, framework
 * or clock is present. That absence is this folder's evidence that the storage adapter is
 * replaceable without touching `src/application` (AAP 0.10.3).
 *
 * Every assertion stays at the use-case level: the resolved value and the store's contents, never
 * a response body or a status line, which the route suite owns. The suite evidences acceptance
 * criterion 3's use-case half — a confirmed delete removes the task, and the same delete repeated
 * raises `TaskNotFoundError`, which the route suite then reports as a 204 followed by a 404.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeleteTask } from '../../../src/application/DeleteTask.js';
import { TaskNotFoundError } from '../../../src/domain/errors.js';
import type { Task } from '../../../src/domain/task.js';
import { InMemoryTaskRepository } from '../../support/inMemoryTaskRepository.js';

/**
 * The task every case removes, built by hand rather than by a transition, so its fields are
 * frozen literals: fixed identifiers and fixed ISO timestamps, never anything read from the wall
 * clock, since this suite writes no timestamp and a clock read would assert differently on two
 * machines on two days.
 */
const SEEDED: Task = {
  id: 'task-0001',
  title: 'Buy milk',
  description: '',
  priority: 'low',
  dueDate: null,
  completed: false,
  createdAt: '2026-02-01T09:15:00.000Z',
  updatedAt: '2026-02-01T09:15:00.000Z',
};

/**
 * A second task that is never the delete target, so a "store untouched" assertion has something
 * to find. An empty store would satisfy "the removed task is gone" while proving nothing about
 * whether the delete removed anything but the one record it was aimed at.
 */
const OTHER: Task = { ...SEEDED, id: 'task-0002', title: 'Pay rent' };

/** An identifier no stored task holds; a miss is a 404 upstream, not a 400. */
const MISSING_ID = 'missing';

describe('DeleteTask', () => {
  let repository: InMemoryTaskRepository;
  let deleteTask: DeleteTask;

  beforeEach(async () => {
    // A fresh store and a fresh use case per case, so no stubbed method and no removed record can
    // leak from one case into the next.
    repository = new InMemoryTaskRepository();
    deleteTask = new DeleteTask({ repository });

    await repository.insert(SEEDED);
    await repository.insert(OTHER);
  });

  it('deletes an existing task and resolves undefined', async () => {
    await expect(deleteTask.execute({ id: SEEDED.id })).resolves.toBeUndefined();

    await expect(repository.findById(SEEDED.id)).resolves.toBeNull();

    // The listing the API serves reads `findAll`, so this is what the next `GET /api/tasks` shows.
    // Asserted on the identifiers rather than on the array's order, because the port's `findAll`
    // makes no ordering promise and no suite may depend on the one this store happens to yield.
    const remaining = await repository.findAll();
    expect(remaining.map((task) => task.id)).not.toContain(SEEDED.id);

    // The other task survived the delete, intact and by value.
    await expect(repository.findById(OTHER.id)).resolves.toEqual(OTHER);
  });

  it('raises TaskNotFoundError when the same task is deleted twice', async () => {
    await deleteTask.execute({ id: SEEDED.id });

    // The use-case statement of criterion 3's "a repeat DELETE returns 404": the port answers
    // `false` the second time and the use case turns that into the domain's not-found error.
    const error = asTaskNotFoundError(
      await rejectionOf(() => deleteTask.execute({ id: SEEDED.id })),
    );

    expect(error.id).toBe(SEEDED.id);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.message).toContain(SEEDED.id);
  });

  it('raises TaskNotFoundError for an unknown identifier and leaves the store untouched', async () => {
    const error = asTaskNotFoundError(
      await rejectionOf(() => deleteTask.execute({ id: MISSING_ID })),
    );

    expect(error.id).toBe(MISSING_ID);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.message).toContain(MISSING_ID);

    // A delete aimed at nothing removes nothing: both seeded tasks are still stored exactly as
    // they were written.
    expect(await repository.findAll()).toHaveLength(2);
    await expect(repository.findById(SEEDED.id)).resolves.toEqual(SEEDED);
    await expect(repository.findById(OTHER.id)).resolves.toEqual(OTHER);
  });

  it('raises TaskNotFoundError when the delete reports that no row was removed', async () => {
    // The one path a real store cannot be made to take on demand: a `false` answer from `delete`
    // while the record is still present, which is how a store reports a write that matched no row.
    vi.spyOn(repository, 'delete').mockResolvedValue(false);

    const error = asTaskNotFoundError(
      await rejectionOf(() => deleteTask.execute({ id: SEEDED.id })),
    );

    expect(error.id).toBe(SEEDED.id);
    expect(error.statusCode).toBe(404);

    // Not a silent success: the use case must report the miss, and the record it could not remove
    // is still there rather than reported as gone.
    await expect(repository.findById(SEEDED.id)).resolves.toEqual(SEEDED);
    await expect(repository.findById(OTHER.id)).resolves.toEqual(OTHER);
  });

  it('does not touch any other repository method when the delete reports that no row was removed', async () => {
    const deleteSpy = vi.spyOn(repository, 'delete').mockResolvedValue(false);
    const insertSpy = vi.spyOn(repository, 'insert');
    const updateSpy = vi.spyOn(repository, 'update');
    const findByIdSpy = vi.spyOn(repository, 'findById');
    const findAllSpy = vi.spyOn(repository, 'findAll');

    await rejectionOf(() => deleteTask.execute({ id: SEEDED.id }));

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(SEEDED.id);

    // A `false` answer means the row is already gone. Re-inserting or repairing it here would
    // resurrect a task deleted between the read and the write that followed it, quietly undoing a
    // delete that had already succeeded — which is exactly why the port keeps `insert` and
    // `update` apart from one another (AAP 0.2.2 and 0.3.6).
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(findByIdSpy).not.toHaveBeenCalled();
    expect(findAllSpy).not.toHaveBeenCalled();

    // Read back after the call-count assertions, so the values show what the failed delete left
    // behind: both seeded tasks, unchanged.
    await expect(repository.findById(SEEDED.id)).resolves.toEqual(SEEDED);
    await expect(repository.findById(OTHER.id)).resolves.toEqual(OTHER);
  });
});

/**
 * Returns the error `action` rejected with, and fails the test when it resolved instead.
 *
 * The error is handed back as `unknown` so that {@link asTaskNotFoundError} narrows it: reaching
 * into a rejection this way avoids an assertion or a cast just to satisfy the compiler, and a
 * rejection of the wrong type fails with a message naming what actually arrived.
 */
async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error('expected the action to reject, but it resolved');
}

/**
 * Narrows a captured rejection to `TaskNotFoundError`, failing the test when it is anything else.
 */
function asTaskNotFoundError(error: unknown): TaskNotFoundError {
  if (!(error instanceof TaskNotFoundError)) {
    throw new Error(`expected a TaskNotFoundError, received ${String(error)}`);
  }

  return error;
}
