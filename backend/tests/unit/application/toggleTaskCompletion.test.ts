/**
 * Unit suite for the `ToggleTaskCompletion` use case: the application-layer operation behind the
 * interface's completion checkbox.
 *
 * Both directions are asserted here — completing an open task and reopening a completed one — with
 * `updatedAt` advancing to the instant the injected clock reports while `createdAt` and every other
 * field are preserved; then the two failure paths the repository port's boolean return exists for:
 * an identifier that matches no task, and a write that replaced no row because the task was deleted
 * between the read and the write. That is the use-case evidence for acceptance criterion 4, whose
 * observable half — the task moving between the open and completed filters and losing its overdue
 * flag — belongs to the frontend suites and the end-to-end run.
 *
 * The use case is constructed with the two substitutes the inner layers are always tested with:
 * `InMemoryTaskRepository`, so nothing here opens a database, imports a driver or names a column, and
 * `createFixedClock`, so each `updatedAt` is asserted against a literal instant rather than the wall
 * clock. Nothing in this file reads the system clock, touches the file system or reaches the network.
 *
 * The route layer narrows `completed` to a boolean and rejects any other kind before this use case is
 * reached, so no coercion is exercised here; and a patch body carrying `completed` alongside other
 * fields is `UpdateTask`'s operation, so the mixed form is not asserted either. This suite drives one
 * transition — `setCompletion`'s — through the use case and the substitute store, which is a
 * different claim from the rule-by-rule evidence the domain suite holds for it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskRepository } from '../../../src/application/TaskRepository.js';
import { ToggleTaskCompletion } from '../../../src/application/ToggleTaskCompletion.js';
import { TaskNotFoundError } from '../../../src/domain/errors.js';
import type { Task } from '../../../src/domain/task.js';
import { createFixedClock, type FixedClock } from '../../support/fixedClock.js';
import { InMemoryTaskRepository } from '../../support/inMemoryTaskRepository.js';

/** The instant both fixtures were created at; a literal, so no assertion reads the wall clock. */
const CREATED_INSTANT = new Date('2026-02-01T09:15:00.000Z');

/** An hour of frozen time, so `updatedAt` is provably later than `createdAt` rather than equal to it. */
const ONE_HOUR_MS = 3_600_000;

/** An open task with every optional field populated, so preservation is asserted against real values. */
const OPEN_TASK: Task = {
  id: 'task-open',
  title: 'Buy milk',
  description: 'two litres',
  priority: 'high',
  dueDate: '2026-03-01',
  completed: false,
  createdAt: CREATED_INSTANT.toISOString(),
  updatedAt: CREATED_INSTANT.toISOString(),
};

/**
 * A completed task. Its identifier and title differ from the open task's, so a read aimed at the
 * wrong task shows up as a failed assertion rather than as a value that happens to match.
 */
const COMPLETED_TASK: Task = {
  ...OPEN_TASK,
  id: 'task-done',
  title: 'Pay rent',
  completed: true,
};

let repository: InMemoryTaskRepository;
let clock: FixedClock;
let toggleTaskCompletion: ToggleTaskCompletion;

beforeEach(async () => {
  // Fresh per test, so no test can observe another's writes and no spy outlives its case.
  repository = new InMemoryTaskRepository();
  clock = createFixedClock(CREATED_INSTANT);
  toggleTaskCompletion = new ToggleTaskCompletion({ repository, clock });

  await repository.insert(OPEN_TASK);
  await repository.insert(COMPLETED_TASK);
});

/**
 * Asserts that `updated` is `seeded` with only `completed` and `updatedAt` changed.
 *
 * That pairing is the requirement of every success case below, so it is asserted in one place: the
 * six preserved fields are compared individually, `updatedAt` must equal the instant the injected
 * clock reports, and it must have moved off the seeded value. The domain module is not consulted, so
 * this compares the use case's output rather than re-deriving it.
 */
function expectOnlyCompletionToHaveChanged(
  updated: Task,
  seeded: Task,
  completed: boolean,
  expectedUpdatedAt: string,
): void {
  expect(updated.id).toBe(seeded.id);
  expect(updated.title).toBe(seeded.title);
  expect(updated.description).toBe(seeded.description);
  expect(updated.priority).toBe(seeded.priority);
  expect(updated.dueDate).toBe(seeded.dueDate);
  expect(updated.createdAt).toBe(seeded.createdAt);
  expect(updated.completed).toBe(completed);
  expect(updated.updatedAt).toBe(expectedUpdatedAt);
  expect(updated.updatedAt).not.toBe(seeded.updatedAt);
}

/**
 * Reads the store through the `TaskRepository` port and keys the tasks by identifier, because
 * `findAll` promises no order and a positional assertion would depend on one.
 */
