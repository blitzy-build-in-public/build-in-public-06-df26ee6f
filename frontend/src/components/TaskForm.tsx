/**
 * The create and edit form for a task.
 *
 * One component serves both jobs because a task is created and edited through the same four
 * fields: it renders in create mode when no `initialTask` is supplied, and in edit mode, prefilled
 * from that task, when one is. `TaskItem.tsx` renders it in place of the item being edited, so two
 * instances can be on screen at once — which is why every control id and error id is derived from
 * `useId()` rather than hard-coded: repeated ids would break the label association and the error
 * link of one of the two forms.
 *
 * The form owns its own input. That is what keeps what the user typed through a list refetch, a
 * failed submit and a rejection from the server: no other region re-renders these fields, and the
 * values are reset only after a create succeeds. The form never reaches the API itself — it hands
 * the payload to `onSubmit` and renders what comes back — so it stays a view over its props and
 * the parent keeps deciding what a save means.
 *
 * Validation is deliberately not this file's to decide. The three checks made before a request is
 * sent exist only to give immediate feedback; they repeat the server's own message strings
 * verbatim and never replace the server's answer, which is what arrives in a rejected save. All
 * four controls are labelled, an errored control is linked to its message, and focus is never
 * moved when an error appears, so the user's place on the page is preserved.
 */

import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import type { CreateTaskInput, Task, TaskPriority, UpdateTaskInput } from '../api/types';
import { priorityLabel } from '../state/taskSelectors';
import styles from './TaskForm.module.css';

/**
 * Props of {@link TaskForm}.
 *
 * The component takes its data and its actions as props and renders no control it was not handed
 * a handler for: an absent `onCancel` means the form is a create form and shows no Cancel control.
 */
export interface TaskFormProps {
  /** The task being edited. Absent means create mode: empty fields, `medium` priority, no Cancel. */
  initialTask?: Task;
  /**
   * Sends the payload — a create body or a patch carrying only the fields that differ — and
   * resolves with whether the save succeeded.
   *
   * Resolving `false` means the save failed; throwing means the failure carries detail, which is
   * read below as a field map, a `VALIDATION_ERROR` message, or nothing usable at all.
   */
  onSubmit: (input: CreateTaskInput | UpdateTaskInput) => Promise<boolean>;
  /** Called by the Cancel control, which is rendered only when this is supplied. */
  onCancel?: () => void;
  /** The submit control's visible label, rendered verbatim and never swapped while a save runs. */
  submitLabel: string;
}

/**
 * The three priority levels in the order the select offers them, typed so that the change handler
 * can narrow a select's string value back to a `TaskPriority` by lookup rather than by a cast.
 */
const PRIORITY_VALUES: readonly TaskPriority[] = ['low', 'medium', 'high'];

/** The title bound and the message the server produces for it, repeated here for immediate feedback. */
const TITLE_MAX_LENGTH = 200;
const TITLE_REQUIRED_MESSAGE = 'Title is required';
const TITLE_TOO_LONG_MESSAGE = 'Title must be 200 characters or fewer';

/** The description bound and its message, repeated for immediate feedback. */
const DESCRIPTION_MAX_LENGTH = 2000;
const DESCRIPTION_TOO_LONG_MESSAGE = 'Description must be 2000 characters or fewer';

/**
 * Shown whenever a save fails without a usable detail: a server error, an unreachable API, or a
 * rejection carrying neither a field map nor the server's own message. The exact wording is a
 * contract other files rely on.
 */
const SAVE_FAILED_MESSAGE = 'Could not save the task. The server may be unreachable.';

/** The form's own field values. `dueDate` is `''` when the task has no due date. */
interface FormValues {
  title: string;
  description: string;
  priority: TaskPriority;
  dueDate: string;
}

/**
 * The form's values compared as the server stores them: trimmed, with an empty due date becoming
 * `null`. Comparing on this shape is what makes the dirty check and the patch agree with the
 * server's own notion of equality — a trailing space is not an edit, and clearing the date is.
 */
