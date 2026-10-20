/**
 * Unit suite for the application layer's filter and sort semantics — the evidence for the
 * acceptance criterion that every filter and sort combination returns the expected order.
 *
 * Two units are under test. `src/application/taskQuery.ts` owns the query contract and the order:
 * `parseTaskQuery` resolves the three query parameters (their defaults included, so the request's
 * own documented `?status=&priority=&sort=` form asks for the defaults rather than failing),
 * `filterTasks` selects by completion state and priority, and `sortTasks` orders the selection with
 * one of three comparators. `src/application/ListTasks.ts` is the use case that applies them: it
 * reads the store exactly once, through `TaskRepository.findAll()`, and does all filtering and
 * sorting in memory on the array that one call returned — the design the first-list-render budget
 * at a thousand tasks rests on.
 *
 * Those two units are the single implementation of the product's ordering. The SQLite adapter only
 * reads and writes, the browser only passes query parameters through, so what is pinned here is the
 * whole of it: earliest due date first with every task that has no due date after all dated tasks,
 * `high` then `medium` then `low`, most recently created first, and any tie broken by identifier
 * ascending so that the order is total and the same tasks always come back in the same order.
 *
 * The store injected is `InMemoryTaskRepository`, which deep-copies what it stores and promises no
 * ordering whatsoever, so nothing below can depend on insertion order or on a database. No clock
 * and no random value takes part either: every due date and timestamp is a fixed literal, and the
 * one place a permutation is wanted it is written out by hand.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { ListTasks } from '../../../src/application/ListTasks.js';
import {
  compareByCreatedAt,
  compareByDueDate,
  compareByPriority,
  filterTasks,
  parseTaskQuery,
  sortTasks,
} from '../../../src/application/taskQuery.js';
import type {
  TaskQuery,
  TaskQueryInput,
  TaskSort,
  TaskStatus,
} from '../../../src/application/taskQuery.js';
import type { TaskRepository } from '../../../src/application/TaskRepository.js';
import { VALIDATION_ERROR_MESSAGE, ValidationError } from '../../../src/domain/errors.js';
import type { Task, TaskPriority } from '../../../src/domain/task.js';
import { InMemoryTaskRepository } from '../../support/inMemoryTaskRepository.js';

/*
 * The three rejection messages are pinned as literals here because they are the contract rather
 * than incidental wording: the HTTP layer returns each one in a field-error map keyed by the
 * parameter name, and the interface renders it verbatim beside the control that produced it.
 * Interpolating a shared constant would let the sentence a client shows drift away from the
 * sentence this suite agrees to.
 */
/** Rejection message for an unsupported `status` value. */
const STATUS_MESSAGE = 'status must be one of: all, open, completed';
/** Rejection message for an unsupported `priority` value. */
const PRIORITY_MESSAGE = 'priority must be one of: low, medium, high';
/** Rejection message for an unsupported `sort` value. */
const SORT_MESSAGE = 'sort must be one of: dueDate, priority, createdAt';

/** The three statuses the contract accepts; `all` is the one a listing takes by default. */
const taskStatuses: TaskStatus[] = ['all', 'open', 'completed'];
/** The three priority levels, in the order the domain declares them rather than in sort order. */
const taskPriorities: TaskPriority[] = ['low', 'medium', 'high'];
/** The three sort keys, which are the only orderings the product offers. */
const sortKeys: TaskSort[] = ['dueDate', 'priority', 'createdAt'];

/**
 * A complete task, so every fixture carries all eight fields the API returns; `overrides` supplies
 * the fields the case at hand is about. The defaults are deliberately bland — medium, no due date,
 * the same instant — so a fixture states plainly which property it exists to exercise.
 */
