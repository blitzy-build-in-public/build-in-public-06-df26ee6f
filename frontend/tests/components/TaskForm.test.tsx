/**
 * Component suite for the task form, `TaskForm` in `src/components/TaskForm.tsx`.
 *
 * One component serves both jobs the product needs — creating a task and editing one — so the suite
 * covers both modes: the create form's defaults and the three checks it makes before a request is
 * sent, the way a rejected save is displayed, the in-flight state that stops a double submit, and the
 * edit form's prefill, its dirty check, its partial patch and its Cancel.
 *
 * Every assertion goes through a query a user could perform: a control by its label, a message by its
 * text, and the association between the two through `aria-invalid` and `aria-describedby`. No case
 * reads a class name, a test id, a snapshot or a query selector, and none of them reaches the network
 * — a save is a `vi.fn()` the case arms, and every rejection is the real `ApiError` the client raises,
 * built by `makeApiError` in the shared test support.
 *
 * The promise this suite keeps re-checking is the one the form makes to the user: a rejected save
 * never clears what was typed. Each rejection case asserts the typed value survives and that the form
 * stays open, so a regression that resets the fields fails here rather than in a browser.
 *
 * This project has no user rules to cite — `review_rules` reports none — so what governs the file is
 * the request's own contract: the four fields, the exact validation messages of AAP 0.5.5, the states
 * of AAP 0.6.2 and the accessible structure of AAP 0.6.5.
 */

import { act, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import type { CreateTaskInput, Task, UpdateTaskInput } from '../../src/api/types';
import { TaskForm } from '../../src/components/TaskForm';
import { makeApiError, makeTask, renderUi, screen, within } from '../support/helpers';

/**
 * The payload a save hands the form — a create body, or a patch carrying only the fields that
 * changed — and the outcome the form reads from it.
 */
type SubmitHandler = (input: CreateTaskInput | UpdateTaskInput) => Promise<boolean>;

/** The label of a create form's submit control. */
const CREATE_LABEL = 'Add task';

/** The label of an edit form's submit control. */
const EDIT_LABEL = 'Save';

/** The title the edit-mode cases start from. */
const EDIT_TASK_TITLE = 'Buy milk';

/** The title an edit-mode case types over it, which is the only field that then differs. */
const EDITED_TITLE = 'Buy oat milk';

/**
 * The task every edit-mode case prefills the form from: all four editable fields set to a known
 * value, so a patch assertion can name exactly the field that changed.
 */
const EDIT_TASK: Task = makeTask({
  title: EDIT_TASK_TITLE,
  description: 'Semi-skimmed',
  priority: 'high',
  dueDate: '2026-02-14',
});

/** A title of exactly the length the title field allows, which the boundary case must not refuse. */
const TITLE_AT_MAX = 'a'.repeat(200);

/**
 * A promise the case settles by hand, so a pending save can be observed while it lasts.
 *
 * `resolve` starts as a no-op that the promise executor replaces before `createDeferred` returns,
 * which is what keeps the resolver callable without a non-null assertion.
 */
interface Deferred {
  /** Settles when the case decides the save has finished. */
  promise: Promise<boolean>;
  /** Reports the save's outcome to the waiting form. */
  resolve(succeeded: boolean): void;
}

/** Builds a {@link Deferred}, whose promise the caller resolves at the moment it chooses. */
function createDeferred(): Deferred {
  let settle: (succeeded: boolean) => void = () => {};

  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  return {
    promise,
    resolve: (succeeded) => {
      settle(succeeded);
    },
  };
}

/** A submit handler as a mock, which is what every case hands the form as `onSubmit`. */
function submitMock() {
  return vi.fn<SubmitHandler>();
}

/** A submit handler armed to report a successful save. */
function succeedingSubmit() {
  return vi.fn<SubmitHandler>().mockResolvedValue(true);
}

/** An `onCancel` as a mock. */
function cancelMock() {
  return vi.fn<() => void>();
}

/** Renders the create form — no `initialTask`, so no Cancel control — over a submit handler. */
function renderCreateForm(onSubmit: SubmitHandler) {
  return renderUi(<TaskForm onSubmit={onSubmit} submitLabel={CREATE_LABEL} />);
}

/** Renders the in-place edit form for {@link EDIT_TASK}, with an optional Cancel handler. */
function renderEditForm(onSubmit: SubmitHandler, onCancel?: () => void) {
  return renderUi(
    <TaskForm
      initialTask={EDIT_TASK}
      onSubmit={onSubmit}
      onCancel={onCancel}
      submitLabel={EDIT_LABEL}
    />,
  );
}

describe('TaskForm — fields and create-mode defaults', () => {
  it('reaches every field through its label and reads the due date as a date rather than a text box', () => {
    renderCreateForm(submitMock());

    expect(screen.getByRole('textbox', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Priority' })).toBeInTheDocument();

    const dueDate = screen.getByLabelText('Due date');

    expect(dueDate).toHaveAttribute('type', 'date');
    // A native date input exposes no `textbox` role, so its label is the only handle on it.
    expect(screen.queryByRole('textbox', { name: 'Due date' })).not.toBeInTheDocument();
  });

  it('starts empty with medium priority, the three labelled levels and no Cancel control', () => {
    renderCreateForm(submitMock());

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
    expect(screen.getByLabelText('Due date')).toHaveValue('');

    const priority = screen.getByRole('combobox', { name: 'Priority' });

    expect(priority).toHaveValue('medium');
    expect(within(priority).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Low',
      'Medium',
      'High',
    ]);

    // A create form has nothing to go back to, so it offers no Cancel, and nothing is in flight.
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: CREATE_LABEL })).toBeEnabled();
  });
});

