/**
 * The status, priority and sort controls that narrow the task list.
 *
 * The bar holds no task data and computes no ordering: changing a control reports the
 * next `TaskFilters` through `onChange`, and the parent refetches the list with those
 * filters as query parameters. Filtering and ordering therefore have exactly one
 * implementation, the server's (`GET /api/tasks?status=&priority=&sort=`); this
 * component only ever says which filter set the user asked for.
 *
 * All three controls are native, labelled selects, so each is reachable by Tab,
 * operable from the keyboard, and announced with its label.
 */
import { useId } from 'react';

import type { TaskFilters, TaskPriority, TaskSort, TaskStatus } from '../api/types';

import styles from './FilterBar.module.css';

/**
 * Props of {@link FilterBar}.
 *
 * `filters` is the filter set in force, rendered as the three controls' current
 * values, and `onChange` receives the next set — never a partial one — so the caller
 * can hold it as-is and refetch.
 */
export interface FilterBarProps {
  /** The active filter set; the controls always display exactly these values. */
  filters: TaskFilters;
  /** Called with the next complete filter set whenever a control changes. */
  onChange: (next: TaskFilters) => void;
}

/**
 * The option vocabulary of one control, declared as a typed list so a `change` event's
 * string value can be narrowed back to the filter type by lookup rather than by a cast.
 */
const STATUS_OPTIONS: readonly { value: TaskStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
];

/**
 * The priority options. The empty value is the "All priorities" choice: the select
 * element cannot hold `null` as a value, so the absence of a priority filter is
 * represented by `''` here and mapped back to `priority: null` on change.
 */
const PRIORITY_OPTIONS: readonly { value: TaskPriority | ''; label: string }[] = [
  { value: '', label: 'All priorities' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const SORT_OPTIONS: readonly { value: TaskSort; label: string }[] = [
  { value: 'dueDate', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'createdAt', label: 'Creation time' },
];

/**
 * Renders the status, priority and sort selects and reports each change as the next
 * filter set, preserving the two values the change did not touch.
 */
export function FilterBar({ filters, onChange }: FilterBarProps) {
  // A unique prefix from React, so these ids cannot collide with the ids the create and
  // edit form generates, however many of either are mounted.
  const idPrefix = useId();
  const statusId = `${idPrefix}-status`;
  const priorityId = `${idPrefix}-priority`;
  const sortId = `${idPrefix}-sort`;

  return (
    <div className={styles.bar}>
      <div className={styles.control}>
        <label className={styles.label} htmlFor={statusId}>
          Status
        </label>
        <select
          id={statusId}
          className={styles.select}
          value={filters.status}
          onChange={(event) => {
            const selected = STATUS_OPTIONS.find((option) => option.value === event.target.value);
            if (selected !== undefined) {
              onChange({ ...filters, status: selected.value });
            }
          }}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.control}>
        <label className={styles.label} htmlFor={priorityId}>
          Priority
        </label>
        <select
          id={priorityId}
          className={styles.select}
          value={filters.priority ?? ''}
          onChange={(event) => {
            const selected = PRIORITY_OPTIONS.find((option) => option.value === event.target.value);
            if (selected !== undefined) {
              onChange({ ...filters, priority: selected.value === '' ? null : selected.value });
            }
          }}
        >
          {PRIORITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.control}>
        <label className={styles.label} htmlFor={sortId}>
          Sort by
        </label>
        <select
          id={sortId}
          className={styles.select}
          value={filters.sort}
          onChange={(event) => {
            const selected = SORT_OPTIONS.find((option) => option.value === event.target.value);
            if (selected !== undefined) {
              onChange({ ...filters, sort: selected.value });
            }
          }}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
