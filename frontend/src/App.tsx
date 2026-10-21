/**
 * The one screen: the create form, the filter and sort bar, the notice region and the task list.
 *
 * This is the interface's composition point and its only wiring point. It builds the single API
 * client the whole interface uses, hands it to `useTasks` — which owns the list, the filters, the
 * notice and the five actions — and passes what that hook returns down as props. No component
 * fetches, none of them filters or sorts, and none of them decides what a failed request means.
 *
 * Nothing here holds a copy of the task list. The server is the single source of truth: every
 * successful action refetches the list with the filters that are in force, so the screen shows what
 * the server committed and no optimistic update and no conflict state have to exist.
 *
 * The one piece of state that belongs to the composition is the edit target — which task, if any, is
 * being edited in place. `TaskList` renders the form for that task inside the item being edited, so
 * the edit happens where the user is looking rather than on a page or in an overlay of its own.
 *
 * `styles/global.css` publishes the three classes this screen applies — `.skipLink` for the
 * keyboard bypass that precedes the shell, `.app` for the page shell and `.notice` for the
 * region reporting outcomes that are not field errors — and every other style in the interface
 * is scoped to the component that owns it, so the regions below are plain semantic elements. The
 * document owns the language attribute and the mount point, and `main.tsx` owns the React root
 * this component is rendered into.
 */

import { useCallback, useId, useMemo, useState } from 'react';

import { createTaskApi } from './api/client';
import type { CreateTaskInput, Task, UpdateTaskInput } from './api/types';
import { FilterBar } from './components/FilterBar';
import { TaskForm } from './components/TaskForm';
import { TaskList } from './components/TaskList';
import { useTasks } from './state/useTasks';

/**
 * Narrows the form's payload to a create body.
 *
 * `TaskForm` serves both the create form and the in-place edit form, so it types what it hands to
 * `onSubmit` as the union of the two request bodies: the create body and the patch. Only the create
 * body is what `createTask` accepts, and the two are not interchangeable — every field of the patch
 * is optional — so the payload is narrowed here rather than asserted. The create form fills all four
 * fields; anything absent takes the server's own default, and an absent title is sent empty so that
 * the server's "Title is required" is the message the user is shown.
 *
 * @param input - The payload the create form submitted.
 * @returns The create body `POST /api/tasks` accepts.
 */
function toCreateInput(input: CreateTaskInput | UpdateTaskInput): CreateTaskInput {
  return {
    title: input.title ?? '',
    description: input.description ?? '',
    priority: input.priority ?? 'medium',
    dueDate: input.dueDate ?? null,
  };
}

/**
 * Renders the screen: its heading, the creation form, the filter and sort bar, the region reporting
 * an outcome that is not a field error, and the task list.
 *
 * @returns The composed screen.
 */