async function readStore(port: TaskRepository): Promise<Map<string, Task>> {
  const stored = await port.findAll();

  return new Map(stored.map((task) => [task.id, task] as [string, Task]));
}

/** Asserts the store still holds exactly the two seeded fixtures, each deep-equal to its seed. */
async function expectStoreUntouched(): Promise<void> {
  const stored = await readStore(repository);

  expect(stored.size).toBe(2);
  expect(stored.get(OPEN_TASK.id)).toStrictEqual(OPEN_TASK);
  expect(stored.get(COMPLETED_TASK.id)).toStrictEqual(COMPLETED_TASK);
}

/**
 * Runs an execution that is expected to reject and returns the domain error it threw, so the failure
 * assertions read the error's own fields instead of narrowing `unknown`. An execution that resolves,
 * or that rejects with some other error, fails the case rather than passing it silently.
 */
async function captureTaskNotFound(run: () => Promise<Task>): Promise<TaskNotFoundError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return error;
    }

    throw error;
  }

  throw new Error('expected the execution to reject with TaskNotFoundError, but it resolved');
}

describe('ToggleTaskCompletion', () => {
  describe('both directions', () => {
    it('completes an open task', async () => {
      clock.advance(ONE_HOUR_MS);

      const updated = await toggleTaskCompletion.execute({ id: OPEN_TASK.id, completed: true });

      expectOnlyCompletionToHaveChanged(updated, OPEN_TASK, true, clock.now().toISOString());
    });

    it('reopens a completed task', async () => {
      clock.advance(ONE_HOUR_MS);

      const updated = await toggleTaskCompletion.execute({ id: COMPLETED_TASK.id, completed: false });

      expectOnlyCompletionToHaveChanged(updated, COMPLETED_TASK, false, clock.now().toISOString());
    });

    it('stores the transition, so a read afterwards returns the task this call resolved with', async () => {
      clock.advance(ONE_HOUR_MS);
      const completed = await toggleTaskCompletion.execute({ id: OPEN_TASK.id, completed: true });

      expect(await repository.findById(OPEN_TASK.id)).toStrictEqual(completed);

      clock.advance(ONE_HOUR_MS);
      const reopened = await toggleTaskCompletion.execute({ id: COMPLETED_TASK.id, completed: false });

      expect(await repository.findById(COMPLETED_TASK.id)).toStrictEqual(reopened);
      expect(completed.updatedAt).not.toBe(reopened.updatedAt);

      const stored = await readStore(repository);
      expect(stored.size).toBe(2);
      expect(stored.get(OPEN_TASK.id)).toStrictEqual(completed);
      expect(stored.get(COMPLETED_TASK.id)).toStrictEqual(reopened);
    });

    it('returns a new task and leaves the task the store held as it was', async () => {
      const heldBefore = await repository.findById(OPEN_TASK.id);

      clock.advance(ONE_HOUR_MS);
      const updated = await toggleTaskCompletion.execute({ id: OPEN_TASK.id, completed: true });

      // The transition builds the result rather than editing what it was given, so the task the store
      // handed out is neither the object this call resolved with nor altered by it.
      expect(updated).not.toBe(heldBefore);
      expect(heldBefore).toStrictEqual(OPEN_TASK);
      expect(updated).toStrictEqual({
        ...OPEN_TASK,
        completed: true,
        updatedAt: clock.now().toISOString(),
      });
    });
  });

  describe('failure paths', () => {
    it('raises TaskNotFoundError for an identifier no task holds, and stores nothing', async () => {
      clock.advance(ONE_HOUR_MS);

      const error = await captureTaskNotFound(() =>
        toggleTaskCompletion.execute({ id: 'missing', completed: true }),
      );

      expect(error).toBeInstanceOf(TaskNotFoundError);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.id).toBe('missing');
      expect(error.statusCode).toBe(404);
      expect(error.message).toContain('missing');
      await expectStoreUntouched();
    });

    it('raises TaskNotFoundError when the write replaced no row, without recreating the task', async () => {
      // The one route to this branch: the in-memory substitute answers `true` for any stored id, so the
      // port's "no row matched" report has to be produced by the double. It is the case a real store
      // raises when the task is deleted between the read and the write.
      const insertSpy = vi.spyOn(repository, 'insert');
      vi.spyOn(repository, 'update').mockResolvedValue(false);

      clock.advance(ONE_HOUR_MS);
      const error = await captureTaskNotFound(() =>
        toggleTaskCompletion.execute({ id: OPEN_TASK.id, completed: true }),
      );

      expect(error).toBeInstanceOf(TaskNotFoundError);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.id).toBe(OPEN_TASK.id);
      expect(error.statusCode).toBe(404);
      expect(insertSpy).not.toHaveBeenCalled();
      await expectStoreUntouched();
    });
  });
});
