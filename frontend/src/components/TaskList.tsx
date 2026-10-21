/**
 * The task list: one row per task, and the four states the list can be in besides a populated
 * one.
 *
 * It renders exactly the array it was handed. The server applies the filter and the sort — the
 * filter bar's controls change the request's query parameters — so nothing here reorders,
 * filters, groups or reformats a task, and the interface holds a single ordering implementation
 * rather than two that can disagree.
 *
 * A load that failed renders its retryable alert in place of the list, so its two failure paths —
 * the initial load and a refetch — show the same thing. Presenting rows the server has not confirmed
 * for the filters in force would put on screen a state it never committed. A load still in flight
 * takes nothing away: rows already read stay readable, and the form and the filter bar belong to
 * `App.tsx` and stay usable.
 *
 * An account with no tasks at all and a filter that matched nothing are two different screens,
 * not one message in two wordings: the first invites the user to add their first task, the second
 * says the filter matched nothing and offers the way back. `filtersActive` is what selects between
 * them, and only the caller knows it.
 */

import { memo, useCallback } from 'react';

import type { CreateTaskInput, Task, UpdateTaskInput } from '../api/types';
// The sentence shown for a failed load is written once, in the state layer, and imported here
// rather than restated, so the two can never drift apart.
import { LIST_ERROR_MESSAGE } from '../state/useTasks';
import { TaskItem } from './TaskItem';
import styles from './TaskList.module.css';

/**
 * Props of {@link TaskList}.
 *
 * Every piece of data and every action arrives from the caller, which keeps this component free of
 * fetching, of list state and of any decision about what a request means: it renders the tasks it
 * was given in the order it was given them, and reports what the user did.
 */
export interface TaskListProps {
  /** The tasks to display, in the order the server returned them. Never reordered here. */
  tasks: Task[];
  /**
   * Whether a list request is in flight, has answered, or failed. The union is the same shape as
   * the state layer's status, declared here so a component depends on props alone.
   */
  status: 'loading' | 'ready' | 'error';
  /** The load failure to display; `null` unless `status` is `'error'`. */
  error: string | null;
  /**
   * Whether any filter or sort other than the defaults is active. It is the only thing that
   * chooses between the empty state and the filtered-empty state.
   */
  filtersActive: boolean;
  /** The task currently being edited in place, or `null` when none is. */
  editingTaskId: string | null;
  /** Refetches the list with the filters that are active. */
  onRetry: () => void;
  /** Restores the default filters and refetches the list. */
  onClearFilters: () => void;
  /** Completes or reopens one task, by id, with the value its checkbox moved to. */
  onToggle: (id: string, completed: boolean) => void;
  /** Puts one task, by id, into edit mode. */
  onEdit: (id: string) => void;
  /**
   * Applies the fields the edit form changed to the task with this id, resolving with whether the
   * save succeeded. The id is bound here, so the form supplies only the input.
   */
  onSave: (id: string, input: CreateTaskInput | UpdateTaskInput) => Promise<boolean>;
  /** Leaves edit mode, restoring the task as it was. */
  onCancelEdit: () => void;
  /** Confirmed deletion of one task. */
  onDelete: (task: Task) => void;
}

/**
 * Props of {@link TaskRow}: one task, its mode, and this list's own handlers.
 *
 * The list's props minus the ones that describe the list itself, with the mode in place of the
 * editing target: a row is told whether *it* is the one being edited rather than which id is, so a
 * row whose mode did not change is handed the same `editing` value as before.
 */
interface TaskRowProps {
  /** The task this row displays, exactly as the API returned it. */
  task: Task;
  /** Whether this row is the one being edited in place. */
  editing: boolean;
  /** Completes or reopens this row's task, with the value its checkbox moved to. */
  onToggle: (id: string, completed: boolean) => void;
  /** Puts this row's task into edit mode. */
  onEdit: (id: string) => void;
  /**
   * Applies the fields the edit form changed to the task with this id, resolving with whether the
   * save succeeded. The id is bound by the row, so the form supplies only the input.
   */
  onSave: (id: string, input: CreateTaskInput | UpdateTaskInput) => Promise<boolean>;
  /** Leaves edit mode, restoring this row's task as it was. */
  onCancelEdit: () => void;
  /** Confirmed deletion of this row's task. */
  onDelete: (task: Task) => void;
}

