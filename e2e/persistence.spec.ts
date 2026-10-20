/**
 * End-to-end coverage for persistence across a page reload — AAP acceptance criterion 1.
 *
 * What it proves in the running product: a task created through the form is stored by the API
 * rather than remembered by the screen. A reload discards everything the browser held — React
 * state, the list, the client — and the page refetches from `GET /api/tasks`, so the task being
 * back, with the same identity and every field intact, is what shows it came from the database.
 *
 * The store is shared with every other spec — one SQLite file, one worker — so the test clears it
 * through `e2e/support/api.ts` before it asserts, and every path stays relative so it resolves
 * against `use.baseURL`.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { clearAllTasks, listTasks, type TaskDto } from './support/api';

/** The task this spec creates, with the three fields a reload must bring back beside its title. */
const TITLE = 'Book the dentist';
const DESCRIPTION = 'Ask for the morning slot.';
const DUE_DATE = '2031-03-09';

/** The create form's section; scoping to it keeps its `Priority` apart from the filter bar's. */
function createForm(page: Page): Locator {
  return page.getByRole('region', { name: 'Add a task' });
}

/** The one list item whose text contains `title`. */
function item(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

/** The single task the store holds, or a failure — a listing that is not singular is the assertion's. */
function onlyTask(tasks: readonly TaskDto[]): TaskDto {
  const [task] = tasks;
  if (task === undefined) {
    throw new Error(`Expected the store to hold one task, but the listing held ${tasks.length}.`);
  }
  return task;
}

test.describe('persistence', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('a task created in the form survives a reload unchanged', async ({ page, request }) => {
    await page.goto('/');

    const form = createForm(page);
    await form.getByLabel('Title').fill(TITLE);
    await form.getByLabel('Description').fill(DESCRIPTION);
    await form.getByLabel('Priority').selectOption('high');
    await form.getByLabel('Due date').fill(DUE_DATE);
    await form.getByRole('button', { name: 'Add task' }).click();

    const listed = item(page, TITLE);
    await expect(listed.getByRole('heading', { level: 3, name: TITLE })).toBeVisible();
    await expect(listed).toContainText('High');
    await expect(listed).toContainText(DESCRIPTION);
    await expect(listed.locator('time')).toHaveText(DUE_DATE);
    await expect(listed.getByRole('checkbox')).not.toBeChecked();

    const before = onlyTask(await listTasks(request));

    await page.reload();

    // The same item, with every field the form submitted, still on the screen after the reload.
    const reloaded = item(page, TITLE);
    await expect(reloaded.getByRole('heading', { level: 3, name: TITLE })).toBeVisible();
    await expect(reloaded).toContainText('High');
    await expect(reloaded).toContainText(DESCRIPTION);
    await expect(reloaded.locator('time')).toHaveText(DUE_DATE);
    await expect(reloaded.getByRole('checkbox')).not.toBeChecked();

    // The same row, unchanged: a reload reads the store, so neither timestamp moves.
    const after = onlyTask(await listTasks(request));
    expect(after.id).toBe(before.id);
    expect(after.title).toBe(TITLE);
    expect(after.description).toBe(DESCRIPTION);
    expect(after.priority).toBe('high');
    expect(after.dueDate).toBe(DUE_DATE);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});
