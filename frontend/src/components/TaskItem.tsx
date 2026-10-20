/**
 * One task in the list: its priority tag, title, description, due date and overdue marker, its
 * completion checkbox, and its Edit and Delete actions.
 *
 * The component holds no data of its own. It takes the task and every action as props, computes
 * nothing but whether the task reads as overdue — and that through `isOverdue`, the single owner
 * of the rule — and never reaches the API: toggling, editing, saving and deleting are all reported
 * to the caller, which decides what a request means. Its one piece of state is whether the delete
 * confirmation is open, because that dialog stands between this item's Delete control and the
 * destructive request, and no other component needs to know about it.
 *
 * Priority and overdueness are both carried by a word — `Low`/`Medium`/`High` in the tag and the
 * literal word `Overdue` beside the date — so both survive a monochrome display, a colour-blind
 * reader and a screen reader; colour only reinforces them.
 */

import { useId, useState } from 'react';

import type { CreateTaskInput, Task, UpdateTaskInput } from '../api/types';
import { isOverdue } from '../state/taskSelectors';
import { ConfirmDialog } from './ConfirmDialog';
import { PriorityTag } from './PriorityTag';
import { TaskForm } from './TaskForm';
import styles from './TaskItem.module.css';

/**
 * Props of {@link TaskItem}.
 *
 * The item renders no control it was not handed a handler for, so the caller keeps every decision
 * about what a toggle, an edit, a save or a delete does. `task` is the same object the API
 * returned: the item displays it as it stands and never normalises, reorders or reformats it.
 */
export interface TaskItemProps {
  /** The task to display, exactly as the API returned it. */
  task: Task;
  /**
   * Called when the completion checkbox is toggled, with the value it moved to. The caller turns
   * this into the completion request; this component sends nothing itself.
   */
  onToggle: (id: string, completed: boolean) => void;
  /** Called when the Edit control is pressed, naming the task to put into edit mode. */
  onEdit: (id: string) => void;
  /** Called only after the user confirms the delete in the confirmation dialog. */
  onDelete: (task: Task) => void;
  /**
   * Whether this item is the one being edited. `true` replaces the item's display content with a
   * prefilled {@link TaskForm} in place, inside the same list item.
   */
  editing: boolean;
  /**
   * Passed straight to the edit form; it receives only the fields that differ from the stored task
   * and resolves with whether the save succeeded.
   */
  onSave: (input: CreateTaskInput | UpdateTaskInput) => Promise<boolean>;
  /** Called when the edit is abandoned, restoring the item as it was. */
  onCancelEdit: () => void;
}

/**
 * Renders one task as a list item, in display mode or in edit mode.
 *
 * @param props - the task, its current mode and the handlers for each action
 */
export function TaskItem({
  task,
  onToggle,
  onEdit,
  onDelete,
  editing,
  onSave,
  onCancelEdit,
}: TaskItemProps) {
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);

  // The label carries the task's title, so the checkbox is announced as this task's rather than as
  // a bare checkbox among many. Two items can be on screen at once, so the id comes from `useId`
  // instead of a hard-coded one that would collide with the next item's.
  const checkboxId = useId();

  return (
    <li className={styles.item}>
      {editing ? (
        // The edit target is the thing the user is looking at, so the form replaces this item's
        // content in place — no separate page, no overlay — and the delete confirmation goes with
        // it, since its Delete control is not on screen while the form is.
        <TaskForm
          initialTask={task}
          onSubmit={onSave}
          onCancel={onCancelEdit}
          submitLabel="Save"
        />
      ) : (
        <>
          {/* The tag, the title and the due date share one row: the stylesheet lays this row out as
              a wrapping flex line, and from 768px places it across the item's grid, so the three
              stay together above the actions. */}
          <div className={styles.header}>
            <PriorityTag priority={task.priority} />
            <h3 className={styles.title}>{task.title}</h3>
            {task.dueDate !== null && (
              <p className={styles.due}>
                <span className={styles.dueLabel}>Due</span>{' '}
                {/* The stored `YYYY-MM-DD` string is shown exactly as stored: no locale
                    formatting, no reformatting. It sits in its own `<time>` element so the date
                    stays one text node, with the machine-readable value mirrored in `dateTime`. */}
                <time className={styles.dueDate} dateTime={task.dueDate}>
                  {task.dueDate}
                </time>
                {/* A word, not a colour: it is what a screen reader and a monochrome display both
                    receive. `isOverdue` is true only for an open task whose date is before today,
                    so a completed or undated task never reaches this marker. */}
                {isOverdue(task) && <span className={styles.overdue}>Overdue</span>}
              </p>
            )}
          </div>

          {/* Rendered only when there is a description: an empty one omits the region rather than
              leaving an empty placeholder behind. */}
          {task.description !== '' && <p className={styles.description}>{task.description}</p>}

          <div className={styles.completion}>
            <input
              id={checkboxId}
              type="checkbox"
              checked={task.completed}
              onChange={(event) => onToggle(task.id, event.target.checked)}
            />
            <label className={styles.checkboxLabel} htmlFor={checkboxId}>
              {task.completed ? `Reopen “${task.title}”` : `Complete “${task.title}”`}
            </label>
          </div>

          <div className={styles.actions}>
            {/* The visible words are the controls' accessible names, so neither button carries a
                label that would rename it away from what it says. */}
            <button type="button" className={styles.action} onClick={() => onEdit(task.id)}>
              Edit
            </button>
            <button type="button" className={styles.action} onClick={() => setConfirmOpen(true)}>
              Delete
            </button>
          </div>

          {/* The confirmation is the only route to the delete request: pressing Delete opens this
              dialog and calls nothing else, while cancelling, pressing Escape and clicking outside
              all call `onCancel`, which only closes it. */}
          <ConfirmDialog
            open={confirmOpen}
            title="Delete task"
            message={`“${task.title}” will be deleted. This cannot be undone.`}
            confirmLabel="Delete"
            onConfirm={() => {
              setConfirmOpen(false);
              onDelete(task);
            }}
            onCancel={() => setConfirmOpen(false)}
          />
        </>
      )}
    </li>
  );
}
