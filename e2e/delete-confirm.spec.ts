/**
 * End-to-end coverage for deletion behind its confirmation — AAP acceptance criterion 3.
 *
 * What it proves in the running product: the Delete control opens a confirmation naming the task
 * and changes nothing by itself, cancelling and pressing Escape both leave the task in place and on
 * the server, confirming removes it for good — the removal survives a reload — and a repeat
 * `DELETE /api/tasks/:id` answers 404.
 *
 * The criterion is not "delete works" but "delete is impossible without the confirmation", so every
 * path that dismisses the dialog asserts that the task survives on the screen and on the server.
 * Cancelling and pressing Escape are two tests rather than one: they are two separate ways out of
 * the dialog, and neither of them may delete.
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

/** The task the confirmation is opened on, and the only task any test in this file deletes. */
const DOOMED_TITLE = 'Delete me';

/**
 * The task that has to survive every dismissal. Seeding it is what turns "the task is still there"
 * into "only the confirmed task went" — which a store holding a single task cannot show.
 */
const KEEPER_TITLE = 'Keep me';

/** The heading `TaskItem` gives the confirmation, and therefore the dialog's accessible name. */
const CONFIRM_DIALOG_NAME = 'Delete task';

/** The one list item whose text contains `title`. */
function item(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

/**
 * The delete confirmation.
 *
 * Every control inside the dialog is queried through this locator rather than from the page. Each
 * item carries its own `Delete` control, so an unscoped `page.getByRole('button', { name: 'Delete' })`
 * matches the item's control and the dialog's at once and fails on a strict-mode violation instead
 * of answering the question the test meant to ask.
 */
function confirmDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: CONFIRM_DIALOG_NAME });
}

test.describe('delete with a confirmation', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('cancelling the confirmation keeps the task and returns focus to its Delete control', async ({
    page,
    request,
  }) => {
    await seedTasks(request);
    await page.goto('/');

    const doomed = item(page, DOOMED_TITLE);
    const keeper = item(page, KEEPER_TITLE);
    await expect(doomed).toBeVisible();
    await expect(keeper).toBeVisible();

    // The item's own Delete control only opens the confirmation: the request it is about to make is
    // issued by the dialog's confirm control and by nothing else.
    const deleteControl = doomed.getByRole('button', { name: 'Delete' });
    await deleteControl.click();

    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(DOOMED_TITLE);

    // Opening the modal moved focus into it, so a keyboard user reaches both choices without
    // tabbing through the page behind it. Polled rather than read once, so the assertion waits for
    // the focus the browser places rather than depending on the click having resolved after it.
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // Nothing changed by the dismissal: both items are still listed and the server still holds both
    // tasks, so the task survived rather than merely looking as if it had.
    await expect(doomed).toBeVisible();
    await expect(keeper).toBeVisible();
    expect(await listTasks(request)).toHaveLength(2);

    // Focus came back to the control that opened the dialog, so the keyboard user resumes where
    // they were instead of at the start of the page.
    await expect(deleteControl).toBeFocused();
  });

  test('pressing Escape dismisses the confirmation without deleting', async ({ page, request }) => {
    const seeded = await seedTasks(request);
    await page.goto('/');

    const doomed = item(page, DOOMED_TITLE);
    const deleteControl = doomed.getByRole('button', { name: 'Delete' });

    // Opened from the keyboard: focusing the control and pressing Enter is the whole path, with no
    // pointer involved.
    await deleteControl.focus();
    await page.keyboard.press('Enter');

    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(DOOMED_TITLE);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Escape dismisses exactly as Cancel does: both tasks stay on the screen and on the server.
    await expect(doomed).toBeVisible();
    await expect(item(page, KEEPER_TITLE)).toBeVisible();

    const survivors = (await listTasks(request)).map((task) => task.id);
    expect(survivors).toHaveLength(2);
    expect(survivors).toContain(seeded.doomed.id);
    expect(survivors).toContain(seeded.keeper.id);
  });

  test('confirming removes the task for good, and a repeat DELETE answers 404', async ({
    page,
    request,
  }) => {
    const seeded = await seedTasks(request);
    await page.goto('/');

    const doomed = item(page, DOOMED_TITLE);
    // The task to delete carries a non-default priority, so its item shows a priority word as well
    // as its title — and the confirmed delete below takes the whole item away, tag included.
    await expect(doomed).toContainText('High');
    await doomed.getByRole('button', { name: 'Delete' }).click();

    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete' }).click();

    // Gone from the screen, and only it: the task that was never confirmed is still listed.
    await expect(doomed).toHaveCount(0);
    await expect(item(page, KEEPER_TITLE)).toBeVisible();

    const remaining = await listTasks(request);
    expect(remaining.map((task) => task.id)).toEqual([seeded.keeper.id]);

    // Removed from the store rather than filtered off the screen: a reload refetches the list from
    // the server with nothing of the page's own carried over, and the task is still absent.
    await page.reload();
    await expect(item(page, DOOMED_TITLE)).toHaveCount(0);
    await expect(item(page, KEEPER_TITLE)).toBeVisible();
    expect(await listTasks(request)).toHaveLength(1);

    // And gone for good: the repeat delete answers 404 rather than a second 204.
    expect(await deleteTask(request, seeded.doomed.id)).toBe(404);

    // The 404 is the contract's error envelope: the code is machine-readable and the field map is
    // present and empty, because a missing task belongs to no field of the request.
    const read = await getTaskResponse(request, seeded.doomed.id);
    expect(read.status).toBe(404);
    if (!isApiErrorBody(read.body)) {
      throw new Error(`Expected task ${seeded.doomed.id} to be missing, received a task body.`);
    }
    expect(read.body.error.code).toBe('NOT_FOUND');
    expect(read.body.error.fields).toEqual({});
  });
});

/** The two tasks every test works with: the one to delete, and the one that must survive it. */
interface SeededTasks {
  doomed: TaskDto;
  keeper: TaskDto;
}

/**
 * Seeds both tasks through the API rather than through the form: this file is about deletion, and
 * the create route is the shortest way to a known store. The task to delete is given a non-default
 * priority so its item is not the default shape.
 */
async function seedTasks(request: APIRequestContext): Promise<SeededTasks> {
  const keeper = await createTask(request, { title: KEEPER_TITLE });
  const doomed = await createTask(request, { title: DOOMED_TITLE, priority: 'high' });

  return { doomed, keeper };
}