describe('TaskForm — checks made before a request is sent', () => {
  it('refuses a whitespace-only title itself, links the message to the field and keeps the input', async () => {
    const user = userEvent.setup();
    const onSubmit = succeedingSubmit();
    renderCreateForm(onSubmit);

    const title = screen.getByRole('textbox', { name: 'Title' });

    await user.type(title, '   ');
    await user.click(screen.getByRole('button', { name: CREATE_LABEL }));

    // The form trims before it decides, so a whitespace-only title is empty and the request is
    // refused here rather than sent: nothing is created.
    expect(onSubmit).not.toHaveBeenCalled();

    const message = await screen.findByText('Title is required');

    expect(title).toHaveValue('   ');
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title).toHaveAccessibleDescription('Title is required');
    expect(title.getAttribute('aria-describedby')).toBe(message.id);

    // The message describes the value that was just refused, so correcting the field clears it.
    await user.type(title, 'Milk');

    expect(screen.queryByText('Title is required')).not.toBeInTheDocument();
    expect(title).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('accepts a title of exactly the 200 characters the field allows', async () => {
    const user = userEvent.setup();
    const onSubmit = succeedingSubmit();
    renderCreateForm(onSubmit);

    const title = screen.getByRole('textbox', { name: 'Title' });

    await user.click(title);
    await user.paste(TITLE_AT_MAX);
    await user.click(screen.getByRole('button', { name: CREATE_LABEL }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Title must be 200 characters or fewer')).not.toBeInTheDocument();
  });

  it.each([
    { label: 'Title', text: 'a'.repeat(201), message: 'Title must be 200 characters or fewer' },
    {
      label: 'Description',
      text: 'a'.repeat(2001),
      message: 'Description must be 2000 characters or fewer',
    },
  ])(
    'refuses a $label over its length bound without sending a request and links the message to the field',
    async ({ label, text, message }) => {
      const user = userEvent.setup();
      const onSubmit = succeedingSubmit();
      renderCreateForm(onSubmit);

      if (label === 'Description') {
        // A valid title, so the case fails on the description alone.
        await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Buy milk');
      }

      const control = screen.getByLabelText(label);

      await user.click(control);
      await user.paste(text);
      await user.click(screen.getByRole('button', { name: CREATE_LABEL }));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(control).toHaveAttribute('aria-invalid', 'true');
      expect(control).toHaveAccessibleDescription(message);
      expect(control).toHaveValue(text);
    },
  );
});

describe('TaskForm — a save the server rejected', () => {
  it('shows each message beside the control the server named and keeps what was typed', async () => {
    const user = userEvent.setup();
    const onSubmit = submitMock().mockRejectedValue(
      makeApiError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        fields: {
          title: 'Title is required',
          dueDate: 'Due date must be a date in YYYY-MM-DD format',
        },
      }),
    );
    renderCreateForm(onSubmit);

    const title = screen.getByRole('textbox', { name: 'Title' });
    const description = screen.getByRole('textbox', { name: 'Description' });
    const dueDate = screen.getByLabelText('Due date');
    const submit = screen.getByRole('button', { name: CREATE_LABEL });

    await user.type(title, 'Buy milk');
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      title: 'Buy milk',
      description: '',
      priority: 'medium',
      dueDate: null,
    });

    const titleMessage = await screen.findByText('Title is required');

    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title).toHaveAccessibleDescription('Title is required');
    expect(title.getAttribute('aria-describedby')).toBe(titleMessage.id);
    // What the user typed survives the rejection, so a retry needs no retyping.
    expect(title).toHaveValue('Buy milk');

    const dueDateMessage = screen.getByText('Due date must be a date in YYYY-MM-DD format');

    expect(dueDate).toHaveAttribute('aria-invalid', 'true');
    expect(dueDate).toHaveAccessibleDescription('Due date must be a date in YYYY-MM-DD format');
    expect(dueDate.getAttribute('aria-describedby')).toBe(dueDateMessage.id);

    // A control the server did not name is not marked invalid, and the form stays open for a retry.
    expect(description).not.toHaveAttribute('aria-invalid', 'true');
    expect(submit).toBeEnabled();
  });

  it('shows the server message above the fields and marks no control invalid when it named none', async () => {
    const user = userEvent.setup();
    const onSubmit = submitMock().mockRejectedValue(
      makeApiError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'At least one field must be supplied',
        fields: {},
      }),
    );
    renderCreateForm(onSubmit);

    const title = screen.getByRole('textbox', { name: 'Title' });
    const submit = screen.getByRole('button', { name: CREATE_LABEL });

    await user.type(title, 'Buy milk');
    await user.click(submit);

    const message = await screen.findByRole('alert');

    expect(message).toHaveTextContent('At least one field must be supplied');
    // A form-level message describes the attempt as a whole, so it belongs above the fields.
    expect(message.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    // The server named no field, so none is marked invalid: the message is all the user is told.
    expect(title).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox', { name: 'Description' })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByRole('combobox', { name: 'Priority' })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('Due date')).not.toHaveAttribute('aria-invalid', 'true');

    expect(title).toHaveValue('Buy milk');
    expect(submit).toBeEnabled();

    // The rejection is announced, not focused: the user's place on the page is preserved.
    expect(message).not.toHaveFocus();
    expect(document.activeElement).not.toBe(message);
  });

  it.each([
    {
      label: 'a server failure',
      failure: makeApiError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        fields: {},
      }),
    },
    {
      label: 'a server that could not be reached',
      failure: makeApiError({ status: 0, code: 'INTERNAL_ERROR' }),
    },
  ])(
    'reports that the task could not be saved for $label, keeping the input and marking no control invalid',
    async ({ failure }) => {
      const user = userEvent.setup();
      const onSubmit = submitMock().mockRejectedValue(failure);
      renderCreateForm(onSubmit);

      const title = screen.getByRole('textbox', { name: 'Title' });
      const submit = screen.getByRole('button', { name: CREATE_LABEL });

      await user.type(title, 'Buy milk');
      await user.click(submit);

      expect(
        await screen.findByText('Could not save the task. The server may be unreachable.'),
      ).toBeInTheDocument();
      expect(title).toHaveValue('Buy milk');
      expect(title).not.toHaveAttribute('aria-invalid', 'true');
      expect(submit).toBeEnabled();
    },
  );

  it('reports that the task could not be saved when the save itself reports failure, keeping the input', async () => {
    const user = userEvent.setup();
    renderCreateForm(submitMock().mockResolvedValue(false));

    const title = screen.getByRole('textbox', { name: 'Title' });
    const submit = screen.getByRole('button', { name: CREATE_LABEL });

    await user.type(title, 'Buy milk');
    await user.click(submit);

    expect(
      await screen.findByText('Could not save the task. The server may be unreachable.'),
    ).toBeInTheDocument();
    expect(title).toHaveValue('Buy milk');
    expect(submit).toBeEnabled();
  });

  it('keeps each message with its own field when the user corrects one of them', async () => {
    const user = userEvent.setup();
    const onSubmit = submitMock().mockRejectedValue(
      makeApiError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        fields: {
          title: 'Title is required',
          dueDate: 'Due date must be a date in YYYY-MM-DD format',
        },
      }),
    );
    renderCreateForm(onSubmit);

    const title = screen.getByRole('textbox', { name: 'Title' });
    const dueDate = screen.getByLabelText('Due date');

    await user.type(title, 'Buy milk');
    await user.click(screen.getByRole('button', { name: CREATE_LABEL }));
    await screen.findByText('Title is required');

    // Editing a field drops the message that described its previous value — and only that one.
    await user.type(title, ' and bread');

    expect(screen.queryByText('Title is required')).not.toBeInTheDocument();
    expect(title).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Due date must be a date in YYYY-MM-DD format')).toBeInTheDocument();
    expect(dueDate).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('TaskForm — the submit lifecycle', () => {
  it('sends every create field and never completed', async () => {
    const user = userEvent.setup();
    let submitted: CreateTaskInput | UpdateTaskInput | null = null;
    const onSubmit = submitMock().mockImplementation((input) => {
      submitted = input;
      return Promise.resolve(true);
    });
    renderCreateForm(onSubmit);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Buy milk');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'high');
    await user.click(screen.getByRole('button', { name: CREATE_LABEL }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submitted).toEqual({
      title: 'Buy milk',
      description: '',
      priority: 'high',
      dueDate: null,
    });

    // The read-only and completion fields are never sendable: a new task is created incomplete.
    expect(submitted).not.toHaveProperty('completed');
    expect(submitted).not.toHaveProperty('id');
    expect(submitted).not.toHaveProperty('createdAt');
    expect(submitted).not.toHaveProperty('updatedAt');
  });

  it('clears the fields and returns the priority to medium after a create succeeds', async () => {
    const user = userEvent.setup();
    renderCreateForm(succeedingSubmit());

    const title = screen.getByRole('textbox', { name: 'Title' });
    const description = screen.getByRole('textbox', { name: 'Description' });
    const priority = screen.getByRole('combobox', { name: 'Priority' });
    const submit = screen.getByRole('button', { name: CREATE_LABEL });

    await user.type(title, 'Buy milk');
    await user.type(description, 'Semi-skimmed');
    await user.selectOptions(priority, 'high');
    await user.click(submit);

    await waitFor(() => {
      expect(title).toHaveValue('');
    });

    expect(description).toHaveValue('');
    expect(priority).toHaveValue('medium');
    expect(screen.getByLabelText('Due date')).toHaveValue('');
    expect(submit).toBeEnabled();
  });

  it('disables and marks the submit control busy while a save is in flight, and takes no second submit', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const onSubmit = submitMock().mockReturnValue(deferred.promise);
    renderCreateForm(onSubmit);

    const title = screen.getByRole('textbox', { name: 'Title' });
    const submit = screen.getByRole('button', { name: CREATE_LABEL });

    await user.type(title, 'Buy milk');
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('aria-busy', 'true');
    // The control keeps its label while it is busy, so the user still knows what it does.
    expect(submit).toHaveTextContent(CREATE_LABEL);

    // A second click while the save is pending sends nothing, so no second task can be created.
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve(true);
      await deferred.promise;
    });

    await waitFor(() => {
      expect(submit).toBeEnabled();
    });
    expect(submit).toHaveAttribute('aria-busy', 'false');
    expect(title).toHaveValue('');
  });

  it('keeps what the user typed when the form is re-rendered with new props', async () => {
    const user = userEvent.setup();
    const { rerender } = renderCreateForm(submitMock());

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Buy milk');

    // A new submit handler — what a parent hands down when the list refetches or a save fails — must
    // not reach in and clear the field the user is filling in.
    rerender(<TaskForm onSubmit={succeedingSubmit()} submitLabel={CREATE_LABEL} />);

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Buy milk');
  });
});

