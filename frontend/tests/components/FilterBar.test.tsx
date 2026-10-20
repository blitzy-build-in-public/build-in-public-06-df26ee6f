/**
 * Component suite for `FilterBar` in `src/components/FilterBar.tsx`.
 *
 * The bar is where a filter and a sort are chosen, and it chooses neither itself: each control
 * reports the next complete `TaskFilters` through `onChange`, and the parent refetches the list
 * with those values as the `status`, `priority` and `sort` query parameters of `GET /api/tasks`.
 * So this suite pins three things and nothing more — the controls the user meets (three labelled
 * selects carrying the option vocabulary the wire contract accepts), the exact filter set each
 * control emits (including `priority: null` for "All priorities", the one value the contract
 * distinguishes from the other three), and the absence of any task data, filtering or ordering in
 * the render, which is what keeps the server the single implementation of both.
 *
 * Every case drives the bar the way a person does — `@testing-library/user-event` tabs between the
 * selects and selects options — and every assertion goes through a query that names a control by
 * its label or its role. Nothing here inspects a class name, a style or the module graph, so a
 * restyled bar keeps passing; and nothing here performs I/O: the component takes its data and its
 * callback as props, so no client, no `fetch` stub, no server and no database are involved.
 *
 * This project has no user rules to cite — `review_rules` reports none — so nothing here cites one.
 * What governs the file is the interface contract (`status` of `all | open | completed`, `priority`
 * of `low | medium | high` or none at all, `sort` of `dueDate | priority | createdAt`) together with
 * the request's own constraints: strict TypeScript, no secrets and no external service, and a layer
 * that runs entirely in jsdom. Each case renders its own bar with its own props and its own
 * recorder, so no case can observe another's state.
 */

import userEvent from '@testing-library/user-event';

import type { TaskFilters, TaskPriority, TaskSort, TaskStatus } from '../../src/api/types';
import { FilterBar } from '../../src/components/FilterBar';

import { renderUi, screen, within } from '../support/helpers';

/**
 * The label each control is bound to, matched by pattern rather than by exact copy so the suite
 * asserts the association the component declares — every form control carries a real `<label>` —
 * without breaking over a change of words. Each pattern matches exactly one label in the bar.
 */
const STATUS_LABEL = /status/i;

/** The label of the priority control; see {@link STATUS_LABEL}. */
const PRIORITY_LABEL = /priority/i;

/** The label of the sort control; see {@link STATUS_LABEL}. */
const SORT_LABEL = /sort/i;

/**
 * The options the status control must offer: the completion-filter vocabulary of the list
 * endpoint, paired with the words the user reads. Declared as a table rather than asserted one
 * literal at a time, so the count and every name-plus-value pair are checked from one source.
 */
const STATUS_OPTIONS: readonly { readonly value: TaskStatus; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
];

/**
 * The options the priority control must offer. The empty value is the "All priorities" choice:
 * a select cannot hold `null` as a value, so no priority filter is represented in the DOM by `''`
 * and mapped back to `priority: null` on change — the assertion that carries the most weight in
 * this file.
 */
