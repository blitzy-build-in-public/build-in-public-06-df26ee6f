/**
 * End-to-end coverage for creating and editing a task — AAP acceptance criteria 1, 2 and 7.
 *
 * What it proves in the running product, through the controls a person uses rather than through
 * test ids: a task created from a title alone is listed as open, `medium` priority and undated;
 * each of the four fields is edited through the in-place form and the list and a following
 * `GET /api/tasks/:id` agree; and an empty title, a 201-character title and an invalid due date are
 * refused, with the server's message beside the field and the typed input kept.
 *
 * The store is shared with every other spec — one SQLite file, one worker — so each test clears it
 * through `e2e/support/api.ts` before it asserts, and every path stays relative so it resolves
 * against `use.baseURL` (the Vite origin) and travels the `/api` proxy.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  clearAllTasks,
  createTask,
  getTaskResponse,
  isApiErrorBody,
  listTasks,
  type ApiErrorBody,
  type TaskDto,
} from './support/api';

/** The list route, relative so the request travels the Vite `/api` proxy to the API process. */
const TASKS_PATH = '/api/tasks';

/** A due date comfortably in the future, so the task this spec edits is never overdue. */
const FUTURE_DUE_DATE = '2030-06-15';

/** A title one character over the 200-character bound the domain rule sets. */
const OVER_LONG_TITLE = 'x'.repeat(201);

/** The messages the domain owns and this spec asserts verbatim. */
const TITLE_REQUIRED_MESSAGE = 'Title is required';
const TITLE_TOO_LONG_MESSAGE = 'Title must be 200 characters or fewer';
const DUE_DATE_FORMAT_MESSAGE = 'Due date must be a date in YYYY-MM-DD format';
const DUE_DATE_CALENDAR_MESSAGE = 'Due date must be a valid calendar date';

/**
 * The form's own sentence for a save that carried no usable detail — a server failure or an
 * unreachable API. The refused-date case asserts its absence, which is what tells that rejection's
 * own message apart from the fallback.
 */
const SAVE_FAILED_MESSAGE = 'Could not save the task. The server may be unreachable.';

/** The empty-list message, which is what proves a refused create created nothing. */
const EMPTY_LIST_MESSAGE = 'No tasks yet. Add your first task using the form above.';

/**
 * The invalid date the form can actually carry to the server.
 *
 * The create form's due-date control is a native date input, and Chromium sanitises a non-calendar
 * date such as `2030-02-30` to an empty value instead of holding it, so the only refused date a
 * user can get into that control is one whose year is longer than the four digits the contract's
 * `YYYY-MM-DD` shape allows. This value is such a date, the control accepts and keeps it, and the
 * server answers 400 for it with the message this spec asserts beside the field.
 */
const REJECTED_DUE_DATE = '275760-09-13';

/** The create form's section; scoping to it keeps its `Priority` apart from the filter bar's. */
function createForm(page: Page): Locator {
  return page.getByRole('region', { name: 'Add a task' });
}

