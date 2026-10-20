/**
 * Component suite for `TaskList` in `src/components/TaskList.tsx` — the rows the list renders and the
 * four states it can be in besides a populated one.
 *
 * Three things this file exists to pin. First, the states are mutually exclusive and chosen by
 * `status` and `filtersActive` alone: an account with no tasks invites the user to add one, a filter
 * that matched nothing says exactly that and offers the way back, a load in flight announces itself
 * politely, and a load that failed shows a retryable alert — never two of them at once, and never the
 * empty state standing in for the filtered one. Second, the list adds nothing of its own: it renders
 * the array it was handed in the order it was handed it, fetches nothing, filters nothing, and binds
 * each row's actions to that row's id, which is why the handler assertions here name ids rather than
 * merely counting calls. Third, a row costs what the row shows: no delete confirmation is mounted
 * anywhere in the list until a row's Delete control is pressed, which is read off the document
 * rather than through a role query, since a closed dialog is hidden from every such query.
 *
 * Every assertion goes through a query a user could perform — role, accessible name, label, text — so
 * no class name, no style, no snapshot and no test id appears anywhere; the one case that reads the
 * document directly does so to count what a role query deliberately cannot see, and for no other
 * reason. The suite never stubs `fetch` and never imports `src/api/client.ts`, because a list that
 * fetched would be the only reason to do either; it opens no socket, spawns no process and touches no
 * database, so the layer runs entirely in jsdom.
 *
 * The clock is fixed at 14 February 2026 because `TaskItem` asks `isOverdue` what "today" is: a suite
 * left on the wall clock would flag a different set of fixtures tomorrow than it does today.
 *
 * This project has no user rules to cite — `review_rules` reports none — so what governs the file is
 * the request's own contract: the states of AAP 0.6.2, the one-ordering rule of AAP 0.6.3, the
 * props contract of AAP 0.7.1 and the jsdom-only layer of AAP 0.10.2.
 */

import userEvent from '@testing-library/user-event';

import type { CreateTaskInput, Task, UpdateTaskInput } from '../../src/api/types';
import { TaskList } from '../../src/components/TaskList';
import type { TaskListProps } from '../../src/components/TaskList';

import { makeTask, renderUi, screen, within } from '../support/helpers';

/**
 * The local instant every case runs at: 14 February 2026, midday.
 *
 * Only `Date` is faked, so `user-event` keeps the real timers it drives its own delays with. The due
 * dates the fixtures use are chosen around this instant, so which rows read as overdue is decided
 * here rather than by the day the suite happens to run.
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
 * What the loading region says, pinned character for character.
 *
 * The plan fixes the empty, filtered-empty and error copy exactly, and this suite pins the loading
 * copy too so a reword of it fails here rather than passing unnoticed.
 */
const LOADING_MESSAGE = 'Loading tasks…';

/** The account has no tasks at all: the empty state, which names the form as the place to change that. */
const EMPTY_STATE_MESSAGE = 'No tasks yet. Add your first task using the form above.';

/** The filters are active and matched nothing: a different screen from the empty state. */
const NO_MATCHES_MESSAGE = 'No matching tasks.';

/** The control that clears the filters and refetches, offered only by the filtered-empty state. */
const CLEAR_FILTERS_LABEL = 'Clear filters';

/** The control that refetches the list after a failed load, offered only by the error state. */
const RETRY_LABEL = 'Retry';

/** The sentence the list falls back to when the caller has no load-failure message of its own. */
const LOAD_ERROR_FALLBACK = 'Could not load tasks. The server may be unreachable.';

/** The caller's own load-failure message, which must win over the list's fallback. */
const SERVER_ERROR_MESSAGE = 'The server could not complete the request. Try again in a moment.';

/** Reports a row's completion toggle with the value its checkbox moved to. */
type ToggleHandler = (id: string, completed: boolean) => void;

/** Applies a row's changed fields, bound by the list to that row's id. */
type SaveHandler = (id: string, input: CreateTaskInput | UpdateTaskInput) => Promise<boolean>;

