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
 *   task has disappeared) is expressed as a change to that effect's dependencies, each trigger
 *   taking the next sequence number. A load shows as `'loading'` for as long as the newest request
 *   has not answered, which is a fact derived from the sequence number the last answer recorded
 *   rather than a flag set alongside the request. The effect runs no request for a load it has
 *   already started, so the duplicate run `StrictMode` makes of every effect in development issues
 *   one request rather than two; the record of the newest load started lives outside the effect run,
 *   so the request the first of the two runs began is still the one whose answer is applied.
 * - A failed action never touches the load state. `error` is non-null only while `status` is
 *   `'error'`, which the list renders as its retryable whole-list failure; writing an action's
 *   failure there would replace the user's list with an error screen while their form is still
 *   open. It reports the failure to the caller instead — as `false`, with the rejection itself on
 *   the channel `readActionFailure` reads — so the form that submitted it can show the server's
 *   own message beside the control that message names.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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
 *
 * This is the single place the sentence is written. `error` is this value whenever `status` is
 * `'error'`, so a failed load is never handed an empty message; the list component renders this
 * same sentence only as its fallback for a caller that supplies none.
 */
export const LIST_ERROR_MESSAGE = 'Could not load tasks. The server may be unreachable.';

/**
 * Shown after an action found the task already gone from the server, so the user learns why the
 * item left the list rather than watching it vanish.
 */
const MISSING_TASK_NOTICE = 'That task no longer exists.';

/**
 * The outcome of the newest list request that has answered, together with the sequence number of
 * the request it belongs to.
 *
 * The sequence number is what makes a request's answer recognisable: while the request the screen
 * is waiting on carries a later one than this outcome describes, nothing has answered for the
 * filters in force and the list is still loading. Held as one value so `status` and `error` can
 * never disagree about which request they describe.
 */
interface CompletedLoad {
  /** The sequence number of the load this outcome answers. */
  sequence: number;
  /** That load's outcome: a list was read, or the read failed. */
  status: 'ready' | 'error';
}

/**
 * The newest list load the effect has started: the sequence number it was stamped with, the client
 * that served it and the filters it was asked to apply.
 *
 * Held outside the effect run so it outlives a single run. It does two jobs at once: an effect run
 * that names a load identical to this one is a repeat of a load already under way and starts no
 * second request — which is what keeps the duplicate run `StrictMode` makes of every effect in
 * development to a single request — and an answer is applied only while this record still describes
 * the load that answer belongs to, so a superseded answer is discarded exactly as before.
 */
interface StartedLoad {
  /** The sequence number of the load under way. */
  sequence: number;
  /** The client the load's request went to. */
  api: TaskApi;
  /** The filters the load asked the server to apply. */
  filters: TaskFilters;
}