/** The one list item whose text contains `title`. */
function item(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

/** The single task a listing holds, or a failure — a listing that is not singular is the assertion's. */
function onlyTask(tasks: readonly TaskDto[]): TaskDto {
  const [task] = tasks;
  if (task === undefined) {
    throw new Error(`Expected the store to hold one task, but the listing held ${tasks.length}.`);
  }
  return task;
}

/** Reads an error envelope out of a raw response body, which keeps `any` out of this file. */
function parseErrorBody(text: string): ApiErrorBody {
  return JSON.parse(text) as ApiErrorBody;
}

/**
 * Posts one create body and returns the 400 envelope the contract requires for it.
 *
 * Nothing is asserted about the store here: the caller checks that the refused body created
 * nothing, so one helper cannot hide a second failure behind the first.
 */
async function postRefusedBody(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<ApiErrorBody> {
  const response = await request.post(TASKS_PATH, { data: body });
  const text = await response.text();
  expect(response.status(), `POST ${TASKS_PATH} with ${JSON.stringify(body)}: ${text}`).toBe(400);
  return parseErrorBody(text);
}

test.describe('create and edit', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllTasks(request);
  });

  test('creates a task from a title alone and lists it open, medium and undated', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    // The store was cleared before this test, so the account holds nothing yet and the list says so.
    await expect(page.getByText(EMPTY_LIST_MESSAGE)).toBeVisible();

    const form = createForm(page);
    await form.getByLabel('Title').fill('Buy milk');
    await form.getByRole('button', { name: 'Add task' }).click();

    const created = item(page, 'Buy milk');
    await expect(created.getByRole('heading', { level: 3, name: 'Buy milk' })).toBeVisible();
    await expect(created).toContainText('Medium');
    // No due date is rendered at all: the item omits the region rather than showing a placeholder.
    await expect(created.locator('time')).toHaveCount(0);
    // An undated task can never be overdue, so the marker is absent together with the date.
    await expect(created.getByText(/overdue/i)).toHaveCount(0);
    await expect(created.getByRole('checkbox')).not.toBeChecked();

    // The screen shows what the server committed, so the open filter returns that same one task.
    const listed = await listTasks(request, { status: 'open' });
    expect(listed).toHaveLength(1);
    const stored = onlyTask(listed);
    expect(stored.title).toBe('Buy milk');
    expect(stored.description).toBe('');
    expect(stored.priority).toBe('medium');
    expect(stored.dueDate).toBeNull();
    expect(stored.completed).toBe(false);
  });

  test('edits every field through the form and the list and a following GET agree', async ({
    page,
    request,
  }) => {
    // The task is created through the interface rather than seeded through the API, so this test
    // covers the whole path: the create form's submit, the item it produces, the in-place edit and
    // the read that follows the edit.
    await page.goto('/');
    const create = createForm(page);
    await create.getByLabel('Title').fill('Buy milk');
    await create.getByRole('button', { name: 'Add task' }).click();
    await expect(item(page, 'Buy milk')).toBeVisible();

    // The identifier the edit will address comes from the server, not from the screen.
    const seeded = onlyTask(await listTasks(request));
    expect(seeded.title).toBe('Buy milk');

    const beforeEdit = item(page, 'Buy milk');
    await beforeEdit.getByRole('button', { name: 'Edit' }).click();

    // The edit form replaces the item in place, is named after the task it is editing, opens
    // holding what the server holds, and keeps Save disabled until a field differs — so the form
    // can never send the empty patch the API refuses.
    const form = page.getByRole('form', { name: 'Edit task: Buy milk' });
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Title')).toHaveValue('Buy milk');
    await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();

    await form.getByLabel('Title').fill('Buy oat milk');
    await form.getByLabel('Description').fill('Two litres, unsweetened');
    await form.getByLabel('Priority').selectOption('high');
    await form.getByLabel('Due date').fill(FUTURE_DUE_DATE);
    await expect(form.getByRole('button', { name: 'Save' })).toBeEnabled();
    await form.getByRole('button', { name: 'Save' }).click();

    // Saving leaves edit mode, and the item reads as the edited task.
    const afterEdit = item(page, 'Buy oat milk');
    await expect(afterEdit.getByRole('heading', { level: 3, name: 'Buy oat milk' })).toBeVisible();
    await expect(afterEdit).toContainText('High');
    await expect(afterEdit.locator('time')).toHaveText(FUTURE_DUE_DATE);
    await expect(afterEdit).toContainText('Two litres, unsweetened');
    // `2030` is far enough ahead that the edited task can never be flagged overdue.
    await expect(afterEdit.getByText(/overdue/i)).toHaveCount(0);
    await expect(afterEdit.getByRole('checkbox')).not.toBeChecked();
    await expect(page.getByRole('listitem')).toHaveCount(1);

    // A following GET returns the same four edited fields, so the on-screen list is not the only
    // witness to the edit. The two timestamps are deliberately not asserted here: the clock half of
    // this criterion is proved in the unit layer against a fixed clock, so the browser layer never
    // reads the wall clock and the suite cannot go flaky on a slow machine.
    const read = await getTaskResponse(request, seeded.id);
    expect(read.status).toBe(200);
    const stored = read.body;
    if (isApiErrorBody(stored)) {
      throw new Error(`Expected task ${seeded.id} to be readable, received ${stored.error.code}.`);
    }
    expect(stored.title).toBe('Buy oat milk');
    expect(stored.description).toBe('Two litres, unsweetened');
    expect(stored.priority).toBe('high');
    expect(stored.dueDate).toBe(FUTURE_DUE_DATE);
    expect(stored.completed).toBe(false);
  });

  /**
   * The title values the form refuses, each with the message it shows beside the control. The
   * whitespace-only value is the trimming rule's own case: the form trims before it measures, so
   * three spaces are an empty title — while the value the user typed stays in the control and in
   * the form's own state.
   *
   * The form's client-side pre-check may stop the request before it is sent; the outcome asserted
   * for each of these values — the message beside the field, the field marked invalid, the typed
   * value kept and no task created — is identical either way, and the server's own 400 path for the
   * same values is proved by the bodies sent straight to the API further down this file.
   */
  const refusedTitles: readonly {
    readonly label: string;
    readonly title: string;
    readonly message: string;
  }[] = [
    { label: 'an empty title', title: '', message: TITLE_REQUIRED_MESSAGE },
    { label: 'a whitespace-only title', title: '   ', message: TITLE_REQUIRED_MESSAGE },
    { label: 'a 201-character title', title: OVER_LONG_TITLE, message: TITLE_TOO_LONG_MESSAGE },
  ];

  for (const refused of refusedTitles) {
    test(`refuses ${refused.label} beside the field and keeps what was typed`, async ({
      page,
      request,
    }) => {
      await page.goto('/');

      const form = createForm(page);
      const title = form.getByLabel('Title');
      await title.fill(refused.title);
      await form.getByRole('button', { name: 'Add task' }).click();

      await expect(form.getByText(refused.message)).toBeVisible();
      await expect(title).toHaveAttribute('aria-invalid', 'true');
      await expect(title).toHaveValue(refused.title);
      // Nothing was created, so the empty state still invites a first task.
      await expect(page.getByRole('listitem')).toHaveCount(0);
      await expect(page.getByText(EMPTY_LIST_MESSAGE)).toBeVisible();
      expect(await listTasks(request)).toHaveLength(0);
    });
  }

  /**
   * The bodies the API itself must refuse, each with the field and message the contract names.
   * A create and a patch share these rules, so the create route is where each one is proved.
   */
  const refusedBodies: readonly {
    readonly label: string;
    readonly body: Record<string, unknown>;
    readonly field: string;
    readonly message: string;
  }[] = [
    { label: 'an empty title', body: { title: '' }, field: 'title', message: TITLE_REQUIRED_MESSAGE },
    {
      label: 'a whitespace-only title',
      body: { title: '   ' },
      field: 'title',
      message: TITLE_REQUIRED_MESSAGE,
    },
    {
      label: 'a 201-character title',
      body: { title: OVER_LONG_TITLE },
      field: 'title',
      message: TITLE_TOO_LONG_MESSAGE,
    },
    {
      label: 'a due date in the wrong format',
      body: { title: 'Pay the rent', dueDate: '2030/06/15' },
      field: 'dueDate',
      message: DUE_DATE_FORMAT_MESSAGE,
    },
    {
      label: 'a due date that is not a calendar date',
      body: { title: 'Pay the rent', dueDate: '2030-02-30' },
      field: 'dueDate',
      message: DUE_DATE_CALENDAR_MESSAGE,
    },
  ];

  for (const refused of refusedBodies) {
    test(`the server rejects ${refused.label}, naming the field, and creates nothing`, async ({
      request,
    }) => {
      const error = await postRefusedBody(request, refused.body);
      expect(error.error.code).toBe('VALIDATION_ERROR');
      expect(error.error.fields).toEqual({ [refused.field]: refused.message });
      expect(await listTasks(request)).toHaveLength(0);
    });
  }

  test('reports every refused field of one body at once and creates nothing', async ({ request }) => {
    // Two rules fail on the same body — an empty title and a date that matches the digit shape but
    // is not a day February has. The envelope maps one message per offending field, keyed by exactly
    // the form's field names, so a client can place a message beside each of the two controls and
    // the refused body leaves no row behind.
    const error = await postRefusedBody(request, { title: '', dueDate: '2026-02-30' });

    expect(error.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(error.error.fields).sort()).toEqual(['dueDate', 'title']);
    expect(error.error.fields['title']).toBe(TITLE_REQUIRED_MESSAGE);
    expect(error.error.fields['dueDate']).toBe(DUE_DATE_CALENDAR_MESSAGE);
    expect(await listTasks(request)).toHaveLength(0);
  });

  test('shows the refused due date beside the field and keeps what was typed', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    const form = createForm(page);
    const title = form.getByLabel('Title');
    const dueDate = form.getByLabel('Due date');
    await title.fill('Pay the rent');
    await dueDate.fill(REJECTED_DUE_DATE);
    await form.getByRole('button', { name: 'Add task' }).click();

    // The message the server returned for `dueDate` is shown beside that control, which is marked
    // invalid and linked to it. The input is preserved, the focus stays where the user left it and
    // the form stays open and submittable, so a correction can be retried at once. It is the
    // server's message and not the generic one, which is what proves the field map reached the form.
    await expect(form.getByText(DUE_DATE_FORMAT_MESSAGE)).toBeVisible();
    await expect(dueDate).toHaveAttribute('aria-invalid', 'true');
    await expect(dueDate).toHaveAccessibleDescription(DUE_DATE_FORMAT_MESSAGE);
    await expect(title).toHaveValue('Pay the rent');
    await expect(dueDate).toHaveValue(REJECTED_DUE_DATE);
    await expect(form.getByText(SAVE_FAILED_MESSAGE)).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Add task' })).toBeEnabled();
    await expect(form.getByRole('button', { name: 'Add task' })).toBeFocused();
    await expect(page.getByRole('listitem')).toHaveCount(0);
    await expect(page.getByText(EMPTY_LIST_MESSAGE)).toBeVisible();

    // The same body is refused for the same reason when it reaches the server on its own.
    const error = await postRefusedBody(request, {
      title: 'Pay the rent',
      dueDate: REJECTED_DUE_DATE,
    });
    expect(error.error.fields).toEqual({ dueDate: DUE_DATE_FORMAT_MESSAGE });
    expect(await listTasks(request)).toHaveLength(0);
  });

  test('shows the refused due date beside the field when a save is refused', async ({
    page,
    request,
  }) => {
    const seeded = await createTask(request, { title: 'Pay the rent' });

    await page.goto('/');
    await item(page, 'Pay the rent').getByRole('button', { name: 'Edit' }).click();

    // The edit form is the same component as the create form, but the request it sends goes through
    // a different handler, so its refusal is asserted on its own.
    const form = page.getByRole('form', { name: 'Edit task: Pay the rent' });
    const dueDate = form.getByLabel('Due date');
    await dueDate.fill(REJECTED_DUE_DATE);
    await form.getByRole('button', { name: 'Save' }).click();

    // The refused save leaves the form open in place, with the server's message beside the control
    // it names and the typed value still in that control.
    await expect(form.getByText(DUE_DATE_FORMAT_MESSAGE)).toBeVisible();
    await expect(dueDate).toHaveAttribute('aria-invalid', 'true');
    await expect(dueDate).toHaveAccessibleDescription(DUE_DATE_FORMAT_MESSAGE);
    await expect(dueDate).toHaveValue(REJECTED_DUE_DATE);
    await expect(form).toBeVisible();
    await expect(form.getByText(SAVE_FAILED_MESSAGE)).toHaveCount(0);

    // Nothing was changed: the task still reads as the server holds it.
    const read = await getTaskResponse(request, seeded.id);
    expect(read.status).toBe(200);
    const stored = read.body;
    if (isApiErrorBody(stored)) {
      throw new Error(`Expected task ${seeded.id} to be readable, received ${stored.error.code}.`);
    }
    expect(stored.title).toBe('Pay the rent');
    expect(stored.dueDate).toBeNull();
  });
});