const task = (overrides: Partial<Task> & Pick<Task, 'id'>): Task => ({
  title: `Task ${overrides.id}`,
  description: '',
  priority: 'medium',
  dueDate: null,
  completed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

/*
 * The fixture set, designed so that one ordering rule cannot be satisfied by accident: the
 * identifiers ascend t1..t6, the seeding order is neither that nor the due-date order nor the
 * creation order, two tasks share a due date so a tie has to be broken, one task is completed, and
 * two tasks carry no due date at all — two of them, because a single undated task could not tell
 * "last" from "somewhere after the dated ones".
 */

/** Open, high priority, due 14 February, the earliest-created task of all. */
const milk = task({
  id: 't1',
  title: 'Buy milk',
  priority: 'high',
  dueDate: '2026-02-14',
  createdAt: '2026-01-01T00:00:00.000Z',
});

/** Open, high priority and due the same day as `milk`, but created later: a due-date tie. */
const bread = task({
  id: 't2',
  title: 'Bake bread',
  priority: 'high',
  dueDate: '2026-02-14',
  createdAt: '2026-01-05T00:00:00.000Z',
});

/** Completed, low priority, due 5 January — the earliest date, and the only completed task. */
const taxes = task({
  id: 't3',
  title: 'File taxes',
  priority: 'low',
  dueDate: '2026-01-05',
  completed: true,
  createdAt: '2026-01-03T00:00:00.000Z',
});

/** Open, medium priority, due 31 December — the latest date. */
const gala = task({
  id: 't4',
  title: 'Attend gala',
  priority: 'medium',
  dueDate: '2026-12-31',
  createdAt: '2026-01-04T00:00:00.000Z',
});

/** Open, medium priority, no due date, created after `gala`. */
const later = task({
  id: 't5',
  title: 'Read later',
  priority: 'medium',
  createdAt: '2026-01-06T00:00:00.000Z',
});

/** Open, medium priority, no due date, the most recently created task of all. */
const someday = task({
  id: 't6',
  title: 'Someday',
  priority: 'medium',
  createdAt: '2026-01-07T00:00:00.000Z',
});

/**
 * The fixture set in the deliberately awkward order the store is seeded with: the two undated tasks
 * come first and last although they belong together at the end of a due-date order, the completed
 * task sits in the middle, and the identifiers ascend 6, 3, 1, 4, 2, 5. `findAll` promises no
 * ordering, so a suite that relied on this order would be asserting nothing about `sortTasks`.
 */
const seededTasks: Task[] = [someday, taxes, milk, gala, bread, later];

/** The identifier of every fixture, in the seeding order above. */
const seededOrderIds = ['t6', 't3', 't1', 't4', 't2', 't5'];

/**
 * Two tasks that share every sort key — the same due date, the same priority, the same creation
 * instant — and differ only in identifier, seeded with the identifier that sorts *later* first.
 * Their ids sort opposite to their insertion order, so an order that merely preserves the input
 * fails the tie-break assertions rather than passing them by luck.
 */
const tieLater = task({
  id: 'tie-b',
  priority: 'high',
  dueDate: '2026-03-01',
  createdAt: '2026-02-01T00:00:00.000Z',
});
/** The other half of {@link tieLater}: identical keys, and the identifier that sorts first. */
const tieEarlier = task({
  id: 'tie-a',
  priority: 'high',
  dueDate: '2026-03-01',
  createdAt: '2026-02-01T00:00:00.000Z',
});
/** The two key-equal tasks in the order that contradicts the identifier order. */
const tieTasksSeededLaterFirst: Task[] = [tieLater, tieEarlier];

/** The identifiers of a result list, which is what every ordering assertion compares. */
function ids(tasks: readonly Task[]): string[] {
  return tasks.map((entry) => entry.id);
}

/**
 * A complete query with the given parts replaced; the parts a case does not care about take the
 * defaults a request with no query string would produce, so a filtering assertion cannot pass
 * because of an unrelated parameter.
 */
function queryFor(overrides: Partial<TaskQuery> = {}): TaskQuery {
  return { status: 'all', priority: null, sort: 'createdAt', ...overrides };
}

/**
 * Runs a parse expected to be rejected and returns the error it raised, so the assertion can read
 * the field map rather than only prove that something was thrown.
 *
 * @throws When the call completes, which is itself the failure the caller is asserting against.
 */
function captureRejection(run: () => unknown): ValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the query to be rejected, but it was accepted');
}

describe('parseTaskQuery', () => {
  it('applies every default when the query object is empty', () => {
    expect(parseTaskQuery({})).toEqual({ status: 'all', priority: null, sort: 'createdAt' });
  });

  it('treats the documented empty-value form as the defaults, never an error', () => {
    // The request documents `GET /api/tasks?status=&priority=&sort=`; an empty parameter is a
    // request for the default, so a parser that rejected it would fail the contract it implements.
    expect(parseTaskQuery({ status: '', priority: '', sort: '' })).toEqual({
      status: 'all',
      priority: null,
      sort: 'createdAt',
    });
  });

  it('treats an absent parameter exactly as it treats an empty one', () => {
    expect(parseTaskQuery({ status: 'open' })).toEqual({
      status: 'open',
      priority: null,
      sort: 'createdAt',
    });
    // One parameter empty while another carries a value: the empty one takes its default and the
    // supplied one is echoed, so the two are resolved independently.
    expect(parseTaskQuery({ status: '', sort: 'dueDate' })).toEqual({
      status: 'all',
      priority: null,
      sort: 'dueDate',
    });
  });

  it.each(taskStatuses)('echoes the status %s', (status) => {
    expect(parseTaskQuery({ status })).toEqual({ status, priority: null, sort: 'createdAt' });
  });

  it.each(taskPriorities)('echoes the priority %s', (priority) => {
    expect(parseTaskQuery({ priority })).toEqual({ status: 'all', priority, sort: 'createdAt' });
  });

  it.each(sortKeys)('echoes the sort %s', (sort) => {
    expect(parseTaskQuery({ sort })).toEqual({ status: 'all', priority: null, sort });
  });

  it('returns exactly the three contract properties, ignoring any other parameter', () => {
    // A client typo must not reach the query: the record is whatever the client sent, and only the
    // three contract parameters are read out of it.
    expect(parseTaskQuery({ status: 'open', page: '2', limit: '50' })).toEqual({
      status: 'open',
      priority: null,
      sort: 'createdAt',
    });
  });

  /** One case per rejected value, with the field map the HTTP layer turns into a 400 body. */
  const invalidQueries: Array<{
    label: string;
    raw: TaskQueryInput;
    fields: Record<string, string>;
  }> = [
    { label: 'unknown status', raw: { status: 'done' }, fields: { status: STATUS_MESSAGE } },
    { label: 'wrongly cased status', raw: { status: 'Open' }, fields: { status: STATUS_MESSAGE } },
    {
      label: 'unknown priority',
      raw: { priority: 'urgent' },
      fields: { priority: PRIORITY_MESSAGE },
    },
    {
      label: 'wrongly cased priority',
      raw: { priority: 'High' },
      fields: { priority: PRIORITY_MESSAGE },
    },
    { label: 'unknown sort', raw: { sort: 'title' }, fields: { sort: SORT_MESSAGE } },
    { label: 'nearly right sort', raw: { sort: 'due_date' }, fields: { sort: SORT_MESSAGE } },
    {
      label: 'unsupported priority beside an empty status',
      raw: { status: '', priority: 'urgent', sort: 'dueDate' },
      fields: { priority: PRIORITY_MESSAGE },
    },
  ];

  it.each(invalidQueries)('rejects an invalid $label with its own message', (testCase) => {
    const error = captureRejection(() => parseTaskQuery(testCase.raw));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(VALIDATION_ERROR_MESSAGE);
    expect(error.fields).toEqual(testCase.fields);
  });

  it('reports every offending parameter at once when several are invalid', () => {
    // One response carries a message per mistake, so the caller can correct all three parameters in
    // a single pass rather than discover the second after fixing the first.
    const error = captureRejection(() =>
      parseTaskQuery({ status: 'done', priority: 'urgent', sort: 'title' }),
    );

    expect(error.fields).toEqual({
      status: STATUS_MESSAGE,
      priority: PRIORITY_MESSAGE,
      sort: SORT_MESSAGE,
    });
  });
});

describe('filterTasks', () => {
  it('returns every task when the status is all', () => {
    expect(ids(filterTasks(seededTasks, queryFor({ status: 'all' })))).toEqual(seededOrderIds);
    // The same selection by way of the default, which is what a request with no query string gets.
    expect(ids(filterTasks(seededTasks, queryFor()))).toEqual(seededOrderIds);
  });

  it('returns only the open tasks when the status is open', () => {
    // `taxes` is the one completed fixture; the survivors keep the order they were given in,
    // because selection is a stable filter and ordering is `sortTasks`'s business alone.
    expect(ids(filterTasks(seededTasks, queryFor({ status: 'open' })))).toEqual([
      't6',
      't1',
      't4',
      't2',
      't5',
    ]);
  });

  it('returns only the completed tasks when the status is completed', () => {
    expect(ids(filterTasks(seededTasks, queryFor({ status: 'completed' })))).toEqual(['t3']);
  });

  /** One case per priority level, with the identifiers a restriction to that level selects. */
  const priorityCases: Array<{ priority: TaskPriority; expected: string[] }> = [
    { priority: 'low', expected: ['t3'] },
    { priority: 'high', expected: ['t1', 't2'] },
    { priority: 'medium', expected: ['t6', 't4', 't5'] },
  ];

  it.each(priorityCases)('restricts the list to $priority priority', ({ priority, expected }) => {
    expect(ids(filterTasks(seededTasks, queryFor({ priority })))).toEqual(expected);
  });

  it('applies no priority filter when priority is null', () => {
    expect(ids(filterTasks(seededTasks, queryFor({ priority: null })))).toEqual(seededOrderIds);
  });

  it('combines the status and priority restrictions', () => {
    // Open AND high, which is the intersection: the completed task and every other level drop out.
    expect(ids(filterTasks(seededTasks, queryFor({ status: 'open', priority: 'high' })))).toEqual([
      't1',
      't2',
    ]);
  });

  it('returns an empty array when no task satisfies the query', () => {
    // The server side of the "no matching tasks" screen, which the interface shows instead of the
    // empty state when a filter matched nothing.
    const selected = filterTasks(seededTasks, queryFor({ status: 'completed', priority: 'high' }));

    expect(ids(selected)).toEqual([]);
  });

  it('returns a new array and leaves its input untouched', () => {
    const input = [...seededTasks];
    const before = structuredClone(input);

    const result = filterTasks(input, queryFor({ status: 'open' }));

    expect(result).not.toBe(input);
    expect(input).toEqual(before);
  });

  it('returns an empty array for empty input', () => {
    expect(filterTasks([], queryFor({ status: 'open', priority: 'high' }))).toEqual([]);
    expect(filterTasks([], queryFor())).toEqual([]);
  });
});

describe('sortTasks', () => {
  it('sorts by due date, earliest first, with every undated task after the dated ones', () => {
    // `taxes` (5 January) leads, `milk` and `bread` share 14 February and are separated by their
    // identifiers, `gala` (31 December) follows them, and `later` and `someday` come last even
    // though they were seeded first and last: a task with no due date has no place in the middle.
    expect(ids(sortTasks(seededTasks, 'dueDate'))).toEqual(['t3', 't1', 't2', 't4', 't5', 't6']);
  });

  it('sorts by priority as high, then medium, then low', () => {
    // The two high tasks in identifier order, the three medium ones likewise, then the low one.
    expect(ids(sortTasks(seededTasks, 'priority'))).toEqual(['t1', 't2', 't4', 't5', 't6', 't3']);
  });

  it('sorts by creation time with the most recently created task first', () => {
    // Descending, and deliberately unrelated to the identifier order: t6 was created last, t1 first.
    expect(ids(sortTasks(seededTasks, 'createdAt'))).toEqual(['t6', 't5', 't2', 't4', 't3', 't1']);
  });

  it.each(sortKeys)('breaks a %s tie by identifier ascending', (sort) => {
    // The two fixtures share every key `sort` looks at, and were seeded with the identifier that
    // sorts later first, so an order that simply preserved the input would come back reversed.
    expect(ids(sortTasks(tieTasksSeededLaterFirst, sort))).toEqual(['tie-a', 'tie-b']);
  });

  it('compares two tasks that share every sort key as equal', () => {
    // The identifier is the last resort of each comparator rather than a key it can invent an
    // answer for. A store holds one task per identifier, so these equal branches are reachable
    // only through the exported comparators — which is why they are exercised here.
    const duplicate = { ...milk };

    expect(compareByDueDate(milk, duplicate)).toBe(0);
    expect(compareByPriority(milk, duplicate)).toBe(0);
    expect(compareByCreatedAt(milk, duplicate)).toBe(0);
  });

  /** Two further orders of the same six fixtures, written out by hand so no shuffle is needed. */
  const permutedTasks: Task[][] = [
    [gala, someday, bread, later, taxes, milk],
    [later, milk, gala, taxes, someday, bread],
  ];

  it.each(sortKeys)('produces one order for any permutation of the input (%s)', (sort) => {
    // A total order is what makes the acceptance criterion assertable: the same tasks come back in
    // the same sequence however the store happened to hand them over.
    const canonical = ids(sortTasks(seededTasks, sort));

    for (const permutation of permutedTasks) {
      expect(ids(sortTasks(permutation, sort))).toEqual(canonical);
    }
  });

  it('returns a new array and leaves its input untouched', () => {
    const input = [...seededTasks];
    const before = structuredClone(input);

    const result = sortTasks(input, 'dueDate');

    expect(result).not.toBe(input);
    expect(input).toEqual(before);
  });

  it.each(sortKeys)('returns an empty array for empty input (%s)', (sort) => {
    expect(sortTasks([], sort)).toEqual([]);
  });
});

describe('ListTasks.execute', () => {
  let repository: TaskRepository;
  let listTasks: ListTasks;

  beforeEach(() => {
    vi.restoreAllMocks();
    repository = new InMemoryTaskRepository(seededTasks);
    listTasks = new ListTasks({ repository });
  });

  it('reads the store exactly once and calls no other repository method', async () => {
    const findByIdSpy = vi.spyOn(repository, 'findById');
    const findAllSpy = vi.spyOn(repository, 'findAll');
    const insertSpy = vi.spyOn(repository, 'insert');
    const updateSpy = vi.spyOn(repository, 'update');
    const deleteSpy = vi.spyOn(repository, 'delete');

    await listTasks.execute(queryFor({ status: 'open', priority: 'high', sort: 'dueDate' }));

    // One read and one in-memory pass is the whole design: it is what keeps the first list render
    // inside its budget at a thousand tasks, and what leaves every ordering to `taskQuery.ts`.
    expect(findAllSpy).toHaveBeenCalledTimes(1);
    expect(findByIdSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('returns the filter and the sort applied to what the single read returned', async () => {
    const query = queryFor({ status: 'open', priority: 'medium', sort: 'dueDate' });

    // Composed from the two exported functions rather than from a hand-written expectation, so
    // the use case and the semantics it is meant to apply cannot drift apart.
    const stored = await repository.findAll();
    const expected = sortTasks(filterTasks(stored, query), query.sort);
    const actual = await listTasks.execute(query);

    expect(ids(actual)).toEqual(ids(expected));
    expect(actual).toEqual(expected);
  });

  it('orders the list itself rather than passing the stored order through', async () => {
    const listing = await listTasks.execute(queryFor());

    // The fixtures were seeded in the order t6, t3, t1, t4, t2, t5, which is none of the three
    // orders the product offers, so a creation-time result can only come from `sortTasks`.
    expect(ids(listing)).toEqual(['t6', 't5', 't2', 't4', 't3', 't1']);
  });

  it('composes a filter with a sort', async () => {
    const listing = await listTasks.execute({ status: 'open', priority: 'high', sort: 'dueDate' });

    // Only the open high-priority tasks survive, in due-date order, the shared date separated by
    // identifier.
    expect(ids(listing)).toEqual(['t1', 't2']);
  });

  it('keeps the undated tasks last after filtering and sorting together', async () => {
    const listing = await listTasks.execute({
      status: 'open',
      priority: 'medium',
      sort: 'dueDate',
    });

    // The one dated medium fixture leads; the two undated ones follow it, identifiers ascending.
    expect(ids(listing)).toEqual(['t4', 't5', 't6']);
  });

  it('keeps no per-request state between calls', async () => {
    // One instance serves every request, and the interface refetches with the filters that are
    // active at that moment, so no filter may survive into the call that follows it.
    const filtered = await listTasks.execute(queryFor({ status: 'completed' }));
    const unfiltered = await listTasks.execute(queryFor());

    expect(ids(filtered)).toEqual(['t3']);
    expect(ids(unfiltered)).toEqual(['t6', 't5', 't2', 't4', 't3', 't1']);
  });

  it('returns an empty array when the store holds nothing', async () => {
    const emptyListing = new ListTasks({ repository: new InMemoryTaskRepository() });

    expect(await emptyListing.execute(queryFor())).toEqual([]);
    expect(
      await emptyListing.execute(queryFor({ status: 'open', priority: 'high', sort: 'dueDate' })),
    ).toEqual([]);
  });
});

