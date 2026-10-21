/**
 * A task's priority level, rendered as a word inside a coloured pill.
 *
 * The word carries the meaning and the colour only reinforces it, which is what makes
 * the level legible on a monochrome display, to a colour-blind reader and to a screen
 * reader alike: because the label is real text, it is also the tag's accessible name,
 * so no `role`, no `aria-label`, no `title` and no icon is added here.
 *
 * The label and the per-level class are both obtained from
 * `../state/taskSelectors`, the single owner of those two mappings, so neither is
 * duplicated in this file. `priorityModifier` returns one of `'low' | 'medium' |
 * 'high'`, which are class names in this component's own CSS module; the lookup is
 * treated as possibly-undefined and falls back to the base class alone, so a level
 * that has no modifier still renders a styled pill rather than an unclassed span.
 */
import type { TaskPriority } from '../api/types';
import { priorityLabel, priorityModifier } from '../state/taskSelectors';
import styles from './PriorityTag.module.css';

/**
 * Props of {@link PriorityTag}.
 */
export interface PriorityTagProps {
  /**
   * The task's priority level — `'low'`, `'medium'` or `'high'`. It decides both the
   * word the tag displays and the colour that reinforces it.
   */
  priority: TaskPriority;
}

/**
 * Renders a priority level as its word, inside a pill coloured for that level.
 *
 * @param props - the priority level to render
 */
export function PriorityTag({ priority }: PriorityTagProps) {
  const modifier = styles[priorityModifier(priority)];
  const className = modifier === undefined ? styles.tag : `${styles.tag} ${modifier}`;

  return <span className={className}>{priorityLabel(priority)}</span>;
}
