/**
 * List state, filters and the five task actions, in one hook.
 *
 * This is the interface's only stateful module. It owns the task list the screen shows, the
 * filters the server is asked to apply, the notice region's message and the five actions that
 * change what the server holds. `App.tsx` calls it with the one API client it constructs and
 * passes what it returns down as props, so no component fetches, filters, sorts or decides what
 * a failed request means.
 *
 * Three properties of this contract are deliberate and load-bearing:
 *
 * - The server is the single source of truth. Every successful action refetches the list with the
 *   filters that are active and nothing is applied optimistically, so what is on screen is what
 *   the server committed and no conflict state has to exist.
 * - There is exactly one place a list load happens — the effect below — and every trigger for one
 *   (the initial mount, a filter change, a retry, the refetch after an action, the refetch after a
 *   task has disappeared) is expressed as a change to that effect's dependencies. A load shows as
 *   `'loading'` for as long as the newest request has not answered, which is a fact derived from
 *   the request the last answer belongs to rather than a flag set alongside the request.
 * - A failed action never touches the load state. `error` is non-null only while `status` is
 *   `'error'`, which the list renders as its retryable whole-list failure; writing an action's
 *   failure there would replace the user's list with an error screen while their form is still
 *   open.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, type TaskApi } from '../api/client';
import type { CreateTaskInput, Task, TaskFilters, UpdateTaskInput } from '../api/types';

/**
 * The filters a list starts with and `clearFilters` restores: every task, every priority, most
 * recently created first.
 */
const DEFAULT_FILTERS: TaskFilters = { status: 'all', priority: null, sort: 'createdAt' };

/**
 * Shown when the list itself could not be fetched. One sentence naming both the likely cause and
 * what the user can do, because the retry control is the only remedy the interface offers.
 */
const LIST_ERROR_MESSAGE = 'Could not load tasks. The server may be unreachable.';

/**
 * Shown after an action found the task already gone from the server, so the user learns why the
 * item left the list rather than watching it vanish.
 */
const MISSING_TASK_NOTICE = 'That task no longer exists.';

/**
 * The outcome of the newest list request that has answered, together with the identity of the
 * request it belongs to.
 *
 * The identity is what makes a request's answer recognisable: while the request the screen is
 * waiting on differs from the one this outcome describes, nothing has answered for the current
 * filters and the list is still loading. Held as one value so `status` and `error` can never
 * disagree about which request they describe.
 */
interface CompletedLoad {
  /** The request this outcome belongs to, spelled as `requestKey` spells it. */
  request: string;
  /** That request's outcome: a list was read, or the read failed. */
  status: 'ready' | 'error';
}

/**
 * The identity of one list request: the filters it applies and the reload it belongs to, as a
 * value equal only to that of an identical request.
 *
 * A string rather than an object so a comparison is by value: a re-render that leaves the filters
 * and the reload count alone produces an equal key and starts no load, and a changed filter or a
 * bumped reload count produces a different one and does.
 */
function requestKey(filters: TaskFilters, reloadToken: number): string {
  return `${filters.status}|${filters.priority ?? ''}|${filters.sort}|${reloadToken}`;
}

/** Which of the three list states the hook is in. */
export type UseTasksStatus = 'loading' | 'ready' | 'error';

/** Everything `App.tsx` and its components consume from `useTasks`. */
export interface UseTasksResult {
  /** The tasks the server last returned, in the order it returned them. */
  tasks: Task[];
  /** Whether the list is being fetched, has been fetched, or could not be fetched. */
  status: UseTasksStatus;
  /** The load failure to display, or `null`. Non-null only while `status` is `'error'`. */
  error: string | null;
  /** An outcome that is not a field error, or `null`. */
  notice: string | null;
  /** The filters the server was last asked to apply. */
  filters: TaskFilters;
  /** Applies the whole next filter set, refetching the list. */
  setFilters(next: TaskFilters): void;
  /** Creates a task, refetching the list. Resolves `false` when the server rejected it. */
  createTask(input: CreateTaskInput): Promise<boolean>;
  /** Applies the supplied fields to one task, refetching the list. */
  updateTask(id: string, patch: UpdateTaskInput): Promise<boolean>;
  /** Completes or reopens one task, refetching the list. */
  toggleTask(id: string, completed: boolean): Promise<boolean>;
  /** Deletes one task, refetching the list. */
  deleteTask(id: string): Promise<boolean>;
  /** Refetches the list with the filters that are active. */
  retry(): void;
  /** Restores the default filters and refetches the list. */
  clearFilters(): void;
}