describe('TaskForm — edit mode', () => {
  it('names the form after the task and prefills every control from it', () => {
    renderEditForm(submitMock(), cancelMock());

    // The accessible name is what makes the in-place form the edit form of this task.
    expect(
      screen.getByRole('form', { name: `Edit task: ${EDIT_TASK_TITLE}` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(EDIT_TASK_TITLE);
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Semi-skimmed');
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue('high');
    // The stored `YYYY-MM-DD` is shown exactly as stored, with no locale formatting.
    expect(screen.getByLabelText('Due date')).toHaveValue('2026-02-14');
  });

  it('enables Save only once a field differs and then sends only the fields that changed', async () => {
    const user = userEvent.setup();
    let submitted: CreateTaskInput | UpdateTaskInput | null = null;
    const onSubmit = submitMock().mockImplementation((input) => {
      submitted = input;
      return Promise.resolve(true);
    });
    renderEditForm(onSubmit, cancelMock());

    const title = screen.getByRole('textbox', { name: 'Title' });
    const submit = screen.getByRole('button', { name: EDIT_LABEL });

    // Nothing differs yet, so there is no patch to send and an empty one is impossible.
    expect(submit).toBeDisabled();

    await user.clear(title);
    await user.type(title, EDITED_TITLE);

    expect(submit).toBeEnabled();

    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ title: EDITED_TITLE });
    // Only the changed field travels, and never a read-only one.
    expect(submitted).not.toHaveProperty('description');
    expect(submitted).not.toHaveProperty('priority');
    expect(submitted).not.toHaveProperty('dueDate');
    expect(submitted).not.toHaveProperty('id');
    expect(submitted).not.toHaveProperty('createdAt');
    expect(submitted).not.toHaveProperty('updatedAt');
  });

  it('sends only the priority when the priority is the field that changed', async () => {
    const user = userEvent.setup();
    const onSubmit = succeedingSubmit();
    renderEditForm(onSubmit, cancelMock());

    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'low');
    await user.click(screen.getByRole('button', { name: EDIT_LABEL }));

    expect(onSubmit).toHaveBeenCalledWith({ priority: 'low' });
  });

  it('keeps the typed values after an edit is saved', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const onSubmit = submitMock().mockReturnValue(deferred.promise);
    renderEditForm(onSubmit, cancelMock());

    const title = screen.getByRole('textbox', { name: 'Title' });
    const submit = screen.getByRole('button', { name: EDIT_LABEL });

    await user.clear(title);
    await user.type(title, EDITED_TITLE);
    await user.click(submit);

    await act(async () => {
      deferred.resolve(true);
      await deferred.promise;
    });

    // Only a create resets the form: after an edit the fields keep what the user typed, and the
    // parent replaces the item.
    expect(title).toHaveValue(EDITED_TITLE);
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Semi-skimmed');
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue('high');
    expect(submit).toBeEnabled();
  });

  it('calls onCancel from Cancel and never submits', async () => {
    const user = userEvent.setup();
    const onSubmit = submitMock();
    const onCancel = cancelMock();
    renderEditForm(onSubmit, onCancel);

    const title = screen.getByRole('textbox', { name: 'Title' });

    await user.clear(title);
    await user.type(title, EDITED_TITLE);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(title).toHaveValue(EDITED_TITLE);
  });
});
