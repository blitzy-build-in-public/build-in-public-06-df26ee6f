/**
 * End-to-end coverage for the two viewport widths the product must serve — AAP acceptance
 * criterion 8.
 *
 * What it proves in the running product: at 320px and at 1280px the document is never wider than
 * the viewport, so nothing has to be scrolled sideways to be read; and at the narrowest width the
 * create, complete, edit and delete controls are each visible, enabled and operable, because a
 * row's actions wrap rather than being hidden when it runs out of space. A title of 200 unbroken
 * characters is on screen at both widths, since an unbreakable title is the shape that would widen
 * the page if it did not wrap — and the narrow-width case measures the width twice, once against
 * the freshly loaded list and again once that row is asserted to be on screen, so a regression that
 * appears only with long content cannot slip through.
 *
 * Reachability is asserted by effect rather than by visibility alone: every control this spec calls
 * operable is interacted with and its outcome is asserted, because a control that is on screen and
 * does nothing is not reachable. Two things are deliberately not asserted — the wording of the
 * create form's submit control, which the plan does not fix, and any layout geometry or viewport
 * intersection, because the requirement is that no action is hidden, collapsed or clipped and
 * Playwright's own actionability check scrolls as needed.
 *
 * Each width is set with `test.use({ viewport })`, so one run covers both without a second browser
 * project. The store is shared with every other spec — one SQLite file, one worker — so each test
 * clears it through `e2e/support/api.ts` before it asserts; every path stays relative so it resolves
 * against `use.baseURL` (the Vite origin) and travels the `/api` proxy; the fixtures are seeded
 * through the API while every action this spec asserts is performed through the interface itself;
 * and no timestamp and no machine-dependent date is asserted anywhere in this file.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

import { clearAllTasks, createTask, listTasks } from './support/api';

/** The narrowest width the product must serve, and the first of the two this spec asserts. */
const NARROW_VIEWPORT = { width: 320, height: 640 };

/** The desktop width, the second of the two this spec asserts. */
const WIDE_VIEWPORT = { width: 1280, height: 800 };

/**
 * A title at the domain's 200-character bound and with no space in it.
 *
 * This is the hazard the responsive rules exist for: an unbroken string whose min-content width
 * would widen the page on its own if the stylesheets did not break it.
 */
const LONG_TITLE = 'W'.repeat(200);

/**
 * A due date far enough ahead that a dated fixture never reads as overdue, whatever the machine's
 * clock says — this spec asserts reachability, not the overdue rule.
 */
const FUTURE_DUE_DATE = '2030-01-15';

/** An ordinary dated row: priority and date on screen at both widths. */
const SMALL_SCREEN_TITLE = 'Small screen';

/** A second ordinary row, so the narrow layout has more than one row's worth of content to hold. */
const ALSO_SMALL_TITLE = 'Also small';

/** A third ordinary row, undated and at the default priority. */
const THIRD_ROW_TITLE = 'Third row';

/** The row carrying a long description: a second, softer shape of long content on a row. */
const LONG_DESCRIPTION_TITLE = 'Long description';

/** Long enough to wrap across most of the narrow viewport's rows. */
const LONG_DESCRIPTION =
  'A description long enough to fill several lines at every width the product supports, written as ordinary prose so that the wrapping of a long value is what this row exercises.';

/** How many fixtures `seedPopulatedList` creates, which is the populated list's row count. */
const SEEDED_TASK_COUNT = 5;

/** The row every action in the narrow-width test is exercised on. */
const ACTION_TASK_TITLE = 'Narrow screen';

/** The title typed into the create form at 320px. */
const CREATED_AT_NARROW_TITLE = 'Created at 320';

/** The title typed into the create form at 1280px. */
const CREATED_AT_WIDE_TITLE = 'Created at 1280';

/**
 * Asserts the document is no wider than the viewport, which is what "no horizontal scrolling"
 * means: `scrollWidth` counts the content that overflows, `clientWidth` the width available to it.
 * The body is measured as well as the document element, because an overflowing row widens the body
 * before it widens the page's scrollable area.
 */
async function assertNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    documentOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    bodyOverflows: document.body.scrollWidth > document.documentElement.clientWidth,
  }));

  expect(overflow.documentOverflows, 'the document must not be wider than the viewport').toBe(
    false,
  );
  expect(overflow.bodyOverflows, 'the body must not be wider than the viewport').toBe(false);
}

