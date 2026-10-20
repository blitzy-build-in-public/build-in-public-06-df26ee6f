import type { TaskRepository } from '../../src/application/TaskRepository.js';
import type { Task } from '../../src/domain/task.js';

/**
 * An in-memory {@link TaskRepository} for the inner-layer tests: the substitute every domain and
 * application suite is constructed with, so the use cases run against a real implementation of
 * their port while no SQLite file, driver or framework is present.
 *
 * This is test support rather than a second production adapter — the only adapter the process
 * runs is built in the composition root — and `backend/tests/contract/taskRepositoryContract.ts`
 * runs the identical assertions against this class and against `SqliteTaskRepository`, so the two
 * cannot drift: a behaviour asserted here is a behaviour the shipped store must also have.
 *
 * The contract it satisfies, which is the port's own contract:
 *
 * - `insert` stores a new task and must not overwrite an identifier already present; only
 *   `update` replaces a stored record.
 * - `update` and `delete` answer `true` only when a record actually matched. `false` means the
 *   task is no longer stored — deleted since it was read — which is what the use cases turn into
 *   the domain's `TaskNotFoundError` and the HTTP layer into a 404. Neither is emulated with an
 *   upsert: an upsert would silently recreate a record deleted between a read and the write that
 *   followed it, undoing a delete that had already succeeded (AAP 0.2.2).
 * - `findAll` returns every stored task, with no filtering and no ordering guarantee. Filtering
 *   and sorting belong to the application layer, in one shared implementation, so that two stores
 *   cannot produce two different orderings; the order this class happens to yield is `Map`
 *   insertion order, which is deterministic but is not part of the contract and must not be
 *   asserted.
 * - Every task handed in and every task handed out is a copy, so no caller can reach stored state
 *   by holding on to a value it passed in or was given.
 * - Every member returns a promise although the store is synchronous, so a store that answers
 *   asynchronously can replace this one without a single caller changing.
 *
 * Nothing here reads the clock, generates an identifier, validates a field or names a column: a
 * task arrives complete, with its `id`, `createdAt` and `updatedAt` already stamped by the create
 * use case, and is stored exactly as given.
 */
export class InMemoryTaskRepository implements TaskRepository {
  /** The store itself. One `Map` per instance, so no two instances share state. */
  private readonly tasks = new Map<string, Task>();

  /**
   * Creates a store holding `seed`, or an empty store when no seed is given.
   *
   * Each seeded task is written by the same code path as `insert`, so a seed that repeats an
   * identifier is rejected exactly as a repeated `insert` is and the store can never present two
   * rows for one id.
   */
  constructor(seed: readonly Task[] = []) {
    for (const task of seed) {
      this.writeNew(task);
    }
  }

  /** Stores a new task; a repeated identifier is rejected rather than overwritten. */
  async insert(task: Task): Promise<void> {
    this.writeNew(task);
  }

  /** Returns a copy of the stored task, or `null` when no task holds this identifier. */
  async findById(id: string): Promise<Task | null> {
    const stored = this.tasks.get(id);

    // `noUncheckedIndexedAccess` is why the miss is tested against `undefined` rather than
    // falsiness: `Map.get` is typed `Task | undefined`, and a stored task is always a real one.
    return stored === undefined ? null : copyOf(stored);
  }

  /** Returns a copy of every stored task, unfiltered and in no contractual order. */
  async findAll(): Promise<Task[]> {
    return [...this.tasks.values()].map(copyOf);
  }

  /**
   * Replaces the stored task with the whole entity given, and reports whether a record was
   * replaced: `false` for an identifier that is not stored, in which case nothing is created.
   */
  async update(task: Task): Promise<boolean> {
    if (!this.tasks.has(task.id)) {
      return false;
    }

    // The entire entity is stored, not a merge of changed fields, so the caller's `updatedAt`
    // and its untouched `createdAt` are persisted exactly as computed.
    this.tasks.set(task.id, copyOf(task));
    return true;
  }

  /** Removes the stored task and reports whether a record was really removed. */
  async delete(id: string): Promise<boolean> {
    return this.tasks.delete(id);
  }

  /**
   * Writes a task that must not already be stored.
   *
   * A duplicate identifier is refused instead of overwriting the stored task, which mirrors the
   * SQLite adapter, where a plain `INSERT` into a table whose `id` is the primary key fails on a
   * duplicate. Refusing also keeps the two implementations observably identical for the one case
   * the contract's shared suite exercises in both.
   */
  private writeNew(task: Task): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`duplicate task id: ${task.id}`);
    }

    this.tasks.set(task.id, copyOf(task));
  }
}

/**
 * Copies a task on its way into or out of the store.
 *
 * Storing and returning the caller's own object would let a test — or a use case — mutate what is
 * stored simply by mutating a value it was handed, and the shared contract asserts that it
 * cannot. A structural clone is enough for the entity: it is eight fields, all primitives, one of
 * them `null`.
 */
function copyOf(task: Task): Task {
  return structuredClone(task);
}