/**
 * One row of the list: the item for one task, with this list's `onSave(id, input)` bound to that
 * task's id.
 *
 * The binding lives in a component of its own rather than in an arrow built inside the list's
 * `tasks.map`, and that is what makes a row's props stable by identity: a memoized component skips a
 * render only when every prop it is handed is unchanged, so an arrow rebuilt on each render of the
 * list would hand every row a fresh `onSave` every time and no row could ever skip one.
 */
const TaskRow = memo(function TaskRow({
  task,
  editing,
  onToggle,
  onEdit,
  onSave,
  onCancelEdit,
  onDelete,
}: TaskRowProps) {
  // Bound once per row, and stable for as long as this row's task and the list's own `onSave` are.
  // What the edit form receives is this row's `onSave(input)`; which task that input belongs to is
  // this row's business, not the form's.
  const handleSave = useCallback(
    (input: CreateTaskInput | UpdateTaskInput) => onSave(task.id, input),
    [onSave, task.id],
  );

  return (
    <TaskItem
      task={task}
      onToggle={onToggle}
      onEdit={onEdit}
      onDelete={onDelete}
      editing={editing}
      onSave={handleSave}
      onCancelEdit={onCancelEdit}
    />
  );
});

/**
 * Renders the task list with its loading, empty, filtered-empty and retryable-error states.
 *
 * The list is memoized, so a render above it that leaves its own props unchanged — the notice
 * appearing, a region elsewhere in the screen re-rendering — stops here instead of walking all N
 * rows. Each row binds its own id inside {@link TaskRow}, which is what keeps a row's props stable
 * enough for that skip to reach it.
 *
 * @param props - the tasks, the load status, whether filters are active and the handlers for every
 *   action a row can take
 */
export const TaskList = memo(function TaskList({
  tasks,
  status,
  error,
  filtersActive,
  editingTaskId,
  onRetry,
  onClearFilters,
  onToggle,
  onEdit,
  onSave,
  onCancelEdit,
  onDelete,
}: TaskListProps) {
  // The caller's message wins. `useTasks` returns a non-empty `error` for every failed load, so in
  // the composed app the region shows that layer's `LIST_ERROR_MESSAGE`; this fallback is only for
  // a caller that hands the list no message, and keeps the alert from rendering empty.
  const loadErrorMessage = error !== null && error.trim() !== '' ? error : LIST_ERROR_MESSAGE;

  return (
    <section>
      <h2 className={styles.heading}>Task list</h2>

      {/* Announced politely and holding no control: the request is already in flight, the form and
          the filter bar remain usable, and there is nothing for the user to do but wait. */}
      {status === 'loading' && (
        <p className={styles.status} role="status">
          Loading tasks…
        </p>
      )}

      {/* The one region the user has to act on. The rows are held back while this stands — a failure
          invalidates them for the filters in force — so a failed refetch shows the alert in place of
          the list, exactly as a failed initial load does. */}
      {status === 'error' && (
        <div className={styles.error} role="alert">
          <p>{loadErrorMessage}</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {/* The account has no tasks yet: the empty state names the form as the place to change that. */}
      {status === 'ready' && tasks.length === 0 && !filtersActive && (
        <p className={styles.empty}>No tasks yet. Add your first task using the form above.</p>
      )}

      {/* The filters are active and matched nothing — a different screen from the empty state
          above, and the only one that can offer the way back to a full list. */}
      {status === 'ready' && tasks.length === 0 && filtersActive && (
        <p className={styles.empty}>
          No matching tasks.
          <button type="button" onClick={onClearFilters}>
            Clear filters
          </button>
        </p>
      )}

      {/* A list element rather than styled divs, so a screen reader announces the set and its
          size. `role="list"` is spelled out because a list whose markers are removed is not
          reported as one by every screen reader; the tasks themselves are `<li>` elements. The
          id is the React key, so a task keeps its identity across refetches.
          Rendered only while no load has failed: a failure invalidates these rows for the filters
          in force, so it shows the alert above in their place and both failure paths render alike. A
          load in flight is not a failure and leaves them readable. */}
      {status !== 'error' && tasks.length > 0 && (
        <ul className={styles.list} role="list">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              editing={editingTaskId === task.id}
              onToggle={onToggle}
              onEdit={onEdit}
              onSave={onSave}
              onCancelEdit={onCancelEdit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
});