export default function App() {
  // One client for the life of the screen. `useTasks` keys its list load on this object's identity,
  // so a client rebuilt on each render would refetch on each render; the empty dependency list is
  // what holds it to one instance.
  const api = useMemo(() => createTaskApi(), []);

  const {
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
  } = useTasks(api);

  /** The task the user asked to edit, or `null` when none is being edited. */
  const [requestedEditId, setRequestedEditId] = useState<string | null>(null);

  // An id prefix from React, so the region headings' ids cannot collide with the ids the forms and
  // the filter bar generate for their own controls.
  const headingIdPrefix = useId();
  const addTaskHeadingId = `${headingIdPrefix}-add-task`;
  const filterHeadingId = `${headingIdPrefix}-filter-sort`;

  // The edit target is derived from the list rather than mirrored in a second piece of state, and it
  // is dropped the moment the task it names is no longer in the list: an action that found its task
  // already gone from the server removes it and shows the notice, and an edit form left open for a
  // task the server no longer holds would contradict the rule that the screen shows what the server
  // holds. Deriving it also means the target and the list can never disagree by a render, and a
  // failed load cannot clear the target: the hook keeps the tasks it last read, so the id still
  // names a task in the list. That load's alert stands in the list's place, so the row — and the
  // form inside it — is not rendered while the failure does, and returns with the row once a retry
  // succeeds.
  const editingTaskId =
    requestedEditId !== null && tasks.some((task) => task.id === requestedEditId)
      ? requestedEditId
      : null;

  /** Puts one task into edit mode, replacing its item with the prefilled form. */
  const handleEdit = useCallback((id: string) => {
    setRequestedEditId(id);
  }, []);

  /** Leaves edit mode, restoring the item as it was. No request is sent. */
  const handleCancelEdit = useCallback(() => {
    setRequestedEditId(null);
  }, []);

  /**
   * Applies the edit form's patch and leaves edit mode only once the server accepted it, so a
   * rejected save keeps the form open with everything the user typed still in it.
   *
   * A refusal is re-thrown as the failure `useTasks` recorded, never reported as the `false` alone:
   * the server's message and its field map are what the form shows beside the controls the server
   * named, and a boolean cannot carry them. A call that resolved `false` records one, and a
   * rejection carrying nothing usable reads as the form's generic not-saved message.
   */
  const handleSave = useCallback(
    async (id: string, input: CreateTaskInput | UpdateTaskInput): Promise<boolean> => {
      if (await updateTask(id, input)) {
        setRequestedEditId(null);
        return true;
      }

      throw readActionFailure();
    },
    [readActionFailure, updateTask],
  );

  /**
   * Creates what the create form submitted; the form clears its own fields once this resolves
   * `true`.
   *
   * A refusal is re-thrown for the reason spelled out at `handleSave`: the detail the failure
   * carries is what the form places beside the field it names, so it is handed on rather than
   * swallowed into the `false`.
   */
  const handleCreateSubmit = useCallback(
    async (input: CreateTaskInput | UpdateTaskInput): Promise<boolean> => {
      if (await createTask(toCreateInput(input))) {
        return true;
      }

      throw readActionFailure();
    },
    [createTask, readActionFailure],
  );

  /** Completes or reopens one task. The next list load decides what the screen shows. */
  const handleToggle = useCallback(
    (id: string, completed: boolean) => {
      void toggleTask(id, completed);
    },
    [toggleTask],
  );

  /** Deletes a task the user confirmed. The confirmation itself belongs to the task's own item. */
  const handleDelete = useCallback(
    (task: Task) => {
      void deleteTask(task.id);
    },
    [deleteTask],
  );

  // What tells the list's two "nothing to show" screens apart: an account with no tasks at all is a
  // different state from filters that matched nothing, and only the second one offers a way back.
  const filtersActive =
    filters.status !== 'all' || filters.priority !== null || filters.sort !== 'createdAt';

  return (
    <>
      {/* The keyboard bypass, first in the document so it is the first Tab stop. It is a sibling
          of `main` rather than a child of it: `.app > * + *` would otherwise give the heading
          below an extra top margin. `TaskList`'s region is the target, focused on activation. */}
      <a className="skipLink" href="#task-list">
        Skip to task list
      </a>

      <main className="app">
        <h1>Tasks</h1>

        {/* Create. The form holds its own fields, so a list load, a list failure or a rejected save
            never takes away what the user typed. */}
        <section aria-labelledby={addTaskHeadingId}>
          <h2 id={addTaskHeadingId}>Add a task</h2>
          <TaskForm onSubmit={handleCreateSubmit} submitLabel="Add task" />
        </section>

        {/* Narrow the list. Each control reports the next filter set, which refetches the list; the
            ordering itself is the server's, so this file computes none. */}
        <section aria-labelledby={filterHeadingId}>
          <h2 id={filterHeadingId}>Filter and sort</h2>
          <FilterBar filters={filters} onChange={setFilters} />
        </section>

        {/* Outcomes that are not field errors — most importantly that the task an action named is
            already gone from the server, which is why its item left the list. Announced politely and
            without moving focus, and rendered only while there is something to report. */}
        {notice !== null && (
          <p className="notice" role="status" aria-live="polite">
            {notice}
          </p>
        )}

        {/* The list region carries its own label so it is reachable as a region; the list element, its
            items and their headings belong to the list itself. */}
        <section id="task-list" tabIndex={-1} aria-label="Task list">
          <TaskList
            tasks={tasks}
            status={status}
            error={error}
            filtersActive={filtersActive}
            editingTaskId={editingTaskId}
            onRetry={retry}
            onClearFilters={clearFilters}
            onToggle={handleToggle}
            onEdit={handleEdit}
            onSave={handleSave}
            onCancelEdit={handleCancelEdit}
            onDelete={handleDelete}
          />
        </section>
      </main>
    </>
  );
}
