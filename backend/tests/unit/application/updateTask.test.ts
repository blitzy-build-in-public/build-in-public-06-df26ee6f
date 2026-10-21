/**
 * Unit suite for the `UpdateTask` use case: a partial patch applied through the persistence port.
 *
 * The use case is constructed exactly as the composition root constructs it, but with the two
 * substitutes the application layer is tested against — `InMemoryTaskRepository` and a clock frozen
 * at a fixed instant — so no framework, no SQLite file and no filesystem takes part, and no
 * assertion depends on when the suite ran. This is the executable evidence that a patch changes
 * the fields it names, that `createdAt` never moves and `updatedAt` advances, and that the store is
 * replaceable without touching the domain or the application.
 *
 * Every rejection case also asserts the stored record is untouched, and the last two cases pin the
 * port's safety rule: a write that replaced no row means the task is gone, so the use case reports
 * `TaskNotFoundError` rather than a silent success and never calls `insert`, which is what stops a
 * task deleted between the read and the write from being resurrected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateTask } from '../../../src/application/UpdateTask.js';
import {
  VALIDATION_ERROR_MESSAGE,
  TaskNotFoundError,
  ValidationError,
} from '../../../src/domain/errors.js';
import type { Task, TaskPatch } from '../../../src/domain/task.js';
import { createFixedClock } from '../../support/fixedClock.js';
import type { FixedClock } from '../../support/fixedClock.js';
import { InMemoryTaskRepository } from '../../support/inMemoryTaskRepository.js';

/** The instant the seeded task was created at, and the instant the frozen clock starts from. */
const CREATED_INSTANT = new Date('2026-02-01T09:15:00.000Z');

/** The instant every update below is applied at: one hour after the task was created. */
const LATER_INSTANT = new Date('2026-02-01T10:15:00.000Z');

/** The advance that moves the frozen clock from {@link CREATED_INSTANT} to {@link LATER_INSTANT}. */
const ONE_HOUR_MS = 3_600_000;

/** The task every case starts from; a partial patch must leave all of it but its own field alone. */
const SEEDED: Task = {
  id: 'task-0001',
  title: 'Buy milk',
  description: 'two litres',
  priority: 'medium',
  dueDate: '2026-03-01',
  completed: false,
  createdAt: CREATED_INSTANT.toISOString(),
  updatedAt: CREATED_INSTANT.toISOString(),
};

/** The identifier no case stores, used for the missing-record paths. */
const MISSING_ID = 'task-missing';

/**
 * The whole task a successful patch is expected to yield: the seeded task with `updatedAt` moved to
 * the instant the write was applied, plus whatever the case changed.
 *
 * Comparing against the whole entity rather than the one patched field is what proves every field
 * the patch did not name was carried over untouched and that only `updatedAt` moved.
 */
function updatedFrom(overrides: Partial<Task> = {}): Task {
  return { ...SEEDED, updatedAt: LATER_INSTANT.toISOString(), ...overrides };
}

/**
 * Runs `operation` and returns whatever it rejected with.
 *
 * The rejection is returned rather than re-thrown so a case can assert the error's own fields. An
 * operation that resolves, or rejects with nothing, fails the test here, so a rejection that never
 * happened cannot make the assertions below it look satisfied.
 */
async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error: unknown) {
    return error;
  }

  throw new Error('expected the operation to reject, but it resolved');
}

/**
 * Asserts that `error` is the domain's not-found failure naming `id`, and returns it narrowed so the
 * case can assert the status the interface will return.
 */
function expectTaskNotFoundError(error: unknown, id: string): TaskNotFoundError {
  expect(error).toBeInstanceOf(TaskNotFoundError);
  if (!(error instanceof TaskNotFoundError)) {
    throw new Error('expected a TaskNotFoundError');
  }

  expect(error.id).toBe(id);
  return error;
}

/**
 * Asserts that `error` is the domain's rule violation carrying exactly `expectedFields`, and returns
 * it narrowed.
 *
 * The whole field map is compared, so each case proves its own message and that no other field was
 * reported; the summary and the status come from the error object itself, and the summary is checked
 * against the constant the module exports rather than against a copy of the sentence.
 */