const PRIORITY_OPTIONS: readonly { readonly value: TaskPriority | ''; readonly label: string }[] = [
  { value: '', label: 'All priorities' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** The options the sort control must offer: the three orderings the server applies. */
const SORT_OPTIONS: readonly { readonly value: TaskSort; readonly label: string }[] = [
  { value: 'dueDate', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'createdAt', label: 'Creation time' },
];

/**
 * The filter set the list opens with, which is what the API applies to an empty query string:
 * no completion filter, every priority, and the most recently created task first.
 */
const DEFAULT_FILTERS: TaskFilters = { status: 'all', priority: null, sort: 'createdAt' };

/**
 * Renders the bar with one filter set and returns the recorder that captures the next set it
 * reports.
 *
 * Each call mounts its own bar and allocates its own `vi.fn()`, so no case can see another's
 * filters or calls; Testing Library's automatic cleanup, registered by the suite's `globals: true`
 * setting, unmounts it afterwards.
 *
 * @param filters - The filter set the bar is given, which its three controls display.
 * @returns The mock recording every `onChange` call and the filter set it carried.
 */
function renderBar(filters: TaskFilters) {
  const onChange = vi.fn<(next: TaskFilters) => void>();
  renderUi(<FilterBar filters={filters} onChange={onChange} />);
  return onChange;
}

describe('FilterBar', () => {
  it('renders exactly three controls', () => {
    renderBar(DEFAULT_FILTERS);

    expect(screen.getAllByRole('combobox')).toHaveLength(3);
  });

  it('binds a real label to each control', () => {
    renderBar(DEFAULT_FILTERS);

    for (const label of [STATUS_LABEL, PRIORITY_LABEL, SORT_LABEL]) {
      expect(screen.getByRole('combobox', { name: label })).toBeInTheDocument();
    }
  });

  it('displays the filter set it is given', () => {
    renderBar({ status: 'completed', priority: 'medium', sort: 'priority' });

    const status = screen.getByLabelText(STATUS_LABEL);
    const priority = screen.getByLabelText(PRIORITY_LABEL);
    const sort = screen.getByLabelText(SORT_LABEL);

    expect(status).toHaveValue('completed');
    expect(status).toHaveDisplayValue('Completed');
    expect(priority).toHaveValue('medium');
    expect(priority).toHaveDisplayValue('Medium');
    expect(sort).toHaveValue('priority');
    expect(sort).toHaveDisplayValue('Priority');
  });

  it('displays "All priorities" when the priority filter is null', () => {
    renderBar(DEFAULT_FILTERS);

    const priority = screen.getByLabelText(PRIORITY_LABEL);

    expect(priority).toHaveValue('');
    expect(priority).toHaveDisplayValue('All priorities');
    expect(screen.getByLabelText(STATUS_LABEL)).toHaveDisplayValue('All');
    expect(screen.getByLabelText(SORT_LABEL)).toHaveDisplayValue('Creation time');
  });

  it('offers exactly the status options the API accepts', () => {
    renderBar(DEFAULT_FILTERS);

    const status = screen.getByLabelText(STATUS_LABEL);

    expect(within(status).getAllByRole('option')).toHaveLength(STATUS_OPTIONS.length);
    for (const { value, label } of STATUS_OPTIONS) {
      expect(within(status).getByRole('option', { name: label })).toHaveValue(value);
    }
  });

  it('offers the four priority options, with the empty one carrying no priority filter', () => {
    renderBar(DEFAULT_FILTERS);

    const priority = screen.getByLabelText(PRIORITY_LABEL);

    expect(within(priority).getAllByRole('option')).toHaveLength(PRIORITY_OPTIONS.length);
    for (const { value, label } of PRIORITY_OPTIONS) {
      expect(within(priority).getByRole('option', { name: label })).toHaveValue(value);
    }
  });

  it('offers exactly the three sort options', () => {
    renderBar(DEFAULT_FILTERS);

    const sort = screen.getByLabelText(SORT_LABEL);

    expect(within(sort).getAllByRole('option')).toHaveLength(SORT_OPTIONS.length);
    for (const { value, label } of SORT_OPTIONS) {
      expect(within(sort).getByRole('option', { name: label })).toHaveValue(value);
    }
  });

  it('reaches every control with the keyboard, in the order they are rendered', async () => {
    const user = userEvent.setup();
    renderBar(DEFAULT_FILTERS);

    await user.tab();
    expect(screen.getByLabelText(STATUS_LABEL)).toHaveFocus();

    await user.tab();
    expect(screen.getByLabelText(PRIORITY_LABEL)).toHaveFocus();

    await user.tab();
    expect(screen.getByLabelText(SORT_LABEL)).toHaveFocus();
  });

  it('reports the next filter set when the status changes, preserving the other two', async () => {
    const user = userEvent.setup();
    const onChange = renderBar({ status: 'all', priority: 'high', sort: 'dueDate' });

    await user.selectOptions(screen.getByLabelText(STATUS_LABEL), 'completed');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ status: 'completed', priority: 'high', sort: 'dueDate' });
  });

  it('reports the selected priority, preserving the other two', async () => {
    const user = userEvent.setup();
    const onChange = renderBar({ status: 'open', priority: null, sort: 'dueDate' });

    await user.selectOptions(screen.getByLabelText(PRIORITY_LABEL), 'high');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ status: 'open', priority: 'high', sort: 'dueDate' });
  });

  it('reports no priority filter when "All priorities" is selected', async () => {
    const user = userEvent.setup();
    const onChange = renderBar({ status: 'completed', priority: 'medium', sort: 'priority' });

    await user.selectOptions(screen.getByLabelText(PRIORITY_LABEL), '');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ status: 'completed', priority: null, sort: 'priority' });
  });

  it('reports the selected sort, preserving the other two', async () => {
    const user = userEvent.setup();
    const onChange = renderBar(DEFAULT_FILTERS);

    await user.selectOptions(screen.getByLabelText(SORT_LABEL), 'dueDate');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ status: 'all', priority: null, sort: 'dueDate' });
  });

  it('preserves a non-default status and priority when the sort changes', async () => {
    const user = userEvent.setup();
    const onChange = renderBar({ status: 'open', priority: 'low', sort: 'dueDate' });

    await user.selectOptions(screen.getByLabelText(SORT_LABEL), 'createdAt');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ status: 'open', priority: 'low', sort: 'createdAt' });
  });

  it('holds no task data and computes no ordering, even with a non-default filter set', () => {
    renderBar({ status: 'open', priority: 'high', sort: 'dueDate' });

    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByText(/buy milk/i)).toBeNull();

    // The controls still show exactly the set they were given: the bar neither reorders nor
    // re-filters anything, so the server stays the only implementation of both.
    expect(screen.getByLabelText(STATUS_LABEL)).toHaveValue('open');
    expect(screen.getByLabelText(PRIORITY_LABEL)).toHaveValue('high');
    expect(screen.getByLabelText(SORT_LABEL)).toHaveValue('dueDate');
  });
});