/** Reports the confirmed deletion of one whole task. */
type DeleteHandler = (task: Task) => void;

/**
 * Renders the list with the defaults a populated, successfully loaded list would have, over fresh
 * handler mocks, and returns those mocks.
 *
 * A case states only what it varies: the four state cases differ in nothing but `status`,
 * `filtersActive` and the message the error status obliges, which is what makes the selection rule
 * rather than the fixtures the thing they prove. Every call builds new mocks and a fresh render, so a
 * case asserts on the calls its own render made and on nothing else; Testing Library's automatic
 * cleanup hook unmounts it afterwards.
 *
 * @param overrides - The props this case replaces; anything omitted keeps its default.
 * @returns Every handler the list was given, each a mock recording what it reported.
 */
function renderList(overrides: Partial<TaskListProps> = {}) {
  const onRetry = vi.fn<() => void>();
  const onClearFilters = vi.fn<() => void>();
  const onToggle = vi.fn<ToggleHandler>();
  const onEdit = vi.fn<(id: string) => void>();
  const onSave = vi.fn<SaveHandler>().mockResolvedValue(true);
  const onCancelEdit = vi.fn<() => void>();
  const onDelete = vi.fn<DeleteHandler>();

  renderUi(
    <TaskList
      tasks={[]}
      status="ready"
      error={null}
      filtersActive={false}
      editingTaskId={null}
      onRetry={onRetry}
      onClearFilters={onClearFilters}
      onToggle={onToggle}
      onEdit={onEdit}
      onSave={onSave}
      onCancelEdit={onCancelEdit}
      onDelete={onDelete}
      {...overrides}
    />,
  );

  return { onRetry, onClearFilters, onToggle, onEdit, onSave, onCancelEdit, onDelete };
}

/**
 * The list item showing the task with this title, in display mode or in edit mode.
 *
 * Rows are located by what a user can see of them — the task's own heading, or the edit form that
 * replaces it — rather than by position, so a case can press the right row's control whatever order
 * the list was handed its tasks in, and without reading a class name or walking the DOM by hand.
 *
 * @param title - The title of the task whose row is wanted.
 * @returns The `<li>` element rendering that task.
 * @throws When no row on screen renders a task with this title.
 */
function itemFor(title: string): HTMLElement {
  const match = screen
    .getAllByRole('listitem')
    .find(
      (item) =>
        within(item).queryByRole('heading', { name: title }) !== null ||
        within(item).queryByRole('form', { name: `Edit task: ${title}` }) !== null,
    );

  if (match === undefined) {
    throw new Error(`No list item renders the task titled “${title}”.`);
  }

  return match;
}

/**
 * One of the four states the list can be in besides a populated one, and the prop combination that
 * selects it.
 */
interface StateCase {
  /** The status the case renders with. */
  status: TaskListProps['status'];
  /** Whether any filter or sort other than the defaults is active. */
  filtersActive: boolean;
  /** The load failure the case hands the list; `null` unless `status` is `'error'`. */
  error: string | null;
  /** The one sentence that identifies this case's state. */
  signature: string;
}

/**
 * The four states, each identified by the copy only it renders.
 *
 * Their fixtures are otherwise identical — an empty task array, no row being edited — so the only
 * thing that can make a case render another case's state is the selection rule itself.
 */
const STATE_CASES: readonly StateCase[] = [
  { status: 'loading', filtersActive: false, error: null, signature: LOADING_MESSAGE },
  { status: 'ready', filtersActive: false, error: null, signature: EMPTY_STATE_MESSAGE },
  { status: 'ready', filtersActive: true, error: null, signature: NO_MATCHES_MESSAGE },
  {
    status: 'error',
    filtersActive: false,
    error: LOAD_ERROR_FALLBACK,
    signature: LOAD_ERROR_FALLBACK,
  },
];

