/**
 * The listing use case behind `GET /api/tasks`: one read of the stored tasks, filtered and sorted
 * by the query the request carried.
 *
 * The read is exactly one call to `TaskRepository.findAll()` — never one call per filter, never a
 * second read to count — and the filtering and the ordering happen in memory on the array that one
 * call returned. That is what keeps the first list render inside its sub-second budget at a
 * thousand tasks, and it is also what keeps the ordering single-sourced: the adapter returns rows
 * unordered, `taskQuery.ts` decides the order, and this module is the only place the two meet.
 *
 * Nothing here validates, reads a clock or writes. `parseTaskQuery` has already turned the raw
 * query string into a complete `TaskQuery` — an unsupported value raised its own 400 there — so the
 * query arrives resolved and is passed through as it stands.
 */

import type { Task } from '../domain/task.js';
import type { TaskRepository } from './TaskRepository.js';
import { filterTasks, sortTasks, type TaskQuery } from './taskQuery.js';

/**
 * Lists the tasks a query selects, in the order it asks for.
 *
 * The use case holds no per-request state: the query is a parameter of {@link ListTasks.execute},
 * so one instance serves every request without one request's filters reaching another's — which
 * matters because the interface refetches after every mutation with the filters active at that
 * moment.
 */
export class ListTasks {
  private readonly repository: TaskRepository;

  /**
   * @param deps The persistence port the listing reads through.
   */
  constructor(deps: { repository: TaskRepository }) {
    this.repository = deps.repository;
  }

  /**
   * Returns the selected tasks in the requested order, as a new array — a caller may hand it
   * straight to the response serialiser, because no further selection, ordering or shaping is
   * expected of it.
   *
   * The filter runs before the sort, so the sort only ever works on the tasks that survive the
   * filter, and both functions build a new array: the store's array is never sorted in place and a
   * caller never receives an alias to stored state.
   *
   * @param query The resolved listing request: which tasks to include by completion state, an
   *   optional priority restriction, and the order to return them in.
   * @returns The matching tasks in final order, as a bare array.
   */
  async execute(query: TaskQuery): Promise<Task[]> {
    const tasks = await this.repository.findAll();

    // Filter first, then sort: the ordering rules apply to the tasks that survive the filter.
    return sortTasks(filterTasks(tasks, query), query.sort);
  }
}