interface ComparableTaskFields {
  title: string;
  description: string;
  priority: TaskPriority;
  dueDate: string | null;
}

/** The values as the server would store them. */
function toComparableFields(values: FormValues): ComparableTaskFields {
  return {
    title: values.title.trim(),
    description: values.description.trim(),
    priority: values.priority,
    dueDate: values.dueDate === '' ? null : values.dueDate,
  };
}

/**
 * The patch for an edited task: only the fields that differ from the stored ones.
 *
 * A partial patch is what `PATCH /api/tasks/:id` wants, and an empty one is rejected with 400. The
 * submit control is disabled while nothing differs, and the submit handler treats an empty patch
 * as nothing to send, so neither route can produce that request.
 */
function buildPatch(task: Task, fields: ComparableTaskFields): UpdateTaskInput {
  const patch: UpdateTaskInput = {};

  if (fields.title !== task.title) {
    patch.title = fields.title;
  }
  if (fields.description !== task.description) {
    patch.description = fields.description;
  }
  if (fields.priority !== task.priority) {
    patch.priority = fields.priority;
  }
  if (fields.dueDate !== task.dueDate) {
    patch.dueDate = fields.dueDate;
  }

  return patch;
}

/** What a rejected save tells the form, once a rejection of unknown shape has been narrowed. */
interface RejectionDetails {
  /** The server's own summary, or `null` when the rejection carried none. */
  message: string | null;
  /** Field-level messages keyed by field name; `{}` when the rejection named no field. */
  fields: Record<string, string>;
  /** The failure class, or `null` when the rejection carried none. */
  code: string | null;
}

/** Whether a caught value is an object, excluding `null` and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps the string entries of a field map, so an absent or malformed one becomes an empty map. */
function toFieldMap(value: unknown): Record<string, string> {
  const fields: Record<string, string> = {};

  if (!isRecord(value)) {
    return fields;
  }

  for (const [field, message] of Object.entries(value)) {
    if (typeof message === 'string') {
      fields[field] = message;
    }
  }

  return fields;
}

/**
 * Reads whatever a rejected `onSubmit` threw, without naming the API client's error class.
 *
 * A component may not import `api/client.ts` — the architecture rule keeps HTTP in one module —
 * so `instanceof ApiError` is unavailable and the rejection is duck-typed from `unknown` instead.
 * Both shapes the client can produce are accepted: an object carrying `message`, `code` and
 * `fields` directly, and one nesting them under an `error` property, which is the raw
 * `ApiErrorBody` envelope from `../api/types`. Anything unusable yields no message, no fields and
 * no code, which the submit handler turns into the generic not-saved message.
 */
function readRejection(reason: unknown): RejectionDetails {
  if (!isRecord(reason)) {
    return { message: null, fields: {}, code: null };
  }

  const nested = reason['error'];
  const source = isRecord(nested) ? nested : reason;
  const rawMessage = source['message'];
  const rawCode = source['code'];

  return {
    message: typeof rawMessage === 'string' && rawMessage !== '' ? rawMessage : null,
    fields: toFieldMap(source['fields']),
    code: typeof rawCode === 'string' ? rawCode : null,
  };
}

/**
 * The task form: four labelled fields, a form-level message above them, and the submit and Cancel
 * controls.
 *
 * Every control is a native input, select, textarea or button, so the whole form is keyboard
 * operable in a sensible order and Enter submits it. A field the server rejected carries
 * `aria-invalid` and points at its message with `aria-describedby`, so the message is announced
 * with the control rather than floating unconnected; focus stays where the user left it. The
 * form-level message is announced as an alert, because it describes the save as a whole.
 */
