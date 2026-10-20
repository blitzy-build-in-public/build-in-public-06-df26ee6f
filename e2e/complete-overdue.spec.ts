/**
 * End-to-end coverage for the overdue flag and for completion — AAP acceptance criteria 6 and 4.
 *
 * What it proves in the running product: an open task due yesterday carries the word `Overdue`
 * beside its date and one due today does not, a completed task is never flagged however old its
 * date is, and completing the flagged task through its checkbox takes the flag away and moves the
 * task out of the open filter and into the completed one.
 *
 * Both dates are computed from the machine's local calendar date, which is the date the interface
 * compares against, so the assertions hold in any time zone. The store is shared with every other
 * spec — one SQLite file, one worker — so each test clears it through `e2e/support/api.ts` before
 * it asserts, and every path stays relative so it resolves against `use.baseURL`.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { clearAllTasks, createTask, listTasks, patchTask } from './support/api';

/** The title of the task whose date is in the past. */
const OVERDUE_TITLE = 'Renew the passport';

/** The title of the task due today, which is the boundary the rule must not cross. */
const TODAY_TITLE = 'Return the ladder';

/** The title of the task that is already completed, which can never be flagged. */
const COMPLETED_TITLE = 'File the receipts';

/** The machine's local calendar date, offset by `days`, as a zero-padded `YYYY-MM-DD` string. */
function localIsoDate(offsetDays: number): string {
  const date = new Date();
  // `setDate` takes the month and year with it, so a boundary such as the first of a month is safe.
  date.setDate(date.getDate() + offsetDays);

  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/** The one list item whose text contains `title`. */
function item(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

test.describe('the overdue flag and completion', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('flags an open task due yesterday, not one due today, and never a completed one', async ({
    page,
    request,
  }) => {
    const yesterday = localIsoDate(-1);
    const today = localIsoDate(0);

    await createTask(request, { title: OVERDUE_TITLE, dueDate: yesterday });
    await createTask(request, { title: TODAY_TITLE, dueDate: today });
    const completed = await createTask(request, { title: COMPLETED_TITLE, dueDate: yesterday });
    await patchTask(request, completed.id, { completed: true });

    await page.goto('/');

    const overdue = item(page, OVERDUE_TITLE);
    await expect(overdue.locator('time')).toHaveText(yesterday);
    await expect(overdue).toContainText('Overdue');

    // Due today is the strict boundary: the same date never reads as overdue.
    const dueToday = item(page, TODAY_TITLE);
    await expect(dueToday.locator('time')).toHaveText(today);
    await expect(dueToday).not.toContainText('Overdue');

    // A completed task keeps showing its date and is never flagged, whatever the date is.
    const completedItem = item(page, COMPLETED_TITLE);
    await expect(completedItem.locator('time')).toHaveText(yesterday);
    await expect(completedItem).not.toContainText('Overdue');
  });

  test('completing the flagged task removes the flag and moves it out of the open filter', async ({
    page,
    request,
  }) => {
    const yesterday = localIsoDate(-1);
    const overdue = await createTask(request, { title: OVERDUE_TITLE, dueDate: yesterday });
    const dueToday = await createTask(request, { title: TODAY_TITLE, dueDate: localIsoDate(0) });

    await page.goto('/');

    const target = item(page, OVERDUE_TITLE);
    await expect(target).toContainText('Overdue');
    const checkbox = target.getByRole('checkbox');
    await expect(checkbox).toBeVisible();
    await checkbox.click();

    // Completing sends the toggle request, and the item comes back without the flag while still
    // showing the date it is due. The label's curly quotes are the ones `TaskItem` renders.
    await expect(
      target.getByRole('checkbox', { name: `Reopen \u201c${OVERDUE_TITLE}\u201d` }),
    ).toBeChecked();
    await expect(target).not.toContainText('Overdue');
    await expect(target.locator('time')).toHaveText(yesterday);

    // It has left the open filter for the completed one, which is the filter's own question.
    const filterBar = page.getByRole('region', { name: 'Filter and sort' });

    await filterBar.getByLabel('Status').selectOption('completed');
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 3, name: OVERDUE_TITLE })).toBeVisible();

    await filterBar.getByLabel('Status').selectOption('open');
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 3, name: TODAY_TITLE })).toBeVisible();

    // The server holds the state the screen is showing, in the same two halves.
    expect((await listTasks(request, { status: 'completed' })).map((task) => task.id)).toEqual([
      overdue.id,
    ]);
    expect((await listTasks(request, { status: 'open' })).map((task) => task.id)).toEqual([
      dueToday.id,
    ]);
  });
});
