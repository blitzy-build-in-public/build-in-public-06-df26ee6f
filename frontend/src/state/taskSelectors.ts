/**
 * Derived presentation rules for the task interface.
 *
 * The single place the interface's derived values are decided: whether a task reads as
 * overdue, and the word and the style modifier a priority level renders with. No
 * component re-implements any of them, and no other module owns them, so there is one
 * answer per question in the whole frontend.
 *
 * The overdue rule is presentation only. It is never stored, never sent and never
 * returned by the API, so changing a device's date changes the flag and touches no
 * data; `frontend/src/api/types.ts` is imported for its types alone, which leaves this
 * module with no runtime dependency and lets it be imported from anywhere.
 */

import type { Task, TaskPriority } from '../api/types';

/**
 * The word each priority level renders with.
 *
 * The word, not the colour, is what carries the meaning: a monochrome display, a
 * colour-blind reader and a screen reader all receive it, and the tag's colour only
 * reinforces it. Typing the table by the key union rather than by a string index keeps
 * the lookup exhaustive — a fourth priority becomes a compile error here — and makes
 * the indexed result a `string` rather than a `string | undefined`.
 */
const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/**
 * The style modifier each priority level is keyed by.
 *
 * The bare level name is a three-file contract: `PriorityTag.tsx` indexes its own CSS
 * module with this value, `PriorityTag.module.css` defines these three class names, and
 * `styles/global.css` names the per-priority colour custom properties after them. A
 * prefixed, camelCased or otherwise transformed variant would render an unstyled tag.
 */
const PRIORITY_MODIFIERS: Record<TaskPriority, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/**
 * Returns today's LOCAL calendar date as a zero-padded `YYYY-MM-DD` string.
 *
 * Built from the date's local year, month and day, never from a UTC-derived value: a
 * UTC-derived "today" is a day behind for every user west of Greenwich, and would flag
 * a task due today. Passing `today` also makes the value deterministic, which is what
 * lets a caller and its tests agree on the date without touching the system clock.
 */
export function todayLocalIsoDate(today: Date = new Date()): string {
  const year = String(today.getFullYear()).padStart(4, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * True only when the task is open, has a due date, and that date is strictly before
 * today's local date.
 *
 * A completed task is never flagged, whatever its due date, and a task with no due date
 * can never be flagged. The comparison is between two fixed-width, zero-padded
 * `YYYY-MM-DD` strings, which order identically to the dates they represent, and it is
 * strict because a task due today is not overdue.
 */
export function isOverdue(task: Task, today: Date = new Date()): boolean {
  const dueDate = task.dueDate;

  if (dueDate === null || task.completed) {
    return false;
  }

  return dueDate < todayLocalIsoDate(today);
}

/**
 * The priority level as the word the interface displays: `Low`, `Medium` or `High`.
 */
export function priorityLabel(priority: TaskPriority): string {
  return PRIORITY_LABELS[priority];
}

/**
 * The CSS-module class name for the level — `low`, `medium` or `high` — which the
 * priority tag indexes its own stylesheet with.
 */
export function priorityModifier(priority: TaskPriority): string {
  return PRIORITY_MODIFIERS[priority];
}