/** Owns the task list, its filters, its notice and the five actions. */
export function useTasks(api: TaskApi): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [completedLoad, setCompletedLoad] = useState<CompletedLoad | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<TaskFilters>(DEFAULT_FILTERS);
  const [reloadToken, setReloadToken] = useState(0);

  // A load is in flight until an answer arrives for the request the current filters and reload
  // count spell: nothing has answered yet, or the only answer so far describes an earlier request.
  const status: UseTasksStatus =
    completedLoad !== null && completedLoad.request === requestKey(filters, reloadToken)
      ? completedLoad.status
      : 'loading';

  // Paired with `status` by construction, so a failure can never be shown beside a list that reads
  // as current.
  const error = status === 'error' ? LIST_ERROR_MESSAGE : null;

  /**
   * The one list load: a single request per trigger, and a single place `status` moves to `'ready'`
   * or `'error'`.
   *
   * `ignore` is what makes the effect safe to tear down: an answer to a superseded request — a
   * filter changed while it was in flight, or the second mount under `StrictMode` in development —
   * must never describe the request the screen is now waiting on. `listTasks` takes no
   * `AbortSignal`, so discarding the answer is the only way to abandon a request's result.
   */
  useEffect(() => {
    let ignore = false;

    const requested = requestKey(filters, reloadToken);

    api.listTasks(filters).then(
      (loaded) => {
        if (ignore) {
          return;
        }
        setTasks(loaded);
        setCompletedLoad({ request: requested, status: 'ready' });
      },
      () => {
        if (ignore) {
          return;
        }
        // The tasks already on screen are kept: only the load state changes, so a retry has a list
        // to fall back on and the failure object itself is never put into state.
        setCompletedLoad({ request: requested, status: 'error' });
      },
    );

    return () => {
      ignore = true;
    };
  }, [api, filters, reloadToken]);

  /** Asks the effect above for another load, leaving the active filters in place. */
  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const retry = useCallback(() => {
    reload();
  }, [reload]);

  const setFilters = useCallback((next: TaskFilters) => {
    setFiltersState(next);
  }, []);

  /**
   * Restores the default filters and always refetches. The token bump covers the case where the
   * filters were already the defaults, which alone would leave the effect's dependencies
   * unchanged; when they were not, React batches both updates into one commit and the effect runs
   * once for the cleared filters.
   */
  const clearFilters = useCallback(() => {
    setFiltersState(DEFAULT_FILTERS);
    setReloadToken((token) => token + 1);
  }, []);

  /**
   * Runs one action, reports whether it succeeded, and refetches the list when it did.
   *
   * A rejection resolves `false` and changes no load state: the caller keeps the user's input and
   * decides what to say. When the task an action named is gone from the server, the stale item is
   * dropped from the list, the user is told, and the list is refetched so the screen matches what
   * the server holds. The field map a rejected request carries is not readable through this
   * contract's `Promise<boolean>` result, so the rejection is reported as the `false` alone.
   */
  const runAction = useCallback(
    async (mutation: () => Promise<unknown>, missingTaskId?: string): Promise<boolean> => {
      try {
        await mutation();
        setNotice(null);
        reload();
        return true;
      } catch (failure) {
        if (missingTaskId !== undefined && failure instanceof ApiError && failure.status === 404) {
          setTasks((current) => current.filter((task) => task.id !== missingTaskId));
          setNotice(MISSING_TASK_NOTICE);
          reload();
        }
        return false;
      }
    },
    [reload],
  );

  const createTask = useCallback(
    (input: CreateTaskInput) => runAction(() => api.createTask(input)),
    [api, runAction],
  );

  const updateTask = useCallback(
    (id: string, patch: UpdateTaskInput) => runAction(() => api.updateTask(id, patch), id),
    [api, runAction],
  );

  const toggleTask = useCallback(
    (id: string, completed: boolean) => runAction(() => api.toggleTask(id, completed), id),
    [api, runAction],
  );

  const deleteTask = useCallback(
    (id: string) => runAction(() => api.deleteTask(id), id),
    [api, runAction],
  );

  return {
    tasks,
    status,
    error,
    notice,
    filters,
    setFilters,
    createTask,
    updateTask,
    toggleTask,
    deleteTask,
    retry,
    clearFilters,
  };
}