/** The one list item whose text contains `title`. */
function item(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

/**
 * The create form, located without reference to its submit control's wording: the form inside the
 * screen's `Add a task` region that owns the Title control.
 *
 * Both parts are load-bearing. The region keeps the create form apart from the in-place edit form
 * of a task — whose Title control is named the same — so the locator resolves to one element
 * whichever rows are being edited, and the Title filter is what identifies the form as the create
 * one rather than relying on the label of the button this spec then presses.
 */
function createForm(page: Page): Locator {
  return page
    .getByRole('region', { name: 'Add a task' })
    .locator('form')
    .filter({ has: page.getByLabel(/title/i) });
}

/** The create form's own submit control, found structurally so its wording is never asserted. */
function createSubmit(page: Page): Locator {
  return createForm(page).locator('button[type="submit"]');
}

/** The completion checkbox of the row whose title is `title`, whose accessible name carries it. */
function checkboxOf(page: Page, title: string): Locator {
  // The title is a plain phrase here, so it is safe to match case-insensitively as a pattern; the
  // label reads `Complete “<title>”` or `Reopen “<title>”` depending on the task's own state, and
  // both are matched by the title alone.
  return item(page, title).getByRole('checkbox', { name: new RegExp(title, 'i') });
}

/**
 * The filter and sort bar's three controls.
 *
 * Each is identified by an option text only it offers, because the create form has a `Priority`
 * control that is labelled exactly like the filter bar's own — scoping to the bar's region and
 * matching the option vocabulary is what tells the two apart without depending on either label.
 */
function filterSelect(page: Page, optionText: string): Locator {
  return page.getByRole('region', { name: 'Filter and sort' }).locator('select').filter({
    hasText: optionText,
  });
}

/**
 * Seeds the list both widths are measured against: three ordinary rows, one title at the
 * 200-character bound with no space in it, and one long description.
 *
 * Everything here is created through the API, because a fixture is not what this spec is proving;
 * every action it does assert on is performed through the interface instead.
 */
async function seedPopulatedList(request: APIRequestContext): Promise<void> {
  await createTask(request, {
    title: SMALL_SCREEN_TITLE,
    priority: 'medium',
    dueDate: FUTURE_DUE_DATE,
  });
  await createTask(request, { title: ALSO_SMALL_TITLE, priority: 'low' });
  await createTask(request, { title: THIRD_ROW_TITLE });
  await createTask(request, { title: LONG_TITLE });
  await createTask(request, { title: LONG_DESCRIPTION_TITLE, description: LONG_DESCRIPTION });
}

test.describe('at 320px', () => {
  test.use({ viewport: NARROW_VIEWPORT });

  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('needs no horizontal scrolling, even with a maximum-length title', async ({
    page,
    request,
  }) => {
    await seedPopulatedList(request);

    await page.goto('/');

    // Populated rather than empty: the measurement below must run against rows and not against the
    // empty state's copy, which is what a page that passes while empty would be measuring.
    await expect(item(page, SMALL_SCREEN_TITLE)).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveCount(SEEDED_TASK_COUNT);
    await assertNoHorizontalScroll(page);

    // The hazard asserted on screen before the width is measured again, so the second measurement
    // cannot pass by running against a page the long title never reached.
    await expect(item(page, LONG_TITLE)).toBeVisible();
    await assertNoHorizontalScroll(page);
  });

  test('keeps the create, complete, edit and delete actions visible and operable', async ({
    page,
    request,
  }) => {
    await createTask(request, { title: ACTION_TASK_TITLE, priority: 'medium' });

    await page.goto('/');

    const target = item(page, ACTION_TASK_TITLE);
    await expect(target).toBeVisible();

    // Create: the form's own submit control, whose wording is deliberately not asserted.
    const submit = createSubmit(page);
    await expect(submit).toBeVisible();
    await expect(submit).toBeEnabled();
    await createForm(page).getByLabel(/title/i).fill(CREATED_AT_NARROW_TITLE);
    await submit.click();
    await expect(item(page, CREATED_AT_NARROW_TITLE)).toBeVisible();

    // Complete: the checkbox on the row, then the same control operated from the keyboard, which is
    // what makes the action keyboard-operable rather than merely clickable.
    const checkbox = checkboxOf(page, ACTION_TASK_TITLE);
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toBeEnabled();
    await checkbox.click();
    await expect(checkbox).toBeChecked();

    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).not.toBeChecked();

    // Edit: in place, from the control on the row, and abandonable without changing anything.
    const edit = target.getByRole('button', { name: 'Edit' });
    await expect(edit).toBeVisible();
    await edit.click();

    const editForm = page.getByRole('form', { name: `Edit task: ${ACTION_TASK_TITLE}` });
    const save = editForm.getByRole('button', { name: 'Save' });
    const cancelEdit = editForm.getByRole('button', { name: 'Cancel' });
    await expect(editForm).toBeVisible();
    await expect(save).toBeVisible();
    await expect(cancelEdit).toBeVisible();

    await cancelEdit.click();

    // Cancelled: the row is back in its read form and unchanged — cancelling sends nothing, so the
    // store still holds both rows with the completion state the keyboard toggle left behind.
    await expect(editForm).toHaveCount(0);
    await expect(target.getByRole('heading', { level: 3, name: ACTION_TASK_TITLE })).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    const storedTitles = (await listTasks(request)).map((task) => task.title);
    expect(storedTitles).toContain(ACTION_TASK_TITLE);
    expect(storedTitles).toContain(CREATED_AT_NARROW_TITLE);

    // Delete: reachable at this width, and the confirmation stands between it and the request.
    const remove = target.getByRole('button', { name: 'Delete' });
    await expect(remove).toBeVisible();
    await remove.click();

    const dialog = page.getByRole('dialog', { name: 'Delete task' });
    const dismiss = dialog.getByRole('button', { name: 'Cancel' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(dismiss).toBeVisible();

    await dismiss.click();

    // Dismissed, with nothing deleted: the row is still listed and the store still holds both rows.
    await expect(dialog).toBeHidden();
    await expect(target).toBeVisible();
    expect(await listTasks(request)).toHaveLength(2);

    // The filter and sort controls are visible, enabled and operable at this width, and each change
    // reaches the screen: both rows this test leaves behind are open, so filtering to the completed
    // ones empties the list and the default filter brings them back.
    const statusSelect = filterSelect(page, 'Completed');
    const prioritySelect = filterSelect(page, 'All priorities');
    const sortSelect = filterSelect(page, 'Creation time');

    for (const control of [statusSelect, prioritySelect, sortSelect]) {
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
    }

    await statusSelect.selectOption({ label: 'Open' });
    await expect(item(page, ACTION_TASK_TITLE)).toBeVisible();

    await statusSelect.selectOption({ label: 'Completed' });
    await expect(page.getByRole('listitem')).toHaveCount(0);

    await statusSelect.selectOption({ label: 'All' });
    await expect(item(page, ACTION_TASK_TITLE)).toBeVisible();

    // Nothing to scroll sideways, after every interaction above has run at this width.
    await assertNoHorizontalScroll(page);
  });
});

test.describe('at 1280px', () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('needs no horizontal scrolling and keeps the same actions reachable', async ({
    page,
    request,
  }) => {
    await seedPopulatedList(request);

    await page.goto('/');

    await expect(item(page, SMALL_SCREEN_TITLE)).toBeVisible();
    await expect(item(page, LONG_TITLE)).toBeVisible();
    await assertNoHorizontalScroll(page);

    // The same four actions, at the wide width: nothing that works at 320px may have regressed
    // here. The wide case stays light — the criterion is the width itself plus the same controls.
    const target = item(page, SMALL_SCREEN_TITLE);

    const submit = createSubmit(page);
    await expect(submit).toBeVisible();
    await createForm(page).getByLabel(/title/i).fill(CREATED_AT_WIDE_TITLE);
    await submit.click();
    await expect(item(page, CREATED_AT_WIDE_TITLE)).toBeVisible();

    const edit = target.getByRole('button', { name: 'Edit' });
    await expect(edit).toBeVisible();
    await edit.click();

    const editForm = page.getByRole('form', { name: `Edit task: ${SMALL_SCREEN_TITLE}` });
    await expect(editForm).toBeVisible();
    await editForm.getByRole('button', { name: 'Cancel' }).click();
    await expect(editForm).toHaveCount(0);

    const remove = target.getByRole('button', { name: 'Delete' });
    await expect(remove).toBeVisible();
    await remove.click();

    const dialog = page.getByRole('dialog', { name: 'Delete task' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(target).toBeVisible();

    const checkbox = checkboxOf(page, SMALL_SCREEN_TITLE);
    await expect(checkbox).toBeVisible();
    await checkbox.click();
    await expect(checkbox).toBeChecked();

    await assertNoHorizontalScroll(page);
  });
});