export function TaskForm({ initialTask, onSubmit, onCancel, submitLabel }: TaskFormProps) {
  const [title, setTitle] = useState<string>(initialTask?.title ?? '');
  const [description, setDescription] = useState<string>(initialTask?.description ?? '');
  const [priority, setPriority] = useState<TaskPriority>(initialTask?.priority ?? 'medium');
  const [dueDate, setDueDate] = useState<string>(initialTask?.dueDate ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Held so that focus can be put back on the submit control after a save settles: disabling a
  // focused control moves focus to the document body in every current browser, which would take a
  // keyboard user's place on the page away exactly when a failure made them need it.
  const submitRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<boolean>(false);

  // Two forms can be on screen at once — the create form and an in-place edit form — so every id
  // is prefixed with this instance's own value. Hard-coded ids would collide and leave one form's
  // label pointing at the other form's control.
  const formId = useId();
  const titleId = `${formId}-title`;
  const titleErrorId = `${formId}-title-error`;
  const descriptionId = `${formId}-description`;
  const descriptionErrorId = `${formId}-description-error`;
  const priorityId = `${formId}-priority`;
  const priorityErrorId = `${formId}-priority-error`;
  const dueDateId = `${formId}-due-date`;
  const dueDateErrorId = `${formId}-due-date-error`;

  const titleError = fieldErrors['title'];
  const descriptionError = fieldErrors['description'];
  const priorityError = fieldErrors['priority'];
  const dueDateError = fieldErrors['dueDate'];

  const currentFields = toComparableFields({ title, description, priority, dueDate });
  const isDirty =
    initialTask === undefined || Object.keys(buildPatch(initialTask, currentFields)).length > 0;
  const submitDisabled = submitting || (initialTask !== undefined && !isDirty);

  // Runs once the save has settled and the control is enabled again. Focus goes back only where it
  // was genuinely lost to the body: a user who moved to another control keeps their place, and the
  // restoration is a return, never a jump away from what the user is doing.
  useEffect(() => {
    if (submitting || !restoreFocusRef.current) {
      return;
    }

    restoreFocusRef.current = false;

    if (document.activeElement === null || document.activeElement === document.body) {
      submitRef.current?.focus();
    }
  }, [submitting]);

  /**
   * Drops the message attached to one field as soon as the user edits that field, because the
   * message described the value that has just been replaced. Other fields' messages stay, and the
   * form-level message stays until the next attempt — it describes that attempt, not one value.
   */
  function clearFieldError(field: string): void {
    setFieldErrors((current) => {
      if (!(field in current)) {
        return current;
      }

      const remaining: Record<string, string> = {};

      for (const [key, message] of Object.entries(current)) {
        if (key !== field) {
          remaining[key] = message;
        }
      }

      return remaining;
    });
  }

  /**
   * Renders a failed save: the field map when the server named fields, its own message when it
   * named none but reported a rejected request, and the generic not-saved sentence otherwise.
   * Field values are never touched here — what the user typed survives every failure.
   */
  function showFailure(reason: unknown): void {
    const { message, fields, code } = readRejection(reason);

    if (Object.keys(fields).length > 0) {
      setFieldErrors(fields);
      setFormError(null);
      return;
    }

    if (code === 'VALIDATION_ERROR' && message !== null) {
      setFieldErrors({});
      setFormError(message);
      return;
    }

    setFieldErrors({});
    setFormError(SAVE_FAILED_MESSAGE);
  }

  /** Narrows the select's value back to a level by lookup, so no assertion is needed. */
  function handlePriorityChange(event: ChangeEvent<HTMLSelectElement>): void {
    const next = PRIORITY_VALUES.find((value) => value === event.target.value);

    if (next !== undefined) {
      setPriority(next);
      clearFieldError('priority');
    }
  }

  /**
   * Validates the title and the description as far as a browser can — which is only their length —
   * then sends the payload. A create sends all four fields and never `completed`; an edit sends
   * only what differs, and nothing at all when nothing does.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const nextFieldErrors: Record<string, string> = {};

    if (currentFields.title.length === 0) {
      nextFieldErrors['title'] = TITLE_REQUIRED_MESSAGE;
    } else if (currentFields.title.length > TITLE_MAX_LENGTH) {
      nextFieldErrors['title'] = TITLE_TOO_LONG_MESSAGE;
    }

    if (currentFields.description.length > DESCRIPTION_MAX_LENGTH) {
      nextFieldErrors['description'] = DESCRIPTION_TOO_LONG_MESSAGE;
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setFormError(null);
      return;
    }

    const payload: CreateTaskInput | UpdateTaskInput =
      initialTask === undefined
        ? {
            title: currentFields.title,
            description: currentFields.description,
            priority: currentFields.priority,
            dueDate: currentFields.dueDate,
          }
        : buildPatch(initialTask, currentFields);

    // An empty patch is rejected by the API, and the disabled submit control already prevents one;
    // this keeps the guarantee even if the form is submitted some other way, such as by Enter.
    if (Object.keys(payload).length === 0) {
      return;
    }

    restoreFocusRef.current = true;
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);

    try {
      const succeeded = await onSubmit(payload);

      if (succeeded) {
        // Create mode is the only mode the form owns after a save: the parent replaces an edited
        // item with the updated task, while a created task leaves the form to be filled again.
        if (initialTask === undefined) {
          setTitle('');
          setDescription('');
          setPriority('medium');
          setDueDate('');
        }
      } else {
        // The rejection detail, if any, was the parent's to read: a resolved `false` carries none.
        showFailure(undefined);
      }
    } catch (error) {
      showFailure(error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      // The browser's own validation is off so that a refusal never surfaces as a native bubble
      // instead of the message beside the field; the server is the authority on every rule.
      noValidate
      aria-label={initialTask !== undefined ? `Edit task: ${initialTask.title}` : undefined}
    >
      {formError !== null && (
        <p className={styles.formError} role="alert">
          {formError}
        </p>
      )}

      <div className={styles.fields}>
        <div className={`${styles.field} ${styles.fieldTitle}`}>
          <label className={styles.label} htmlFor={titleId}>
            Title
          </label>
          <input
            id={titleId}
            className={styles.input}
            type="text"
            value={title}
            required
            onChange={(event) => {
              setTitle(event.target.value);
              clearFieldError('title');
            }}
            aria-invalid={titleError !== undefined}
            aria-describedby={titleError !== undefined ? titleErrorId : undefined}
          />
          {titleError !== undefined && (
            <p className={styles.fieldError} id={titleErrorId}>
              {titleError}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={descriptionId}>
            Description
          </label>
          <textarea
            id={descriptionId}
            className={styles.textarea}
            rows={3}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              clearFieldError('description');
            }}
            aria-invalid={descriptionError !== undefined}
            aria-describedby={descriptionError !== undefined ? descriptionErrorId : undefined}
          />
          {descriptionError !== undefined && (
            <p className={styles.fieldError} id={descriptionErrorId}>
              {descriptionError}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={priorityId}>
            Priority
          </label>
          <select
            id={priorityId}
            className={styles.select}
            value={priority}
            onChange={handlePriorityChange}
            aria-invalid={priorityError !== undefined}
            aria-describedby={priorityError !== undefined ? priorityErrorId : undefined}
          >
            {PRIORITY_VALUES.map((value) => (
              <option key={value} value={value}>
                {priorityLabel(value)}
              </option>
            ))}
          </select>
          {priorityError !== undefined && (
            <p className={styles.fieldError} id={priorityErrorId}>
              {priorityError}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={dueDateId}>
            Due date
          </label>
          <input
            id={dueDateId}
            className={styles.input}
            type="date"
            value={dueDate}
            onChange={(event) => {
              setDueDate(event.target.value);
              clearFieldError('dueDate');
            }}
            aria-invalid={dueDateError !== undefined}
            aria-describedby={dueDateError !== undefined ? dueDateErrorId : undefined}
          />
          {dueDateError !== undefined && (
            <p className={styles.fieldError} id={dueDateErrorId}>
              {dueDateError}
            </p>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        {onCancel !== undefined && (
          // Cancel is offered only where there is something to go back to, and never while a save
          // is being applied, since the edit it would abandon is already on its way to the server.
          <button
            type="button"
            className={styles.cancel}
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          ref={submitRef}
          className={submitting ? `${styles.submit} ${styles.busy}` : styles.submit}
          disabled={submitDisabled}
          aria-busy={submitting}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
