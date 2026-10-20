/**
 * End-to-end coverage for the two required viewport widths — AAP acceptance criterion 8.
 *
 * What it proves in the running product: at 320px and at 1280px the document is never wider than
 * the viewport, so nothing has to be scrolled sideways to be read; and at the narrowest width the
 * create, edit, delete and complete controls are each visible and operable, because actions wrap
 * rather than being hidden when the row runs out of space. A title of 200 unbroken characters is
 * included at both widths, since a long title is the input that would widen the page if it did not
 * wrap.
 *
 * Each width is set with `test.use({ viewport })`, so one run covers both without a second project.
 * The store is shared with every other spec — one SQLite file, one worker — so each test clears it
 * through `e2e/support/api.ts` before it asserts, and every path stays relative so it resolves
 * against `use.baseURL`.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { clearAllTasks, createTask, listTasks } from './support/api';

/** The narrowest width the product must serve, and the wider of the two this spec asserts. */
const NARROW_VIEWPORT = { width: 320, height: 640 };
const WIDE_VIEWPORT = { width: 1280, height: 800 };

/** A title of 200 characters with no space in it, which is the shape that must wrap rather than widen. */
const LONG_TITLE = 'y'.repeat(200);

/**
 * Asserts the document is no wider than the viewport, which is what "no horizontal scrolling" is:
 * `scrollWidth` counts the content that overflows, `clientWidth` the visible width.
 */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const width = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  expect(
    width.scrollWidth,
    `documentElement.scrollWidth ${width.scrollWidth} exceeds clientWidth ${width.clientWidth}`,
  ).toBeLessThanOrEqual(width.clientWidth);
}

/** The one list item whose text contains `title`. */
function item(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

test.describe('at 320px', () => {
  test.use({ viewport: NARROW_VIEWPORT });

  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('shows no horizontal scrolling and keeps every action reachable', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Create.
    const form = page.getByRole('region', { name: 'Add a task' });
    await form.getByLabel('Title').fill('Walk the dog');
    const addTask = form.getByRole('button', { name: 'Add task' });
    await expect(addTask).toBeVisible();
    await addTask.click();
    await expect(item(page, 'Walk the dog')).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Edit, in place inside the row.
    const edit = item(page, 'Walk the dog').getByRole('button', { name: 'Edit' });
    await expect(edit).toBeVisible();
    await edit.click();
    const editForm = page.getByRole('form', { name: 'Edit task: Walk the dog' });
    await editForm.getByLabel('Title').fill('Take the dog out');
    const save = editForm.getByRole('button', { name: 'Save' });
    await expect(save).toBeVisible();
    await save.click();
    await expect(item(page, 'Take the dog out')).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Complete.
    const checkbox = item(page, 'Take the dog out').getByRole('checkbox');
    await expect(checkbox).toBeVisible();
    await checkbox.click();
    await expect(item(page, 'Take the dog out').getByRole('checkbox')).toBeChecked();
    await expectNoHorizontalScroll(page);

    // Delete, through the confirmation.
    const remove = item(page, 'Take the dog out').getByRole('button', { name: 'Delete' });
    await expect(remove).toBeVisible();
    await remove.click();
    const confirm = page.getByRole('dialog', { name: 'Delete task' }).getByRole('button', {
      name: 'Delete',
    });
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(page.getByRole('listitem')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    expect(await listTasks(request)).toHaveLength(0);

    // A 200-character title with no break in it must wrap inside the row, not widen the document.
    await createTask(request, { title: LONG_TITLE });
    await page.reload();
    await expect(item(page, LONG_TITLE)).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('at 1280px', () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('shows no horizontal scrolling', async ({ page, request }) => {
    await createTask(request, { title: 'Plan the sprint', description: 'Three weeks of work.' });
    await createTask(request, { title: LONG_TITLE });

    await page.goto('/');
    await expect(item(page, 'Plan the sprint')).toBeVisible();
    await expect(item(page, LONG_TITLE)).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