function expectValidationError(
  error: unknown,
  expectedFields: Record<string, string>,
): ValidationError {
  expect(error).toBeInstanceOf(ValidationError);
  if (!(error instanceof ValidationError)) {
    throw new Error('expected a ValidationError');
  }

  expect(error.code).toBe('VALIDATION_ERROR');
  expect(error.statusCode).toBe(400);
  expect(error.message).toBe(VALIDATION_ERROR_MESSAGE);
  expect(error.fields).toEqual(expectedFields);
  return error;
}

/** One case of the proof that each patchable field is patchable on its own. */
interface SingleFieldCase {
  /** The field this case patches; interpolated into the test name so a failure names the field. */
  readonly name: string;
  readonly patch: TaskPatch;
  /** The whole task expected afterwards. */
  readonly expected: Task;
}

const SINGLE_FIELD_CASES: readonly SingleFieldCase[] = [
  {
    name: 'description',
    patch: { description: 'three litres' },
    expected: updatedFrom({ description: 'three litres' }),
  },
  {
    name: 'priority',
    patch: { priority: 'high' },
    expected: updatedFrom({ priority: 'high' }),
  },
  {
    name: 'dueDate',
    patch: { dueDate: '2026-04-01' },
    expected: updatedFrom({ dueDate: '2026-04-01' }),
  },
];

/** One case of the proof that an unacceptable patch is rejected with its field's message. */
interface InvalidPatchCase {
  /** What the case supplies; interpolated into the test name. */
  readonly name: string;
  readonly patch: TaskPatch;
  /** The exact field map the case must report, keyed by the name the interface's form uses. */
  readonly expectedFields: Record<string, string>;
}

const INVALID_PATCH_CASES: readonly InvalidPatchCase[] = [
  {
    name: 'a whitespace-only title',
    patch: { title: '   ' },
    expectedFields: { title: 'Title is required' },
  },
  {
    name: 'an unsupported priority',
    patch: { priority: 'urgent' },
    expectedFields: { priority: 'Priority must be one of: low, medium, high' },
  },
  {
    name: 'a date that matches the shape but is not a calendar date',
    patch: { dueDate: '2026-02-30' },
    expectedFields: { dueDate: 'Due date must be a valid calendar date' },
  },
  {
    name: 'an unknown property',
    patch: { colour: 'red' },
    expectedFields: { colour: 'Unknown field' },
  },
  {
    name: 'the read-only createdAt field',
    patch: { createdAt: '2026-01-01T00:00:00.000Z' },
    expectedFields: { createdAt: 'createdAt cannot be changed' },
  },
  {
    name: 'the read-only id field',
    patch: { id: 'task-0002' },
    expectedFields: { id: 'id cannot be changed' },
  },
];

