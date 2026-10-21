/**
 * Unit suite for the `Task` entity: its defaults and its three pure transitions.
 *
 * The domain is pure, so this suite needs no fixture module, no clock substitute and no
 * environment: the caller supplies both the identifier and the instant, nothing here reads the
 * wall clock or generates an identifier, and no adapter is involved. Every assertion compares
 * against a named fixture, and each transition is expected to return a new task while leaving
 * the task it was given untouched.
 */
import { describe, it, expect } from 'vitest';

import {
  applyPatch,
  createTask,
  setCompletion,
  DEFAULT_PRIORITY,
  DESCRIPTION_MAX_LENGTH,
  TASK_PRIORITIES,
  TITLE_MAX_LENGTH,
} from '../../../src/domain/task.js';
import type { NewTaskInput, Task } from '../../../src/domain/task.js';

/** The identifier a created task takes; the domain is handed one and never mints its own. */
const TASK_ID = '9c8f5b1e-6f2a-4a1d-9c77-2f0b1d3e4a55';

/** The instant a task is created at. */
const INSTANT = '2026-02-01T09:15:00.000Z';
/** The instant a first update is applied at. */
const LATER_INSTANT = '2026-02-02T10:30:00.000Z';
/** A later instant still, so two successive updates are distinguishable. */
const LATEST_INSTANT = '2026-02-03T08:00:00.000Z';

const now = new Date(INSTANT);
const later = new Date(LATER_INSTANT);
const latest = new Date(LATEST_INSTANT);

/**
 * A fully populated task built through `createTask`, so a fixture starts from the same defaults
 * the production path produces; `overrides` replaces the fields a test wants to begin with.
 */
function buildTask(overrides: NewTaskInput = {}): Task {
  return createTask(
    {
      title: 'Buy milk',
      description: 'Two litres',
      priority: 'high',
      dueDate: '2026-02-14',
      ...overrides,
    },
    { id: TASK_ID, now },
  );
}

describe('createTask', () => {
  it('applies every default to a task created from a title alone', () => {
    const task = createTask({ title: 'Buy milk' }, { id: TASK_ID, now });

    expect(task.title).toBe('Buy milk');
    expect(task.priority).toBe(DEFAULT_PRIORITY);
    expect(task.description).toBe('');
    expect(task.dueDate).toBeNull();
    expect(task.completed).toBe(false);
  });

  it('stamps createdAt and updatedAt with the supplied instant', () => {
    const task = createTask({ title: 'Buy milk' }, { id: TASK_ID, now });

    expect(task.createdAt).toBe(now.toISOString());
    expect(task.updatedAt).toBe(now.toISOString());
  });

  it('takes the supplied identifier instead of generating one', () => {
    // The UUID is minted outside the domain, by the create use case; the entity only carries the
    // identifier it is handed, so this guards against generation moving inward.
    const task = createTask({ title: 'Buy milk' }, { id: TASK_ID, now });

    expect(task.id).toBe(TASK_ID);
  });

  it('returns exactly the eight entity fields, and no others', () => {
    const task = createTask({ title: 'Buy milk' }, { id: TASK_ID, now });

    expect(Object.keys(task).sort()).toEqual([
      'completed',
      'createdAt',
      'description',
      'dueDate',
      'id',
      'priority',
      'title',
      'updatedAt',
    ]);
  });

  it('trims the title and the description', () => {
    const task = createTask(
      { title: '  Buy milk  ', description: '  Two litres  ' },
      { id: TASK_ID, now },
    );

    expect(task.title).toBe('Buy milk');
    expect(task.description).toBe('Two litres');
  });

  it('normalises a whitespace-only description to the empty string', () => {
    const task = createTask({ title: 'Buy milk', description: '   ' }, { id: TASK_ID, now });

    expect(task.description).toBe('');
  });

  it.each(TASK_PRIORITIES)('keeps the supplied %s priority', (priority) => {
    const task = createTask({ title: 'Buy milk', priority }, { id: TASK_ID, now });

    expect(task.priority).toBe(priority);
  });

  it('keeps a supplied description and due date', () => {
    const task = createTask(
      { title: 'Buy milk', description: 'Two litres', dueDate: '2026-02-14' },
      { id: TASK_ID, now },
    );

    expect(task.description).toBe('Two litres');
    expect(task.dueDate).toBe('2026-02-14');
  });

  it('keeps an explicit null due date as a present, null field', () => {
    const task = createTask({ title: 'Buy milk', dueDate: null }, { id: TASK_ID, now });

    expect(task.dueDate).toBeNull();
    expect(Object.keys(task)).toContain('dueDate');
  });

  it('keeps a title of exactly the maximum length intact', () => {
    const title = 'x'.repeat(TITLE_MAX_LENGTH);
    const task = createTask({ title }, { id: TASK_ID, now });

    expect(task.title).toBe(title);
    expect(task.title).toHaveLength(TITLE_MAX_LENGTH);
  });

  it('keeps a description of exactly the maximum length intact', () => {
    const description = 'x'.repeat(DESCRIPTION_MAX_LENGTH);
    const task = createTask({ title: 'Buy milk', description }, { id: TASK_ID, now });

    expect(task.description).toBe(description);
    expect(task.description).toHaveLength(DESCRIPTION_MAX_LENGTH);
  });
});