/** Which of the three list states the hook is in. */
type UseTasksStatus = 'loading' | 'ready' | 'error';

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
  /**
   * The failure the most recent action was rejected with, or `null` when it succeeded or none has
   * settled since the last one was handled.
   *
   * Read by the caller that awaited the action, the moment it resolves `false`. The four actions
   * above answer with a `Promise<boolean>`, which has no room for the message, the code and the
   * field map a rejected request arrived with, and no component below `App.tsx` may reach the API
   * client to read them for itself; a state field could not carry them either, because a value
   * written while the promise settles is not readable from the closure that resumed after it. So
   * the rejection is held here instead, where that caller reads it synchronously, and the form it
   * belongs to places each field message beside the control the server named and the message above
   * the fields when it named none.
   *
   * Held here because the result offers no other channel: without it a rejected save reaches the
   * form as the `false` alone, and the server's message — the whole of what the user is told — has
   * nowhere to be read from. It is the one member this result carries beyond the twelve it is
   * specified with, and it cannot be dropped without the form losing the server's field messages.
   */
  readActionFailure(): unknown;
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
  // The number every load is stamped with. Each trigger of one takes the next number, and a
  // request is only read as the load in force while the number it carries is still this one — so
  // a request for a filter set some earlier answer already described is still a load of its own.
  const [loadSequence, setLoadSequence] = useState(0);

  // The channel `readActionFailure` reads. A ref rather than a piece of state because the caller
  // that awaited an action reads it as soon as that action resolves `false`, before any render the
  // state update would need.
  const actionFailureRef = useRef<unknown>(null);

  // The newest load the effect has started. A ref, not state, because it has to outlive a single
  // effect run: the duplicate run `StrictMode` makes of every effect in development reads it to
  // recognise a load already under way, and every answer reads it to learn whether it still
  // describes the load in force.
  const startedLoadRef = useRef<StartedLoad | null>(null);

  // A load is in flight until an answer arrives for the request the current sequence number stamps:
  // nothing has answered yet, or the only answer so far describes a load with an earlier number.
  const status: UseTasksStatus =
    completedLoad !== null && completedLoad.sequence === loadSequence
      ? completedLoad.status
      : 'loading';

  // Paired with `status` by construction, so a failure can never be shown beside a list that reads
  // as current.
  const error = status === 'error' ? LIST_ERROR_MESSAGE : null;

  /**
   * The one list load: a single request per trigger, and a single place `status` moves to `'ready'`
   * or `'error'`.
   *
   * `startedLoadRef` names the load under way, which lets this run do two things the closure around a
   * single run could not. A run naming a load identical to the one already recorded — the repeat of
   * a load that is the second of the two runs `StrictMode` makes of every effect in development —
   * starts no request and leaves the load to the run that began it. An answer is applied only while
   * the record still names the load it answers: a later trigger stamps a later number and takes the
   * record, so an answer to a superseded request — a filter changed while it was in flight — never
   * describes the request the screen is now waiting on. `listTasks` takes no `AbortSignal`, so
   * discarding the answer is the only way to abandon a request's result.
   */
  useEffect(() => {
    const started = startedLoadRef.current;

    if (
      started !== null &&
      started.sequence === loadSequence &&
      started.api === api &&
      started.filters === filters
    ) {
      // The load this run would start is already under way. The run that began it owns the request
      // and applies its answer, so this repeat starts nothing.
      return;
    }

    const load: StartedLoad = { sequence: loadSequence, api, filters };
    startedLoadRef.current = load;

    api.listTasks(filters).then(
      (loaded) => {
        if (startedLoadRef.current !== load) {
          return;
        }
        setTasks(loaded);
        setCompletedLoad({ sequence: load.sequence, status: 'ready' });
      },
      () => {
        if (startedLoadRef.current !== load) {
          return;
        }
        // The tasks already on screen are kept: only the load state changes, so a retry has a list
        // to fall back on and the failure object itself is never put into state.
        setCompletedLoad({ sequence: load.sequence, status: 'error' });
      },
    );
  }, [api, filters, loadSequence]);

  /** Asks the effect above for another load, leaving the active filters in place. */
  const reload = useCallback(() => {
    setLoadSequence((sequence) => sequence + 1);
  }, []);

  const retry = useCallback(() => {
    reload();
  }, [reload]);

  /**
   * Applies the whole next filter set and always refetches. The sequence bump is what makes this
   * a load of its own even when the set is one an earlier answer already described — which is what
   * the filter bar emits whenever a control reports the value it already had.
   */
  const setFilters = useCallback((next: TaskFilters) => {
    setFiltersState(next);
    setLoadSequence((sequence) => sequence + 1);
  }, []);

  /**
   * Restores the default filters and always refetches. The sequence bump covers the case where the
   * filters were already the defaults, which alone would leave the effect's dependencies unchanged;
   * when they were not, React batches both updates into one commit and the effect runs once for the
   * cleared filters.
   */
  const clearFilters = useCallback(() => {
    setFiltersState(DEFAULT_FILTERS);
    setLoadSequence((sequence) => sequence + 1);
  }, []);

  /**
   * Runs one action, reports whether it succeeded, and refetches the list when it did.
   *
   * A rejection resolves `false` and changes no load state: the caller keeps the user's input and
   * decides what to say. When the task an action named is gone from the server, the stale item is
   * dropped from the list, the user is told, and the list is refetched so the screen matches what
   * the server holds.
   *
   * The rejection itself is recorded on the channel `readActionFailure` reads, because the
   * `Promise<boolean>` result cannot carry its message, its code and its field map — and those are
   * what place the server's message beside the control it names. The channel is cleared as the
   * attempt begins, so a failure left by another action is never read as this attempt's own.
   */
  const runAction = useCallback(
    async (mutation: () => Promise<unknown>, missingTaskId?: string): Promise<boolean> => {
      actionFailureRef.current = null;

      try {
        await mutation();
        setNotice(null);
        reload();
        return true;
      } catch (failure) {
        actionFailureRef.current = failure;
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

  /**
   * Reports the failure the most recent action was rejected with, for the caller that awaited it.
   *
   * A callback rather than a plain function, so its identity is stable across renders and `App.tsx`
   * can re-throw what it returns from handlers that keep stable identities of their own.
   */
  const readActionFailure = useCallback((): unknown => actionFailureRef.current, []);

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
    readActionFailure,
    retry,
    clearFilters,
  };
}