describe('UpdateTask', () => {
  let repository: InMemoryTaskRepository;
  let clock: FixedClock;
  let updateTask: UpdateTask;

  beforeEach(async () => {
    repository = new InMemoryTaskRepository();
    clock = createFixedClock(CREATED_INSTANT);
    updateTask = new UpdateTask({ repository, clock });
    await repository.insert(SEEDED);
  });

  it('changes only the patched field and leaves every other field untouched', async () => {
    clock.advance(ONE_HOUR_MS);

    const updated = await updateTask.execute({ id: SEEDED.id, patch: { title: 'Buy oat milk' } });

    expect(updated.id).toBe(SEEDED.id);
    expect(updated.title).toBe('Buy oat milk');
    expect(updated.description).toBe(SEEDED.description);
    expect(updated.priority).toBe(SEEDED.priority);
    expect(updated.dueDate).toBe(SEEDED.dueDate);
    expect(updated.completed).toBe(SEEDED.completed);
    expect(updated.createdAt).toBe(SEEDED.createdAt);
    expect(updated.updatedAt).toBe(clock.now().toISOString());
    expect(updated.updatedAt).not.toBe(SEEDED.updatedAt);
  });

  it('persists the update, so a later read returns the task it returned', async () => {
    clock.advance(ONE_HOUR_MS);

    const updated = await updateTask.execute({ id: SEEDED.id, patch: { title: 'Buy oat milk' } });

    expect(await repository.findById(SEEDED.id)).toEqual(updated);
    const stored = await repository.findAll();
    expect(stored).toHaveLength(1);
    expect(stored).toEqual([updated]);
  });

  it.each(SINGLE_FIELD_CASES)(
    'patches $name on its own and carries every other field over',
    async ({ patch, expected }) => {
      clock.advance(ONE_HOUR_MS);

      const updated = await updateTask.execute({ id: SEEDED.id, patch });

      expect(updated).toEqual(expected);
      expect(await repository.findById(SEEDED.id)).toEqual(expected);
    },
  );

  it('applies completed alongside another field, as a full form save does', async () => {
    clock.advance(ONE_HOUR_MS);

    const updated = await updateTask.execute({
      id: SEEDED.id,
      patch: { completed: true, title: 'done' },
    });

    expect(updated).toEqual(updatedFrom({ completed: true, title: 'done' }));
    expect(await repository.findById(SEEDED.id)).toEqual(updated);
  });

  it('clears a due date when the patch supplies null', async () => {
    clock.advance(ONE_HOUR_MS);

    const updated = await updateTask.execute({ id: SEEDED.id, patch: { dueDate: null } });

    expect(updated.dueDate).toBeNull();
    expect(updated.title).toBe(SEEDED.title);
    expect(updated.updatedAt).toBe(LATER_INSTANT.toISOString());
    expect(await repository.findById(SEEDED.id)).toEqual(updated);
  });

  it('clears a description when the patch supplies an empty string', async () => {
    clock.advance(ONE_HOUR_MS);

    const updated = await updateTask.execute({ id: SEEDED.id, patch: { description: '' } });

    expect(updated.description).toBe('');
    expect(updated.title).toBe(SEEDED.title);
    expect(updated.updatedAt).toBe(LATER_INSTANT.toISOString());
    expect(await repository.findById(SEEDED.id)).toEqual(updated);
  });

  it('advances updatedAt on a patch that supplies only a value the task already holds', async () => {
    clock.advance(ONE_HOUR_MS);

    const updated = await updateTask.execute({ id: SEEDED.id, patch: { title: SEEDED.title } });

    expect(updated).toEqual(updatedFrom());
    expect(updated.createdAt).toBe(SEEDED.createdAt);
    expect(updated.updatedAt).not.toBe(SEEDED.updatedAt);
  });

  it('raises TaskNotFoundError for an unknown identifier and leaves the store untouched', async () => {
    clock.advance(ONE_HOUR_MS);

    const error = await captureError(() =>
      updateTask.execute({ id: MISSING_ID, patch: { title: 'Buy oat milk' } }),
    );

    const notFound = expectTaskNotFoundError(error, MISSING_ID);
    expect(notFound.code).toBe('NOT_FOUND');
    expect(notFound.statusCode).toBe(404);
    expect(notFound.message).toContain(MISSING_ID);
    expect(await repository.findAll()).toEqual([SEEDED]);
  });

  it.each(INVALID_PATCH_CASES)(
    'rejects $name with its field message and stores nothing',
    async ({ patch, expectedFields }) => {
      clock.advance(ONE_HOUR_MS);

      const error = await captureError(() => updateTask.execute({ id: SEEDED.id, patch }));

      expectValidationError(error, expectedFields);
      expect(await repository.findAll()).toEqual([SEEDED]);
    },
  );

  it('reports a write that replaced no row as missing, without recreating the task', async () => {
    clock.advance(ONE_HOUR_MS);
    const insertSpy = vi.spyOn(repository, 'insert');
    const updateSpy = vi.spyOn(repository, 'update').mockResolvedValue(false);

    const error = await captureError(() =>
      updateTask.execute({ id: SEEDED.id, patch: { title: 'Buy oat milk' } }),
    );

    const notFound = expectTaskNotFoundError(error, SEEDED.id);
    expect(notFound.statusCode).toBe(404);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(await repository.findAll()).toEqual([SEEDED]);
  });

  it('passes the merged entity, not a fresh one, to the repository', async () => {
    clock.advance(ONE_HOUR_MS);
    const updateSpy = vi.spyOn(repository, 'update');

    const updated = await updateTask.execute({ id: SEEDED.id, patch: { priority: 'high' } });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const firstCall = updateSpy.mock.calls.at(0);
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toEqual(updatedFrom({ priority: 'high' }));
    // The spy wraps the real method, so the write it recorded really replaced the stored row.
    expect(await repository.findById(SEEDED.id)).toEqual(updated);
  });
});
