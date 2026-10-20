/**
 * End-to-end coverage for the status and priority filters and all three sorts — AAP acceptance
 * criterion 5.
 *
 * What it proves in the running product: each filter narrows the list to what it says, each sort
 * returns the order the contract specifies, and a task with no due date comes last on a due-date
 * sort. Every assertion is made on the order the screen renders, because the server returns the
 * list already filtered and sorted and the interface reorders nothing.
 *
 * The order the interface must show is stated here independently of the server: the due-date and
 * priority orders are written out from the dates and levels the seeded tasks carry, and the two
 * `high` tasks, which are tied on the priority key, are ordered by the documented `id`-ascending
 * tie-break. Only the creation-time order reads the timestamps the server returned, because two
 * tasks created inside one millisecond are separated by that same tie-break.
 *
 * The store is shared with every other spec — one SQLite file, one worker — so each test clears it
 * through `e2e/support/api.ts` before it asserts, and every path stays relative so it resolves
 * against `use.baseURL`.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { clearAllTasks, createTask, patchTask, type TaskDto } from './support/api';

/** The machine's local calendar date, offset by `days`, as a zero-padded `YYYY-MM-DD` string. */
function localIsoDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);

  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/** The four tasks each test seeds, named for the field that pins its place in an order. */
interface SeededTasks {
  /** `high`, due in five days. */
  readonly high: TaskDto;
  /** `medium`, due tomorrow. */
  readonly medium: TaskDto;
  /** `low`, with no due date at all. */
  readonly undated: TaskDto;
  /** `high`, due in three days — tied with `high` on the priority key. */
  readonly otherHigh: TaskDto;
}

/** Seeds the four tasks, oldest first, so creation time is a fourth distinct ordering key. */
async function seedTasks(request: APIRequestContext): Promise<SeededTasks> {
  const high = await createTask(request, {
    title: 'Ship the release',
    priority: 'high',
    dueDate: localIsoDate(5),
  });
  const medium = await createTask(request, {
    title: 'Write the changelog',
    priority: 'medium',
    dueDate: localIsoDate(1),
  });
  const undated = await createTask(request, { title: 'Tidy the backlog', priority: 'low' });
  const otherHigh = await createTask(request, {
    title: 'Book the venue',
    priority: 'high',
    dueDate: localIsoDate(3),
  });

  return { high, medium, undated, otherHigh };
}

/** The section holding the filter and sort controls, kept apart from the create form's fields. */
function filterBar(page: Page): Locator {
  return page.getByRole('region', { name: 'Filter and sort' });
}

/** The headings of the rendered list, which is the order the screen is showing. */
function renderedTitles(page: Page): Locator {
  return page.getByRole('list').getByRole('heading', { level: 3 });
}

/** The titles of `tasks`, which is what a rendered order is compared against. */
function titlesOf(tasks: readonly TaskDto[]): string[] {
  return tasks.map((task) => task.title);
}

/** Earliest due date first, with the undated task after every dated one. */
function byDueDate(seeded: SeededTasks): TaskDto[] {
  return [seeded.medium, seeded.otherHigh, seeded.high, seeded.undated];
}

/**
 * The two `high` tasks in the order the priority sort must place them.
 *
 * They carry the same priority, so the sort key ties and the documented `id`-ascending tie-break
 * decides which comes first — the one ordering in this file that is stated as a rule rather than
 * read off the data.
 */
function highsInTieBreakOrder(seeded: SeededTasks): [TaskDto, TaskDto] {
  return seeded.high.id < seeded.otherHigh.id
    ? [seeded.high, seeded.otherHigh]
    : [seeded.otherHigh, seeded.high];
}

/** Most recently created first, with the `id`-ascending tie-break inside one timestamp. */
function newestFirst(tasks: readonly TaskDto[]): TaskDto[] {
  const ordered = [...tasks];

  ordered.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? 1 : -1;
    }
    return left.id < right.id ? -1 : 1;
  });

  return ordered;
}

test.describe('filter and sort', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('filters by status, keeping the default order of newest first', async ({ page, request }) => {
    const seeded = await seedTasks(request);
    await patchTask(request, seeded.medium.id, { completed: true });

    await page.goto('/');

    // The defaults are `status=all` and `sort=createdAt`, so the screen opens newest first.
    const all = [seeded.high, seeded.medium, seeded.undated, seeded.otherHigh];
    await expect(renderedTitles(page)).toHaveText(titlesOf(newestFirst(all)));

    const bar = filterBar(page);

    await bar.getByLabel('Status').selectOption('completed');
    await expect(renderedTitles(page)).toHaveText([seeded.medium.title]);

    await bar.getByLabel('Status').selectOption('open');
    await expect(renderedTitles(page)).toHaveText(
      titlesOf(newestFirst([seeded.high, seeded.undated, seeded.otherHigh])),
    );

    await bar.getByLabel('Status').selectOption('all');
    await expect(renderedTitles(page)).toHaveText(titlesOf(newestFirst(all)));
  });

  test('filters by priority', async ({ page, request }) => {
    const seeded = await seedTasks(request);

    await page.goto('/');
    const bar = filterBar(page);

    // The due-date sort makes each filtered order unambiguous: the two high tasks have different
    // due dates, and the undated task is the only low one.
    await bar.getByLabel('Sort by').selectOption('dueDate');

    await bar.getByLabel('Priority').selectOption('high');
    await expect(renderedTitles(page)).toHaveText([seeded.otherHigh.title, seeded.high.title]);

    await bar.getByLabel('Priority').selectOption('low');
    await expect(renderedTitles(page)).toHaveText([seeded.undated.title]);

    // The empty value is the "All priorities" choice, which restores the whole list.
    await bar.getByLabel('Priority').selectOption('');
    await expect(renderedTitles(page)).toHaveText(titlesOf(byDueDate(seeded)));
  });

  test('sorts by due date, placing the undated task last', async ({ page, request }) => {
    const seeded = await seedTasks(request);

    await page.goto('/');
    await filterBar(page).getByLabel('Sort by').selectOption('dueDate');

    await expect(renderedTitles(page)).toHaveText(
      titlesOf([seeded.medium, seeded.otherHigh, seeded.high, seeded.undated]),
    );
  });

  test('sorts by priority, high first', async ({ page, request }) => {
    const seeded = await seedTasks(request);
    const [firstHigh, secondHigh] = highsInTieBreakOrder(seeded);

    await page.goto('/');
    await filterBar(page).getByLabel('Sort by').selectOption('priority');

    await expect(renderedTitles(page)).toHaveText([
      firstHigh.title,
      secondHigh.title,
      seeded.medium.title,
      seeded.undated.title,
    ]);
  });

  test('sorts by creation time, newest first', async ({ page, request }) => {
    const seeded = await seedTasks(request);
    const all = [seeded.high, seeded.medium, seeded.undated, seeded.otherHigh];

    await page.goto('/');
    const bar = filterBar(page);

    // Switch away and back, so the assertion is about selecting the sort rather than about the
    // order the screen happened to open with.
    await bar.getByLabel('Sort by').selectOption('dueDate');
    await expect(renderedTitles(page)).toHaveText(titlesOf(byDueDate(seeded)));

    await bar.getByLabel('Sort by').selectOption('createdAt');
    await expect(renderedTitles(page)).toHaveText(titlesOf(newestFirst(all)));
  });
});
