/**
 * The persistence port: the single boundary between the application's use cases and
 * wherever tasks happen to be stored.
 *
 * The use cases depend on this interface and never on an implementation of it, which is
 * what makes the storage mechanism replaceable without touching `src/domain` or
 * `src/application`. The adapter the running process uses is constructed once, in the
 * composition root; the tests supply their own in-memory implementation. Nothing here
 * names either one, and no storage type appears in a signature, so swapping the store is
 * a wiring change rather than a rewrite.
 *
 * The contract every implementation must satisfy:
 *
 * - `insert` and `update` are two operations, never one `save`. An upsert would recreate a
 *   task that was deleted between a read and a write, quietly undoing the delete; keeping
 *   them apart means a write aimed at a record that no longer exists is reported instead.
 * - A write that matched no row is a failure the caller must see. `update` and `delete`
 *   answer `false` rather than succeeding silently, and the use cases turn that `false`
 *   into the domain's `TaskNotFoundError`, which the HTTP layer maps to 404. Neither may
 *   be emulated with an upsert.
 * - Implementations store what they are handed: no identifier is generated, no clock is
 *   read, no field is validated and no value is reformatted here. A new task already
 *   carries its `id`, `createdAt` and `updatedAt` from the create use case, and
 *   `updatedAt` has already advanced by the time `update` is called.
 * - Implementations must not mutate the task objects they are given and must not hand out
 *   aliases to stored state, so that a caller cannot alter what is stored by holding on to
 *   a value it was given or passed in.
 * - Concurrency is last write wins. A patch loads a task, merges the supplied fields into
 *   it and writes the whole record back, so whichever write commits last survives. There
 *   is no version column, no compare-and-set and no conflict result in this contract, and
 *   none is to be added.
 *
 * Every member returns a promise even where the underlying store is synchronous, so that
 * the application layer is never told how the data is held and a store that answers
 * asynchronously can replace this one without changing a single caller.
 */
import type { Task } from '../domain/task.js';

export interface TaskRepository {
  /**
   * Stores a new task, which must not already exist: an identifier already present in the
   * store is an error rather than an overwrite or a merge, because only `update` replaces a
   * stored record. Resolves with no value once the task is stored.
   */
  insert(task: Task): Promise<void>;

  /**
   * Returns the task holding this identifier, or `null` when no task holds it. A miss is
   * not an error: this resolves `null` and never throws for it, leaving the caller to
   * report the domain's `TaskNotFoundError` (404) rather than a storage failure.
   */
  findById(id: string): Promise<Task | null>;

  /**
   * Returns every stored task — with no filtering and no ordering guarantee, so no caller
   * may rely on the order or on a subset. Filtering and sorting belong to the application
   * layer, in one shared implementation, precisely so that two stores cannot produce two
   * different orderings: the listing use case issues exactly one call to this member and
   * does both in memory.
   */
  findAll(): Promise<Task[]>;

  /**
   * Replaces the stored task wholesale with the value given and returns `true` only when a
   * record was actually replaced. `false` means the task is no longer stored — deleted
   * since it was read — and the caller reports not-found rather than recreating it.
   */
  update(task: Task): Promise<boolean>;

  /**
   * Removes the task holding this identifier and returns `true` only when a record was
   * really removed. `false` means it was already gone, which is what makes the first delete
   * a 204 and a repeat of the same delete a 404.
   */
  delete(id: string): Promise<boolean>;
}
