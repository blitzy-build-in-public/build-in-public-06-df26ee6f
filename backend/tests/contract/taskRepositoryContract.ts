/**
 * The shared conformance suite for the `TaskRepository` port: the storage semantics every
 * implementation must satisfy, asserted identically against each one so that no implementation
 * can satisfy them privately and none can drift away from the others.
 *
 * It exists because the storage mechanism is meant to be replaceable. `taskRepository.test.ts`
 * runs this one suite twice — against `SqliteTaskRepository` on a temporary database file
 * reserved by `backend/tests/support/tempDatabase.ts`, and against the `Map`-backed in-memory
 * implementation in `backend/tests/support/inMemoryTaskRepository.ts` — and both runs must pass.
 * That is the automated evidence for acceptance criterion 10: substituting the adapter requires
 * no change to `src/domain` or `src/application`, because both implementations are driven here
 * through the port alone and each is held to the same observable behaviour.
 *
 * What it asserts is exactly what the port promises: a store starts empty; a task round-trips
 * through `insert` and `findById` with every field's own kind intact; `findAll` lists every
 * stored task once and in no particular order; reads hand out copies rather than aliases;
 * `update` and `delete` report whether a record really matched instead of upserting one into
 * existence; a deleted record stays deleted; and a repeated `insert` cannot overwrite what is
 * already stored. Field rules, defaults, normalisation and their messages are the domain's and
 * are asserted by the domain and HTTP suites — duplicating any of them here would freeze an
 * adapter against a rule it does not own.
 *
 * This is a suite module, not a test file: its name carries no `.test` suffix and it registers
 * nothing at import time, so the runner never collects it directly and every hook and every test
 * below is registered only when the factory is called. Every fixture is a literal identifier and
 * a literal ISO timestamp, so no assertion here depends on the wall clock, on an identifier
 * generator, on a socket or on the file system.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TaskRepository } from '../../src/application/TaskRepository.js';
import type { Task } from '../../src/domain/task.js';

/** What the factory needs in order to register the suite against one implementation. */
export interface TaskRepositoryContractOptions {
  /** The title of the `describe` block, naming the implementation under test. */
  name: string;

  /**
   * Builds the store the next test runs against, and optionally disposes of it afterwards.
   *
   * It is called once per test and must therefore hand back a fresh, empty store each time: an
   * implementation that carried state between two calls would let one test observe another's
   * records and turn an empty-store assertion into a false failure rather than a real one. The
   * returned `cleanup`, when present, is awaited in the test's `afterEach` — a temporary database
   * file is removed there — and is never called with the store still in use.
   */
  createRepository(): Promise<{ repository: TaskRepository; cleanup?: () => Promise<void> | void }>;
}

/** The instant a fixture is created at; a literal, so no fixture reads the wall clock. */
const CREATED_AT = '2026-02-01T09:15:00.000Z';

/** A later literal instant, so a write's `updatedAt` is distinguishable from its `createdAt`. */
const UPDATED_AT = '2026-02-02T10:30:00.000Z';

/**
 * A complete task fixture. Every one of the eight fields is present and literal — an empty or
 * absent optional value is spelled `''` or `null` rather than omitted — so a round-trip assertion
 * compares the full entity a store was handed with the full entity it returns.
 *
 * `id` is required because it is the one field every assertion addresses a record by, and a
 * generated identifier would make the suite non-reproducible.
 */
function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    title: 'Write the contract suite',
    description: '',
    priority: 'medium',
    dueDate: null,
    completed: false,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/**
 * The identifiers of a listed set, sorted, which is how this suite compares `findAll` results.
 *
 * The port guarantees no ordering, so a positional comparison would assert something the contract
 * does not promise and would fail for the wrong reason the moment an adapter changed its scan
 * order.
 */
function idsOf(tasks: readonly Task[]): string[] {
  return tasks.map((task) => task.id).sort();
}

/**
 * Reads a task through the port and fails loudly when the store does not hold it, so that a test
 * can go on to assert individual fields without a non-null assertion.
 */
async function readStored(repository: TaskRepository, id: string): Promise<Task> {
  const task = await repository.findById(id);

  if (task === null) {
    throw new Error(`expected the store to hold a task with id ${id}`);
  }

  return task;
}

/**
 * Registers the conformance suite for the `TaskRepository` port.
 *
 * The hooks are declared inside the `describe` block rather than beside this factory, so they
 * belong to the contract's own tests alone: they cannot wrap a sibling suite in the invoking file,
 * and a second call of this factory cannot open a second store for a test that only uses the
 * first.
 */
