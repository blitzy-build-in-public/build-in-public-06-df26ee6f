/**
 * Unit suite for the single-read use case, `GetTask` (`src/application/GetTask.ts`).
 *
 * The subject is constructed with the persistence port over `InMemoryTaskRepository`, so no SQLite
 * file, driver, framework or server is involved; it takes no clock because a read writes nothing,
 * and every timestamp below is a fixed ISO literal rather than a reading of the wall clock.
 *
 * What it evidences:
 *
 * - AAP 0.10.2's unit-application row for this use case: the stored task comes back deep-equal, and
 *   an identifier matching no task is the only other outcome.
 * - AAP 0.10.5's missing-record failure path, which is half of the evidence that `GET /api/tasks/:id`
 *   answers 200 and 404 — the response envelope and the status line belong to the route
 *   integration suite, so nothing here asserts either.
 * - AAP 0.2.1/0.7.1's one-read discipline: `execute` is a single call to `findById`, never a scan of
 *   `findAll` with an in-memory lookup over the result.
 * - This folder's share of AAP 0.10.6's ≥90% line, statement, function and branch gate over
 *   `src/application/**`.
 *
 * It deliberately does not restate the port's own conventions — a miss resolving `null`, values
 * being copied on the way in and out. The shared conformance suite in
 * `tests/contract/taskRepositoryContract.ts` owns those against both implementations, and a second
 * copy here could only drift from it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GetTask } from '../../../src/application/GetTask.js';
import type { TaskRepository } from '../../../src/application/TaskRepository.js';
import { TaskNotFoundError } from '../../../src/domain/errors.js';
import type { Task } from '../../../src/domain/task.js';
import { InMemoryTaskRepository } from '../../support/inMemoryTaskRepository.js';

/**
 * An open task owing nothing but a title: `dueDate: null` and `description: ''` are the two fields
 * a round trip is most likely to lose, because they are the ones a careless mapping drops or turns
 * into `undefined`.
 */
const OPEN_TASK: Task = {
  id: 'task-open',
  title: 'Buy milk',
  description: '',
  priority: 'low',
  dueDate: null,
  completed: false,
  createdAt: '2026-02-01T09:15:00.000Z',
  updatedAt: '2026-02-01T09:15:00.000Z',
};

/**
 * The opposite case in every dimension the entity has: a populated description, a set due date, a
 * different priority, a completed task and two distinct timestamps.
 */
const POPULATED_TASK: Task = {
  id: 'task-populated',
  title: 'Pay rent',
  description: 'the March invoice',
  priority: 'high',
  dueDate: '2026-03-01',
  completed: true,
  createdAt: '2026-01-05T08:00:00.000Z',
  updatedAt: '2026-01-06T08:00:00.000Z',
};

/** An identifier of the shape the system generates, held by no task. */
const UNKNOWN_ID = 'missing';

/** An identifier that is not a UUID at all. AAP 0.5.5 makes it indistinguishable from a deleted one. */
const MALFORMED_ID = 'not-a-uuid-at-all';

/** The fixtures the read is exercised over, each named for the case it contributes. */
const READ_CASES: ReadonlyArray<readonly [string, Task]> = [
  ['an open task with no due date and an empty description', OPEN_TASK],
  ['a completed task with a set due date and a populated description', POPULATED_TASK],
];

/** The read use case and the port it reads through, rebuilt for every test. */
let repository: TaskRepository;
let getTask: GetTask;

beforeEach(async () => {
  repository = new InMemoryTaskRepository();
  getTask = new GetTask({ repository });

  // Written through the port, so the subject reads stored records rather than fixtures handed to it
  // directly. The port type on `repository` is what makes this a check as well as a convenience:
  // `GetTask` would fail to compile here if it ever asked for the concrete substitute or for a
  // dependency a read does not need, such as the clock.
  await repository.insert(OPEN_TASK);
  await repository.insert(POPULATED_TASK);
});

/**
 * Executes the read for `id` and returns the failure it raised, so a test can assert the error's
 * own members rather than only that something was rejected. An error of any other type is rethrown,
 * and a read that unexpectedly resolves fails the test with the identifier it wrongly found.
 */
async function captureNotFound(id: string): Promise<TaskNotFoundError> {
  try {
    await getTask.execute({ id });
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return error;
    }

    throw error;
  }

  throw new Error(`GetTask resolved rather than raising TaskNotFoundError for "${id}"`);
}

describe('GetTask', () => {
  it.each(READ_CASES)('returns %s deep-equal to the stored entity', async (_label, fixture) => {
    await expect(getTask.execute({ id: fixture.id })).resolves.toEqual(fixture);
  });

  it('reads the task with exactly one findById call and no scan or write', async () => {
    const findByIdSpy = vi.spyOn(repository, 'findById');
    const findAllSpy = vi.spyOn(repository, 'findAll');
    const insertSpy = vi.spyOn(repository, 'insert');
    const updateSpy = vi.spyOn(repository, 'update');
    const deleteSpy = vi.spyOn(repository, 'delete');

    await getTask.execute({ id: POPULATED_TASK.id });

    expect(findByIdSpy).toHaveBeenCalledTimes(1);
    expect(findByIdSpy).toHaveBeenCalledWith(POPULATED_TASK.id);
    // A read that listed the table and filtered it in memory would call `findAll` instead, which is
    // the cost this use case must not carry; a read that wrote anything would call one of the rest.
    expect(findAllSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('raises TaskNotFoundError for an identifier held by no task', async () => {
    const error = await captureNotFound(UNKNOWN_ID);

    expect(error).toBeInstanceOf(TaskNotFoundError);
    expect(error.id).toBe(UNKNOWN_ID);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.message).toContain(UNKNOWN_ID);
  });

  it('raises TaskNotFoundError for an identifier that is not a UUID at all', async () => {
    // Never a validation error: AAP 0.5.5 accepts the path identifier as supplied, so "malformed"
    // and "deleted" are deliberately the same outcome for a client.
    const error = await captureNotFound(MALFORMED_ID);

    expect(error).toBeInstanceOf(TaskNotFoundError);
    expect(error.id).toBe(MALFORMED_ID);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.message).toContain(MALFORMED_ID);
  });

  it('leaves the store untouched when the identifier is unknown', async () => {
    await captureNotFound(UNKNOWN_ID);

    const stored = await repository.findAll();

    // Compared per element rather than per index: `findAll` guarantees the whole set, never an
    // order, so asserting an order here would test the substitute's `Map` iteration instead.
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(expect.arrayContaining([OPEN_TASK, POPULATED_TASK]));
  });
});
