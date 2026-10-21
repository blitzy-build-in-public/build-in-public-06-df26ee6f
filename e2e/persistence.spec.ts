/**
 * End-to-end coverage for persistence across a page reload — AAP acceptance criterion 1.
 *
 * What it proves in the running product: a task created through the form, and a change made to that
 * task afterwards, are held by the API rather than remembered by the screen. The interface keeps no
 * copy of the list — `useTasks` fetches `GET /api/tasks` on mount and refetches it after every
 * mutation, and the server is the single source of truth — so a reload discards everything the
 * browser held, and the list it renders next can only have come from a fetch. That is why the
 * assertions are made twice: once against the rendered list and once against the API's own listing,
 * so a stale in-memory list could never be mistaken for storage.
 *
 * The reload half of criterion 1 is this spec's whole scope. The restart half — the real entry point
 * stopped and started again against one database file — belongs to
 * `backend/tests/integration/restart.test.ts` and is deliberately not repeated here.
 *
 * The store is shared with every other spec — one SQLite file, one worker — so this test clears it
 * through `e2e/support/api.ts` before it asserts, and every path stays relative so it resolves
 * against `use.baseURL` and travels the Vite `/api` proxy.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { clearAllTasks, listTasks, type TaskDto } from './support/api';

/** The task created from a title alone, so it takes every server default it can. */
const PLAIN_TITLE = 'Reload me';

/** The task created with a priority and a due date, and completed before the reload. */
const DETAILED_TITLE = 'Reload me too';

/**
 * A due date far in the future. It keeps the overdue rule out of this spec's failure surface
 * entirely, so a red run here means persistence broke and nothing else.
 */
const FUTURE_DUE_DATE = '2030-01-15';

/** The empty-list message, which is what the store cleared in `beforeEach` has to show. */
const EMPTY_LIST_MESSAGE = 'No tasks yet. Add your first task using the form above.';

/**
 * The create form.
 *
 * Located by its own `Title` control rather than by a heading or by the submit control's visible
 * text: the words on that button are not part of any contract this suite may lean on, while the
 * labelled `Title` field is. Scoping every field lookup to this form is what keeps its `Priority`
 * select apart from the filter bar's — an unscoped `getByLabel('Priority')` matches both and fails
 * in strict mode.
 */
function createForm(page: Page): Locator {
  return page.locator('form').filter({ has: page.getByLabel('Title') });
}

/**
 * The one list item whose heading is exactly `title`.
 *
 * Matched on the item's own heading, not on its text: one of this spec's titles is a prefix of the
 * other, so a text filter would return both items and every assertion on the result would fail in
 * strict mode.
 */
function item(page: Page, title: string): Locator {
  return page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });
}

/** The stored task carrying this exact title, or a failure — a listing without it is the assertion's. */
function taskTitled(tasks: readonly TaskDto[], title: string): TaskDto {
  const task = tasks.find((candidate) => candidate.title === title);

  if (task === undefined) {
    throw new Error(
      `Expected the store to hold a task titled "${title}", but it held ${tasks.length}.`,
    );
  }

  return task;
}

test.describe('persistence', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('tasks survive a page reload, including an update made before the reload', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await expect(page.getByText(EMPTY_LIST_MESSAGE)).toBeVisible();

    const form = createForm(page);

    // Both tasks are created through the form, so each write travels the whole stack: the form, the
    // typed client, the Vite proxy, the route, the use case and the SQLite adapter.
    await form.getByLabel('Title').fill(PLAIN_TITLE);
    await form.getByRole('button').click();

    const plain = item(page, PLAIN_TITLE);
    await expect(plain.getByRole('heading', { level: 3, name: PLAIN_TITLE })).toBeVisible();
    await expect(plain).toContainText('Medium');
    // No due date renders as no date at all, rather than as an empty placeholder.
    await expect(plain.locator('time')).toHaveCount(0);
    await expect(plain.getByRole('checkbox')).not.toBeChecked();

    await form.getByLabel('Title').fill(DETAILED_TITLE);
    await form.getByLabel('Priority').selectOption('high');
    await form.getByLabel('Due date').fill(FUTURE_DUE_DATE);
    await form.getByRole('button').click();

    const detailed = item(page, DETAILED_TITLE);
    await expect(detailed.getByRole('heading', { level: 3, name: DETAILED_TITLE })).toBeVisible();
    await expect(detailed).toContainText('High');
    await expect(detailed.locator('time')).toHaveText(FUTURE_DUE_DATE);

    // A change, and not only a creation, has to reach the database: completing this task is the
    // write the reload below proves was stored rather than remembered.
    //
    // Clicked rather than `check()`ed, because the checkbox is a controlled input whose state comes
    // from the refetched list — nothing is applied optimistically — so React restores the control the
    // instant the click lands, and a `check()` that verifies the state straight after clicking cannot
    // succeed. The state is asserted on the next line instead, by an assertion that retries.
    await detailed.getByRole('checkbox', { name: /reload me too/i }).click();
    await expect(detailed.getByRole('checkbox')).toBeChecked();

    // The list the page shows after a reload can only come from the server, so the fetch that
    // supplies it is awaited alongside the reload instead of being assumed.
    const listRequest = page.waitForRequest(
      (request) => request.method() === 'GET' && new URL(request.url()).pathname === '/api/tasks',
    );
    await page.reload();
    await listRequest;

    await expect(page.getByRole('listitem')).toHaveCount(2);

    // First from the rendered list alone: the task created from a title kept every default it was
    // given, and the detailed one kept its priority, its date and its completion.
    const reloadedPlain = item(page, PLAIN_TITLE);
    await expect(reloadedPlain.getByRole('heading', { level: 3, name: PLAIN_TITLE })).toBeVisible();
    await expect(reloadedPlain).toContainText('Medium');
    await expect(reloadedPlain.locator('time')).toHaveCount(0);
    await expect(reloadedPlain.getByRole('checkbox')).not.toBeChecked();
    await expect(reloadedPlain).not.toContainText('Overdue');

    const reloadedDetailed = item(page, DETAILED_TITLE);
    await expect(reloadedDetailed.getByRole('heading', { level: 3, name: DETAILED_TITLE })).toBeVisible();
    await expect(reloadedDetailed).toContainText('High');
    await expect(reloadedDetailed.locator('time')).toHaveText(FUTURE_DUE_DATE);
    await expect(reloadedDetailed.getByRole('checkbox')).toBeChecked();
    // A completed task is never flagged, whatever its date is; this one is also far from due.
    await expect(reloadedDetailed).not.toContainText('Overdue');

    // Then against the server's own listing, which is what makes the persistence claim non-trivial:
    // the screen agrees with the store field for field. The two timestamps are deliberately never
    // asserted here — the server's clock is the backend unit layer's business, where a fixed clock
    // pins it — so only the fields the user set are compared.
    const tasks = await listTasks(request);
    expect(tasks).toHaveLength(2);

    const storedPlain = taskTitled(tasks, PLAIN_TITLE);
    expect(storedPlain.description).toBe('');
    expect(storedPlain.priority).toBe('medium');
    expect(storedPlain.dueDate).toBeNull();
    expect(storedPlain.completed).toBe(false);

    const storedDetailed = taskTitled(tasks, DETAILED_TITLE);
    expect(storedDetailed.priority).toBe('high');
    expect(storedDetailed.dueDate).toBe(FUTURE_DUE_DATE);
    expect(storedDetailed.completed).toBe(true);
  });
});
