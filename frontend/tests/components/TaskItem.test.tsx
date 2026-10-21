/**
 * Component suite for `TaskItem` in `src/components/TaskItem.tsx` — the row that displays one task
 * and owns the confirmation standing in front of its deletion.
 *
 * It pins what the row shows: the priority as a word, the title as a heading, the due date verbatim
 * inside a `<time>` element, the word `Overdue` under the rule the selectors own, and the omission
 * of the description and due-date regions when the task has neither. It pins what the row's
 * controls report, and — the reason this file exists at all — that the confirmation dialog is the
 * only route to the deletion: cancelling, pressing Escape and clicking outside the dialog each
 * leave the delete untouched, a click on the card itself leaves the dialog open, Tab cycles between
 * the dialog's two controls instead of leaving the dialog, and the dialog's own confirm control
 * reaches the delete exactly once, with the whole task.
 *
 * Every assertion is reached through a query a user could perform — role, accessible name, label,
 * text — so no class name, no style, no snapshot and no test id is asserted anywhere. The suite
 * never stubs `fetch` and never imports `src/api/client.ts`, because the item performs no I/O of
 * its own: it opens no socket, spawns no process and touches no database.
 *
 * jsdom, the DOM these cases run in, implements no part of the modal API — `showModal`, `show` and
 * `close` are all absent — so the component's own `setAttribute('open', '')` fallback is what makes
 * the dialog reachable, and the reflected `open` attribute is the platform signal the cases assert.
 * jsdom also synthesises no `cancel` event from an Escape keypress, which is the single place
 * `fireEvent` is used, for the reason stated at that call.
 *
 * `frontend/tests/support/helpers.tsx` supplies the render helper, the user-facing queries and the
 * task builder; the fixed date below makes the overdue cases deterministic rather than dependent on
 * the day the suite happens to run. This project has no user rules to cite — `review_rules` reports
 * none — so what governs the file is the behaviour above, strict TypeScript and the obligation that
 * the confirmation cannot be bypassed.
 */

import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';

import type { CreateTaskInput, Task, UpdateTaskInput } from '../../src/api/types';
import { TaskItem } from '../../src/components/TaskItem';

import { makeTask, renderUi, screen, within } from '../support/helpers';

/**
 * The local instant every case runs at: 14 February 2026, midday.
 *
 * Fixed rather than read from the wall clock, because the overdue rule compares the task's due
 * date against today's local date — a suite left on the real clock would flag a different set of
 * tasks tomorrow than it does today. Only `Date` is faked, so `user-event` keeps the real timers it
 * needs to drive its own delays.
 */