describe('applyPatch', () => {
  it('changes only the supplied field and carries every other field over unchanged', () => {
    const original = buildTask();
    const updated = applyPatch(original, { priority: 'low' }, later);

    expect(updated).toStrictEqual({
      ...original,
      priority: 'low',
      updatedAt: later.toISOString(),
    });
  });

  it('never changes the identifier or the creation timestamp', () => {
    const original = buildTask();
    const updated = applyPatch(original, { title: 'Buy oat milk' }, later);

    expect(updated.id).toBe(TASK_ID);
    expect(updated.createdAt).toBe(now.toISOString());
  });

  it('advances updatedAt to the instant the patch is applied', () => {
    const original = buildTask();
    const updated = applyPatch(original, { title: 'Buy oat milk' }, later);

    expect(original.updatedAt).toBe(now.toISOString());
    expect(updated.updatedAt).toBe(later.toISOString());
  });

  it('returns a new task and leaves the patched task untouched', () => {
    const original = buildTask();
    const snapshot: Task = { ...original };
    const updated = applyPatch(original, { title: 'Buy oat milk', priority: 'low' }, later);

    expect(updated).not.toBe(original);
    expect(original).toStrictEqual(snapshot);
  });

  it('clears the description when the patch supplies an empty string', () => {
    // Key presence decides, not truthiness: an empty string is a supplied value that clears the
    // field, and a truthiness test would silently keep the old description.
    const original = buildTask({ description: 'Two litres' });
    const updated = applyPatch(original, { description: '' }, later);

    expect(original.description).toBe('Two litres');
    expect(updated.description).toBe('');
  });

  it('clears the due date when the patch supplies null', () => {
    const original = buildTask({ dueDate: '2026-02-14' });
    const updated = applyPatch(original, { dueDate: null }, later);

    expect(updated.dueDate).toBeNull();
  });

  it('trims a supplied title', () => {
    const original = buildTask();
    const updated = applyPatch(original, { title: '  Buy oat milk  ' }, later);

    expect(updated.title).toBe('Buy oat milk');
  });

  it('sets completion when the patch supplies true', () => {
    const original = buildTask();
    const updated = applyPatch(original, { completed: true }, later);

    expect(updated.completed).toBe(true);
  });

  it('reopens the task when the patch supplies false', () => {
    // A patch carrying `completed` alongside other fields reaches this transition through
    // UpdateTask, so both directions must be honoured here and not only in setCompletion.
    const completed = applyPatch(buildTask(), { completed: true }, now);
    const reopened = applyPatch(completed, { completed: false }, later);

    expect(reopened.completed).toBe(false);
  });

  it('applies several supplied fields in one patch', () => {
    const original = buildTask();
    const updated = applyPatch(
      original,
      {
        title: 'Buy oat milk',
        description: 'One litre',
        priority: 'low',
        dueDate: '2026-03-01',
      },
      later,
    );

    expect(updated).toStrictEqual({
      ...original,
      title: 'Buy oat milk',
      description: 'One litre',
      priority: 'low',
      dueDate: '2026-03-01',
      updatedAt: later.toISOString(),
    });
  });
});

describe('setCompletion', () => {
  it('completes an open task and advances updatedAt', () => {
    const original = buildTask();
    const completed = setCompletion(original, true, later);

    expect(completed.completed).toBe(true);
    expect(completed).toStrictEqual({
      ...original,
      completed: true,
      updatedAt: later.toISOString(),
    });
  });

  it('reopens a completed task and advances updatedAt again', () => {
    const completed = setCompletion(buildTask(), true, later);
    const reopened = setCompletion(completed, false, latest);

    expect(reopened.completed).toBe(false);
    expect(reopened).toStrictEqual({
      ...completed,
      completed: false,
      updatedAt: latest.toISOString(),
    });
  });

  it('preserves the creation timestamp in both directions', () => {
    const completed = setCompletion(buildTask(), true, later);
    const reopened = setCompletion(completed, false, latest);

    expect(completed.createdAt).toBe(now.toISOString());
    expect(reopened.createdAt).toBe(now.toISOString());
  });

  it('returns a new task and leaves the task it was given untouched', () => {
    const original = buildTask();
    const snapshot: Task = { ...original };
    const completed = setCompletion(original, true, later);

    expect(completed).not.toBe(original);
    expect(original).toStrictEqual(snapshot);
  });
});
