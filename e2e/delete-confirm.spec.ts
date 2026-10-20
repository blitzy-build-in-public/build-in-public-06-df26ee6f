/**
 * End-to-end coverage for deletion behind its confirmation — AAP acceptance criterion 3.
 *
 * What it proves in the running product: the Delete control opens a confirmation naming the task
 * and changes nothing by itself, cancelling leaves the task in place and on the server, confirming
 * removes it for good, and a repeat `DELETE /api/tasks/:id` answers 404.
 *
 * The store is shared with every other spec — one SQLite file, one worker — so each test clears it
 * through `e2e/support/api.ts` before it asserts, and every path stays relative so it resolves
 * against `use.baseURL` (the Vite origin) and travels the `/api` proxy.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

import {
  clearAllTasks,
  createTask,
  deleteTask,
  getTaskResponse,
  isApiErrorBody,
  listTasks,
  type TaskDto,
} from './support/api';

/** The title every test in this file deletes, so the confirmation's own text can be asserted. */
const TITLE = 'Cancel the subscription';

/** The empty-list message, which is what proves the confirmed delete emptied the store. */
const EMPTY_LIST_MESSAGE = 'No tasks yet. Add your first task using the form above.';

/** The one list item whose text contains `title`. */
function item(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

test.describe('delete with a confirmation', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('cancelling the confirmation keeps the task', async ({ page, request }) => {
    const seeded = await seedTask(request);
    await openDeleteConfirmation(page);

    const dialog = page.getByRole('dialog', { name: 'Delete task' });
    await expect(dialog).toContainText(TITLE);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Dismissed, with nothing changed: the item is still listed and the server still holds it.
    await expect(dialog).toBeHidden();
    await expect(item(page, TITLE)).toBeVisible();
    const read = await getTaskResponse(request, seeded.id);
    expect(read.status).toBe(200);
    expect(await listTasks(request)).toHaveLength(1);
  });

  test('confirming removes the task, and a repeat DELETE answers 404', async ({ page, request }) => {
    const seeded = await seedTask(request);
    await openDeleteConfirmation(page);

    const dialog = page.getByRole('dialog', { name: 'Delete task' });
    await dialog.getByRole('button', { name: 'Delete' }).click();

    // Gone from the screen and from the store, so the empty state takes the list's place.
    await expect(page.getByRole('listitem')).toHaveCount(0);
    await expect(page.getByText(EMPTY_LIST_MESSAGE)).toBeVisible();
    expect(await listTasks(request)).toHaveLength(0);

    // And gone for good: a read and a second delete both answer 404 through the API itself.
    const read = await getTaskResponse(request, seeded.id);
    expect(read.status).toBe(404);
    const body = read.body;
    if (!isApiErrorBody(body)) {
      throw new Error(`Expected task ${seeded.id} to be missing, received its own body.`);
    }
    expect(body.error.code).toBe('NOT_FOUND');
    expect(await deleteTask(request, seeded.id)).toBe(404);
  });
});

/** Seeds the one task every test in this file deletes. */
async function seedTask(request: APIRequestContext): Promise<TaskDto> {
  return createTask(request, { title: TITLE });
}

/** Opens the screen and presses the task's own Delete control, leaving its confirmation showing. */
async function openDeleteConfirmation(page: Page): Promise<void> {
  await page.goto('/');
  const target = item(page, TITLE);
  await expect(target).toBeVisible();
  await target.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete task' })).toBeVisible();
}