const TODAY = new Date(2026, 1, 14, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Renders one task item inside a `<ul>` and returns the mocks the item was handed.
 *
 * The `<ul>` is not decoration: a bare `<li>` has no `listitem` role outside a list, so the list is
 * what gives the row the semantics the suite asserts. Every call builds fresh mocks and a fresh
 * render, so a case asserts on the calls the item it rendered made and on nothing else, and Testing
 * Library's automatic cleanup hook unmounts it afterwards.
 *
 * @param task - The task the item displays, exactly as the API would return it.
 * @param editing - Whether this item is the one being edited.
 * @returns The item's handlers, each a mock recording what the item reported.
 */
function renderItem(task: Task, editing = false) {
  const onToggle = vi.fn<(id: string, completed: boolean) => void>();
  const onEdit = vi.fn<(id: string) => void>();
  const onDelete = vi.fn<(task: Task) => void>();
  const onSave = vi
    .fn<(input: CreateTaskInput | UpdateTaskInput) => Promise<boolean>>()
    .mockResolvedValue(true);
  const onCancelEdit = vi.fn<() => void>();

  renderUi(
    <ul>
      <TaskItem
        task={task}
        onToggle={onToggle}
        onEdit={onEdit}
        onDelete={onDelete}
        editing={editing}
        onSave={onSave}
        onCancelEdit={onCancelEdit}
      />
    </ul>,
  );

  return { onToggle, onEdit, onDelete, onSave, onCancelEdit };
}

/**
 * Presses the item's Delete action and returns the confirmation it opened.
 *
 * Located by role, which works here because jsdom does apply the user agent's `dialog:not([open])`
 * rule: while the confirmation is closed it is `display: none` and no part of it answers a query,
 * so the item's own Delete action is the only one on screen to press.
 *
 * @param user - The user-driving instance the case clicks with.
 * @returns The open dialog element.
 */
async function openDeleteConfirmation(user: UserEvent): Promise<HTMLElement> {
  // The row's action is matched by the word it leads with rather than by its whole accessible name:
  // the item names each control for the task it acts on ("Delete “Buy milk”"), so the exact-name
  // form belongs to the case that asserts that naming and not to every case that presses it.
  await user.click(screen.getByRole('button', { name: /^Delete/ }));

  return screen.findByRole('dialog');
}

describe('TaskItem', () => {
  describe('the task it displays', () => {
    it('renders the priority as a word, the title as a heading and the due date as stored', () => {
      const task = makeTask({ title: 'Buy milk', priority: 'medium', dueDate: '2026-02-14' });
      renderItem(task);

      // The level's meaning is carried by the word, so it survives a monochrome display, a
      // colour-blind reader and a screen reader; the colour only reinforces it.
      expect(screen.getByText('Medium')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: 'Buy milk' })).toBeInTheDocument();

      const dueDate = screen.getByText('2026-02-14');
      expect(dueDate.tagName).toBe('TIME');
      // Shown exactly as stored: no locale-formatted month name reaches the user.
      expect(screen.queryByText(/Feb/)).toBeNull();
      // An empty description omits its region, so the due date is the item's only paragraph.
      expect(screen.getAllByRole('paragraph')).toHaveLength(1);
      expect(screen.getByRole('paragraph')).toHaveTextContent('Due');
    });

    it('renders the description when the task has one', () => {
      renderItem(makeTask({ description: 'Semi-skimmed' }));

      expect(screen.getByText('Semi-skimmed').tagName).toBe('P');
    });

    it('omits the description and due-date regions when the task has neither', () => {
      renderItem(makeTask({ description: '', dueDate: null }));

      // Both regions are left out rather than rendered as empty placeholders.
      expect(screen.queryAllByRole('paragraph')).toHaveLength(0);
      expect(screen.queryByText(/^\d{4}-\d{2}-\d{2}$/)).toBeNull();
      expect(screen.queryByText('Overdue')).toBeNull();
    });
  });

  describe('the overdue marker', () => {
    it('flags an open task whose due date is before today, as a word', () => {
      renderItem(makeTask({ dueDate: '2026-02-13', completed: false }));

      // The word, not a colour or a class: it is what a monochrome display and a screen reader
      // both receive.
      expect(screen.getByText('Overdue')).toBeInTheDocument();
      expect(screen.getByText('Overdue').textContent).toBe('Overdue');
    });

    it('never flags a task due today', () => {
      renderItem(makeTask({ dueDate: '2026-02-14', completed: false }));

      expect(screen.queryByText('Overdue')).toBeNull();
    });

    it('never flags a completed task, whatever its due date', () => {
      renderItem(makeTask({ dueDate: '2026-02-13', completed: true }));

      expect(screen.queryByText('Overdue')).toBeNull();
    });

    it('never flags a task without a due date, and renders no date at all for it', () => {
      renderItem(makeTask({ dueDate: null, completed: false }));

      expect(screen.queryByText('Overdue')).toBeNull();
      expect(screen.queryByText(/^\d{4}-\d{2}-\d{2}$/)).toBeNull();
    });
  });

  describe('the completion checkbox', () => {
    it('names the task it completes and reflects an open task', () => {
      const task = makeTask({ title: 'Buy milk', completed: false });
      renderItem(task);

      const checkbox = screen.getByRole('checkbox', { name: /Buy milk/ });
      expect(checkbox).not.toBeChecked();
      // The label is bound to the control, so the control is reachable by its label too — which is
      // what makes it announced as this task's rather than as a bare checkbox among many. The
      // selector keeps the query to the control itself: the row's two action buttons are named for
      // their task as well, so the same words reach their accessible names.
      expect(screen.getByLabelText(/Buy milk/, { selector: 'input' })).toBe(checkbox);
    });

    it('reports completion of an open task and applies nothing itself', async () => {
      const user = userEvent.setup();
      const task = makeTask({ completed: false });
      const { onToggle } = renderItem(task);

      const checkbox = screen.getByRole('checkbox', { name: /Buy milk/ });
      await user.click(checkbox);

      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onToggle).toHaveBeenCalledWith(task.id, true);
      // The caller owns completion and refetches the list, so nothing is applied optimistically:
      // the item still shows the task it was handed.
      expect(checkbox).not.toBeChecked();
    });

    it('reports reopening of a completed task and applies nothing itself', async () => {
      const user = userEvent.setup();
      const task = makeTask({ completed: true });
      const { onToggle } = renderItem(task);

      const checkbox = screen.getByRole('checkbox', { name: /Buy milk/ });
      expect(checkbox).toBeChecked();

      await user.click(checkbox);

      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onToggle).toHaveBeenCalledWith(task.id, false);
      expect(checkbox).toBeChecked();
    });
  });

  describe('the edit wiring', () => {
    it('asks the caller to put this task into edit mode', async () => {
      const user = userEvent.setup();
      const task = makeTask();
      const { onEdit, onDelete, onSave } = renderItem(task);

      await user.click(screen.getByRole('button', { name: /^Edit/ }));

      expect(onEdit).toHaveBeenCalledTimes(1);
      expect(onEdit).toHaveBeenCalledWith(task.id);
      // Editing is not a save, and it is certainly not a deletion.
      expect(onDelete).not.toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('replaces the item with a prefilled edit form in place', () => {
      const task = makeTask({
        title: 'Buy milk',
        description: 'Semi-skimmed',
        priority: 'high',
        dueDate: '2026-02-14',
      });
      renderItem(task, true);

      const form = screen.getByRole('form', { name: `Edit task: ${task.title}` });
      expect(within(form).getByLabelText('Title')).toHaveValue('Buy milk');
      expect(within(form).getByLabelText('Description')).toHaveValue('Semi-skimmed');
      expect(within(form).getByLabelText('Priority')).toHaveValue('high');
      expect(within(form).getByLabelText('Due date')).toHaveValue('2026-02-14');
      expect(within(form).getByRole('button', { name: 'Save' })).toBeInTheDocument();

      // The display content is replaced rather than duplicated: no checkbox and none of the
      // display-mode actions remain on screen while the item is being edited.
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    });

    it('sends only the field that changed, as a patch carrying no id', async () => {
      const user = userEvent.setup();
      const task = makeTask({ title: 'Buy milk' });
      const { onSave, onCancelEdit } = renderItem(task, true);

      const form = screen.getByRole('form', { name: `Edit task: ${task.title}` });
      const title = within(form).getByLabelText('Title');

      // Nothing differs from the stored task yet, so the form offers nothing to send.
      expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();

      await user.clear(title);
      await user.type(title, 'Buy oat milk');
      await user.click(within(form).getByRole('button', { name: 'Save' }));

      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith({ title: 'Buy oat milk' });
      expect(onCancelEdit).not.toHaveBeenCalled();
    });

    it('abandons the edit when Cancel is pressed', async () => {
      const user = userEvent.setup();
      const { onCancelEdit, onSave } = renderItem(makeTask(), true);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onCancelEdit).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe('list semantics and native controls', () => {
    it('renders as a list item whose actions are native buttons', () => {
      renderItem(makeTask());

      expect(screen.getByRole('listitem')).toBeInTheDocument();

      // Native buttons, not styled elements standing in for them: the tag is what makes them
      // keyboard-operable and reachable by role.
      expect(screen.getByRole('button', { name: /^Edit/ }).tagName).toBe('BUTTON');
      expect(screen.getByRole('button', { name: /^Delete/ }).tagName).toBe('BUTTON');
    });
  });

  describe('the delete confirmation', () => {
    it('opens a dialog naming the task and reports no action until it is confirmed', async () => {
      const user = userEvent.setup();
      const task = makeTask({ title: 'Buy milk' });
      const { onToggle, onEdit, onDelete, onSave, onCancelEdit } = renderItem(task);

      const dialog = await openDeleteConfirmation(user);

      // jsdom implements no part of the modal API, so the platform signal that the dialog is
      // showing is the reflected `open` attribute the component sets as its fallback.
      expect(dialog).toHaveAttribute('open');
      expect(dialog).toHaveTextContent(task.title);
      expect(within(dialog).getByRole('heading', { name: 'Delete task' })).toBeInTheDocument();
      // The dialog's confirm control carries the item's own confirm label; scoping the query by the
      // dialog keeps it apart from the item's Delete action, which says the same word.
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeInTheDocument();

      // Opening the confirmation asks nothing of the caller and performs no other action, so
      // nothing has happened to the task yet.
      expect(onDelete).not.toHaveBeenCalled();
      expect(onToggle).not.toHaveBeenCalled();
      expect(onEdit).not.toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
      expect(onCancelEdit).not.toHaveBeenCalled();
    });

    it('deletes nothing when the confirmation is cancelled', async () => {
      const user = userEvent.setup();
      const { onDelete } = renderItem(makeTask());

      const dialog = await openDeleteConfirmation(user);
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(onDelete).not.toHaveBeenCalled();
      expect(dialog).not.toHaveAttribute('open');
    });

    it('deletes nothing when the confirmation is dismissed with Escape', async () => {
      const user = userEvent.setup();
      const { onDelete } = renderItem(makeTask());

      const cancelled = await openDeleteConfirmation(user);
      await user.click(within(cancelled).getByRole('button', { name: 'Cancel' }));

      const dialog = await openDeleteConfirmation(user);
      expect(dialog).toHaveAttribute('open');

      await user.keyboard('{Escape}');
      // jsdom implements none of the modal API, so the platform's own Escape handling never runs
      // here: a browser fires `cancel` on the dialog before dismissing it, and dispatching that
      // event is the faithful simulation of what this component listens for. `fireEvent` is used
      // for this and for the repeat press below, the two events `user-event`'s own gestures cannot
      // express, and for nothing else in this suite.
      fireEvent(dialog, new Event('cancel'));

      expect(onDelete).not.toHaveBeenCalled();
      expect(dialog).not.toHaveAttribute('open');
    });

    it('deletes nothing when the confirmation is dismissed by a click outside its content', async () => {
      const user = userEvent.setup();
      const { onDelete } = renderItem(makeTask());

      const cancelled = await openDeleteConfirmation(user);
      await user.click(within(cancelled).getByRole('button', { name: 'Cancel' }));

      const dialog = await openDeleteConfirmation(user);
      // A modal dialog's backdrop belongs to the dialog element, so a click whose target is the
      // dialog itself is the click that landed outside the dialog's content.
      await user.click(dialog);

      expect(onDelete).not.toHaveBeenCalled();
      expect(dialog).not.toHaveAttribute('open');
    });

    it('stays open when the press repeats the one that opened it, as a double-click does', async () => {
      const user = userEvent.setup();
      const { onDelete } = renderItem(makeTask());

      const dialog = await openDeleteConfirmation(user);

      // The second press of a double-click on the row's Delete arrives after the confirmation is
      // open, at whatever the pointer now rests on — the card, or the backdrop beside it. The
      // browser counts the presses of one gesture in the click's `detail`, so this is that second
      // press and it must not dismiss the confirmation the first one asked for. `fireEvent` carries
      // the count here, which `user-event`'s own gestures never leave above one.
      fireEvent.click(dialog, { detail: 2 });

      expect(dialog).toHaveAttribute('open');
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('deletes the whole task, once, and only after the confirmation is confirmed', async () => {
      const user = userEvent.setup();
      const task = makeTask({ title: 'Buy milk' });
      const { onDelete } = renderItem(task);

      const cancelled = await openDeleteConfirmation(user);
      await user.click(within(cancelled).getByRole('button', { name: 'Cancel' }));
      expect(onDelete).not.toHaveBeenCalled();

      const dialog = await openDeleteConfirmation(user);
      expect(dialog).toHaveAttribute('open');

      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      // The whole task, not its identifier: the item reports what its caller must delete.
      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith(task);
      expect(dialog).not.toHaveAttribute('open');
    });

    it('stays open when the click lands on the dialog card rather than on its backdrop', async () => {
      const user = userEvent.setup();
      const { onDelete } = renderItem(makeTask());

      const dialog = await openDeleteConfirmation(user);
      const content = dialog.firstElementChild;

      if (content === null) {
        throw new Error('The confirmation dialog rendered no content element to click.');
      }

      // The content wrapper fills the dialog's box and carries the padding the card used to hold on
      // the dialog itself, so a click anywhere on the card — the space around the heading and the
      // message included — targets that wrapper rather than the <dialog> element, which is what a
      // click on the backdrop targets. Nothing is dismissed, so the second click of a rapid
      // double-click on a row's Delete cannot cancel the confirmation the first one opened.
      await user.click(content);

      expect(dialog).toHaveAttribute('open');
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('keeps Tab inside the dialog, wrapping between its two controls', async () => {
      const user = userEvent.setup();
      const { onDelete } = renderItem(makeTask());

      const dialog = await openDeleteConfirmation(user);
      const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
      const confirm = within(dialog).getByRole('button', { name: 'Delete' });

      // jsdom implements no part of the modal API, so nothing places focus when the dialog opens:
      // the move the browser makes into the modal is reproduced here, on the first control, which is
      // where the platform leaves it.
      cancel.focus();
      expect(cancel).toHaveFocus();

      await user.tab();
      expect(confirm).toHaveFocus();

      // Tab on the last control wraps back to the first instead of landing on document.body, the
      // stop at which the dialog no longer holds the active element and no focus indicator is drawn.
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(cancel).toHaveFocus();

      // Shift+Tab on the first control wraps to the last: the same cycle at its other end.
      await user.tab({ shift: true });
      expect(confirm).toHaveFocus();

      expect(dialog).toHaveAttribute('open');
      expect(onDelete).not.toHaveBeenCalled();
    });

  });
});