describe('TaskList', () => {
  describe('the states it can be in besides a populated one', () => {
    it('announces that tasks are being fetched, and nothing else, while a load is in flight', () => {
      renderList({ status: 'loading' });

      const loading = screen.getByRole('status');
      expect(loading).toHaveTextContent(/load|fetch/i);
      expect(loading).toHaveTextContent(LOADING_MESSAGE);

      // The four states never render as one another: no alert, no empty state, no filtered-empty
      // state and no rows while a load is in flight.
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
      expect(screen.queryByText(NO_MATCHES_MESSAGE)).toBeNull();
      expect(screen.queryByRole('list')).toBeNull();
    });

    it('invites the user to add a first task when the account holds none and no filter is active', () => {
      renderList({ status: 'ready', tasks: [], filtersActive: false });

      expect(screen.getByText(EMPTY_STATE_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByText(NO_MATCHES_MESSAGE)).toBeNull();
      // There is no filter to clear, so the way out of the filtered-empty state has no place here.
      expect(screen.queryByRole('button', { name: CLEAR_FILTERS_LABEL })).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('list')).toBeNull();
    });

    it('says a filter matched nothing, offers the way back, and reports the clearing', async () => {
      const user = userEvent.setup();
      const { onClearFilters } = renderList({ status: 'ready', tasks: [], filtersActive: true });

      expect(screen.getByText(NO_MATCHES_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
      expect(screen.queryByRole('list')).toBeNull();

      await user.click(screen.getByRole('button', { name: CLEAR_FILTERS_LABEL }));

      // A working control rather than a label: clicking it is what refetches with the filters reset.
      expect(onClearFilters).toHaveBeenCalledTimes(1);
    });

    it('shows a load failure in an alert whose Retry control refetches', async () => {
      const user = userEvent.setup();
      const { onRetry } = renderList({ status: 'error', error: SERVER_ERROR_MESSAGE });

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(SERVER_ERROR_MESSAGE);
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
      expect(screen.queryByText(NO_MATCHES_MESSAGE)).toBeNull();
      expect(screen.queryByRole('list')).toBeNull();

      await user.click(within(alert).getByRole('button', { name: RETRY_LABEL }));

      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("prefers the caller's failure message to its own sentence", () => {
      renderList({ status: 'error', error: SERVER_ERROR_MESSAGE });

      expect(screen.getByRole('alert')).toHaveTextContent(SERVER_ERROR_MESSAGE);
      expect(screen.queryByText(LOAD_ERROR_FALLBACK)).toBeNull();
    });

    it.each([null, '', '   '])(
      'falls back to its own failure sentence when the caller has nothing to show (%s)',
      (error) => {
        renderList({ status: 'error', error });

        // A caller with no message, or only whitespace, leaves the alert with its own sentence
        // rather than with nothing to show.
        expect(screen.getByRole('alert')).toHaveTextContent(LOAD_ERROR_FALLBACK);
      },
    );

    it.each(STATE_CASES)('renders the $status state alone, and none of the other three', (state) => {
      renderList({
        tasks: [],
        status: state.status,
        error: state.error,
        filtersActive: state.filtersActive,
      });

      expect(screen.getByText(state.signature)).toBeInTheDocument();

      for (const other of STATE_CASES) {
        if (other !== state) {
          expect(screen.queryByText(other.signature)).toBeNull();
        }
      }

      // The regions follow the same rule: only a load in flight announces a status region, and only
      // a failed load raises an alert.
      expect(screen.queryByRole('status') !== null).toBe(state.status === 'loading');
      expect(screen.queryByRole('alert') !== null).toBe(state.status === 'error');
    });
  });

  describe('the tasks it renders', () => {
    it('renders one row per task, in the order the caller supplied them', () => {
      const receipts = makeTask({ title: 'Sort receipts', dueDate: '2026-04-01', priority: 'medium' });
      const dentist = makeTask({ title: 'Book dentist', dueDate: '2026-02-20', priority: 'low' });
      const passport = makeTask({ title: 'Renew passport', dueDate: '2026-03-10', priority: 'high' });
      // Handed over as receipts, dentist, passport — neither the due-date order (dentist, passport,
      // receipts) nor the priority order (passport, receipts, dentist). The server applies the
      // filter and the sort, so a list that ordered its own rows would fail this assertion.
      const tasks = [receipts, dentist, passport];

      renderList({ tasks });

      expect(screen.getAllByRole('listitem')).toHaveLength(tasks.length);
      for (const task of tasks) {
        expect(screen.getByText(task.title)).toBeInTheDocument();
      }

      const renderedTitles = screen
        .getAllByRole('listitem')
        .map((item) => within(item).getByRole('heading').textContent);

      expect(renderedTitles).toEqual(tasks.map((task) => task.title));
    });

    it('renders no filter or sort control of its own', () => {
      renderList({ tasks: [makeTask({ title: 'Buy milk' })] });

      // The filter and sort controls belong to `App.tsx` and reach the list as the query parameters
      // of the next request, so a list that owned filters would show up here as a combobox.
      expect(screen.queryAllByRole('combobox')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: CLEAR_FILTERS_LABEL })).toBeNull();
      expect(screen.queryByRole('button', { name: RETRY_LABEL })).toBeNull();
    });

    it('renders a task with no description and no due date among dated ones without a placeholder', () => {
      const bare = makeTask({ title: 'Water plants', description: '', dueDate: null });
      const dated = makeTask({
        title: 'File taxes',
        description: 'Receipts attached',
        dueDate: '2026-02-20',
      });

      renderList({ tasks: [dated, bare] });

      const bareItem = itemFor(bare.title);
      expect(within(bareItem).getByRole('heading', { name: bare.title })).toBeInTheDocument();
      // The regions of the fields this task does not have are left out rather than rendered empty:
      // no description paragraph, no date and no overdue marker on a task without a due date.
      expect(within(bareItem).queryAllByRole('paragraph')).toHaveLength(0);
      expect(within(bareItem).queryByText(/^\d{4}-\d{2}-\d{2}$/)).toBeNull();
      expect(within(bareItem).queryByText('Overdue')).toBeNull();

      const datedItem = itemFor(dated.title);
      expect(within(datedItem).getByText('2026-02-20')).toBeInTheDocument();
      expect(within(datedItem).getByText('Receipts attached')).toBeInTheDocument();
    });

    it('mounts no confirmation dialog anywhere in the list until a row asks for one', async () => {
      const user = userEvent.setup();
      const milk = makeTask({ title: 'Buy milk' });
      const dentist = makeTask({ title: 'Book dentist' });
      renderList({ tasks: [milk, dentist] });

      // Counted in the document rather than queried by role, because this case is about the DOM a
      // row costs rather than about what a user can reach: jsdom applies the user agent's
      // `dialog:not([open]) { display: none }` rule, so a closed dialog is deliberately invisible to
      // a role query and the number of them has to be read directly. A row mounts no confirmation at
      // all until its Delete control is pressed, so 1,000 tasks cost 1,000 rows of content instead
      // of 1,000 permanently mounted closed dialog subtrees.
      expect(document.querySelectorAll('dialog')).toHaveLength(0);

      await user.click(within(itemFor(dentist.title)).getByRole('button', { name: 'Delete' }));

      // Exactly one, for the row whose Delete control was pressed: the dialog is now open — which is
      // what puts it back within reach of the role query — and it names that row's task.
      const dialog = await screen.findByRole('dialog');
      expect(document.querySelectorAll('dialog')).toHaveLength(1);
      expect(dialog).toHaveAttribute('open');
      expect(dialog).toHaveTextContent(dentist.title);
    });
  });

  describe('the handlers it binds to each row', () => {
    it('reports a completion toggle with the id of the row it happened on', async () => {
      const user = userEvent.setup();
      const completed = makeTask({ title: 'Book dentist', completed: true });
      const open = makeTask({ title: 'Buy milk', completed: false });
      const { onToggle } = renderList({ tasks: [completed, open] });

      const checkbox = screen.getByRole('checkbox', { name: /Buy milk/ });
      expect(checkbox).not.toBeChecked();

      await user.click(checkbox);

      // The second row's id, not the first's: the list binds each row's action to that row's task.
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onToggle).toHaveBeenCalledWith(open.id, true);
      // Nothing is applied optimistically: the row still shows the task it was handed.
      expect(checkbox).not.toBeChecked();
    });

    it('asks the caller to edit the row whose Edit control was pressed', async () => {
      const user = userEvent.setup();
      const first = makeTask({ title: 'Buy milk' });
      const second = makeTask({ title: 'Book dentist' });
      const { onEdit, onDelete } = renderList({ tasks: [first, second] });

      await user.click(within(itemFor(second.title)).getByRole('button', { name: 'Edit' }));

      expect(onEdit).toHaveBeenCalledTimes(1);
      expect(onEdit).toHaveBeenCalledWith(second.id);
      // Asking to edit is not a deletion.
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('renders the edit form for the row being edited, and for no other row', () => {
      const edited = makeTask({ title: 'Buy milk' });
      const untouched = makeTask({ title: 'Book dentist' });
      renderList({ tasks: [untouched, edited], editingTaskId: edited.id });

      // The id decides which row is edited, not the position: the edited task is the second row.
      const form = screen.getByRole('form', { name: `Edit task: ${edited.title}` });
      expect(screen.getAllByRole('form')).toHaveLength(1);
      expect(within(form).getByLabelText('Title')).toHaveValue(edited.title);

      // The edited row's display content — its heading and its completion control — is replaced by
      // the form, while the other row keeps both.
      const untouchedItem = itemFor(untouched.title);
      expect(
        within(untouchedItem).getByRole('heading', { name: untouched.title }),
      ).toBeInTheDocument();
      expect(
        within(untouchedItem).getByRole('checkbox', { name: /Book dentist/ }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: edited.title })).toBeNull();
      expect(screen.queryByRole('checkbox', { name: /Buy milk/ })).toBeNull();
    });

    it('saves the changed fields against the id of the row the form belongs to', async () => {
      const user = userEvent.setup();
      const edited = makeTask({ title: 'Buy milk' });
      const untouched = makeTask({ title: 'Book dentist' });
      const { onSave, onCancelEdit } = renderList({
        tasks: [edited, untouched],
        editingTaskId: edited.id,
      });

      const form = screen.getByRole('form', { name: `Edit task: ${edited.title}` });
      const title = within(form).getByLabelText('Title');
      // Nothing differs from the stored task yet, so there is nothing to send.
      expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();

      await user.clear(title);
      await user.type(title, 'Buy oat milk');
      await user.click(within(form).getByRole('button', { name: 'Save' }));

      // The list binds the id and the form supplies only what changed: `toHaveBeenCalledWith`
      // compares both arguments exactly, so a patch carrying any further key — the id, or one of the
      // server-owned timestamps — fails here as well.
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith(edited.id, { title: 'Buy oat milk' });
      expect(onCancelEdit).not.toHaveBeenCalled();
    });

    it('leaves edit mode through the caller when the edit is abandoned', async () => {
      const user = userEvent.setup();
      const task = makeTask({ title: 'Buy milk' });
      const { onCancelEdit, onSave } = renderList({ tasks: [task], editingTaskId: task.id });

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onCancelEdit).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
    });

    it('deletes only through the confirmation, and reports the whole task once it is confirmed', async () => {
      const user = userEvent.setup();
      const task = makeTask({ title: 'Buy milk' });
      const { onDelete } = renderList({ tasks: [task] });

      await user.click(within(itemFor(task.title)).getByRole('button', { name: 'Delete' }));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent(task.title);
      // Opening the confirmation reports nothing: the dialog owns the destructive step, and its
      // exhaustive cases — Cancel, Escape, a click outside and the confirm itself — belong to the
      // item's own suite.
      expect(onDelete).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      // The whole task, not its identifier: the list reports what its caller must delete.
      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith(task);
    });
  });
});