export function describeTaskRepositoryContract(options: TaskRepositoryContractOptions): void {
  let current:
    | { repository: TaskRepository; cleanup?: () => Promise<void> | void }
    | undefined;

  /**
   * The store the running test was given. This narrows `current` instead of asserting it, so the
   * suite stays honest under `noUncheckedIndexedAccess` and a test that runs without a store fails
   * with a message that says so.
   */
  function store(): TaskRepository {
    if (current === undefined) {
      throw new Error('the repository under test has not been created for this test');
    }

    return current.repository;
  }

  describe(options.name, () => {
    beforeEach(async () => {
      current = await options.createRepository();
    });

    afterEach(async () => {
      await current?.cleanup?.();
      current = undefined;
    });

    it('holds nothing before the first insert', async () => {
      expect(await store().findAll()).toStrictEqual([]);
      expect(await store().findById('task-missing')).toBeNull();
    });

    it('returns an inserted task from findById and lists its identifier', async () => {
      const task = makeTask({ id: 'task-round-trip' });

      await store().insert(task);

      expect(await store().findById(task.id)).toStrictEqual(task);
      expect(idsOf(await store().findAll())).toStrictEqual([task.id]);
    });

    it('round-trips empty and populated optional values without changing their kind', async () => {
      const empty = makeTask({ id: 'task-empty-values' });
      const populated = makeTask({
        id: 'task-populated-values',
        title: 'Buy milk',
        description: 'A description that survives the round trip',
        priority: 'high',
        dueDate: '2026-02-14',
        completed: true,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });

      await store().insert(empty);
      await store().insert(populated);

      const readEmpty = await readStored(store(), empty.id);
      const readPopulated = await readStored(store(), populated.id);

      // Value identity, not truthiness: a row mapper that stored or returned `1`/`0` for
      // `completed` passes a truthy test and fails these.
      expect(readEmpty.completed).toBe(false);
      expect(readEmpty.description).toBe('');
      // Absence of a due date is null, never `''` and never undefined.
      expect(readEmpty.dueDate).toBeNull();
      expect(readEmpty).toStrictEqual(empty);

      expect(readPopulated.completed).toBe(true);
      expect(readPopulated.description).toBe('A description that survives the round trip');
      expect(readPopulated.dueDate).toBe('2026-02-14');
      expect(readPopulated.priority).toBe('high');
      expect(readPopulated).toStrictEqual(populated);
    });

    it('lists every inserted task once, in no particular order', async () => {
      // Insertion order deliberately differs from identifier order, so a store that happens to
      // list in insertion order cannot pass by coincidence.
      const insertedIds = ['task-b', 'task-a', 'task-d', 'task-c'];

      for (const id of insertedIds) {
        await store().insert(makeTask({ id }));
      }

      const tasks = await store().findAll();

      expect(idsOf(tasks)).toStrictEqual([...insertedIds].sort());
      expect(tasks.length).toBe(new Set(insertedIds).size);
      expect(new Set(idsOf(tasks)).size).toBe(tasks.length);
    });

    it('hands out copies, so mutating a returned task or array cannot change what is stored', async () => {
      const task = makeTask({ id: 'task-copies' });

      await store().insert(task);

      const returned = await readStored(store(), task.id);
      Object.assign(returned, { title: 'mutated after read', completed: true });

      expect(await readStored(store(), task.id)).toStrictEqual(task);

      const listed = await store().findAll();
      listed.push(makeTask({ id: 'task-injected' }));

      const relisted = await store().findAll();

      expect(relisted.length).toBe(1);
      expect(relisted).toStrictEqual([task]);
    });

    it('replaces the stored task when update matches a record, and reports that it did', async () => {
      const original = makeTask({ id: 'task-updated', title: 'Original title' });

      await store().insert(original);

      const updated: Task = {
        ...original,
        title: 'Updated title',
        description: 'Updated description',
        priority: 'high',
        dueDate: '2026-03-01',
        completed: true,
        updatedAt: UPDATED_AT,
      };

      expect(await store().update(updated)).toBe(true);

      const stored = await readStored(store(), updated.id);

      expect(stored).toStrictEqual(updated);
      // The write replaced the record wholesale, so a creation instant an adapter derived or
      // rewrote itself rather than carrying from the entity shows up here.
      expect(stored.createdAt).toBe(original.createdAt);
      expect(stored.updatedAt).toBe(UPDATED_AT);
      expect(await store().findAll()).toStrictEqual([updated]);
    });

    it('returns false from update for an identifier it does not hold and creates no record', async () => {
      const existing = makeTask({ id: 'task-existing' });

      await store().insert(existing);

      expect(await store().update(makeTask({ id: 'task-unknown' }))).toBe(false);
      expect(await store().findById('task-unknown')).toBeNull();

      const remaining = await store().findAll();

      expect(remaining.length).toBe(1);
      expect(idsOf(remaining)).toStrictEqual([existing.id]);
    });

    it('removes a stored task when delete matches a record, and reports that it did', async () => {
      const task = makeTask({ id: 'task-deleted' });

      await store().insert(task);

      expect(await store().delete(task.id)).toBe(true);
      expect(await store().findById(task.id)).toBeNull();
      expect(idsOf(await store().findAll())).not.toContain(task.id);
    });

    it('returns false when a delete removes no record', async () => {
      const task = makeTask({ id: 'task-delete-twice' });

      await store().insert(task);

      expect(await store().delete(task.id)).toBe(true);
      expect(await store().delete(task.id)).toBe(false);
      expect(await store().delete('task-never-stored')).toBe(false);
    });

    it('does not resurrect a deleted task when update is asked for it again', async () => {
      const task = makeTask({ id: 'task-resurrection' });

      await store().insert(task);
      expect(await store().delete(task.id)).toBe(true);

      expect(await store().update(task)).toBe(false);
      expect(await store().findById(task.id)).toBeNull();
      expect(await store().findAll()).toStrictEqual([]);
    });

    it('leaves the stored record untouched when insert is repeated with the same identifier', async () => {
      const original = makeTask({ id: 'task-duplicate', title: 'The stored title' });
      const duplicate = makeTask({ id: original.id, title: 'A second title for one identifier' });

      await store().insert(original);

      // An implementation may refuse the duplicate outright or ignore it; the port requires only
      // that the first record survives, so either outcome is accepted here rather than pinned.
      await store().insert(duplicate).catch(() => undefined);

      expect(await readStored(store(), original.id)).toStrictEqual(original);
      expect(await store().findAll()).toStrictEqual([original]);
    });
  });
}
