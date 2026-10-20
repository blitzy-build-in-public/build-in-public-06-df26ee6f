/**
 * Unit suite for the frontend's single state hook, `useTasks` in `src/state/useTasks.ts`.
 *
 * The hook is the interface's only stateful module — it owns the task list, the filters the server
 * is asked to apply, the notice region and the five actions — so this suite pins the contract every
 * component consumes: what a load settles as, what each action calls on the client, what a rejected
 * action leaves behind in state and on the channel its caller reads the failure from, and what
 * happens when the server no longer holds the task an action named.
 *
 * The API client is an injected argument and is always the fake built by
 * `tests/support/helpers.tsx`: the hook is rendered, not a component, and no case stubs `fetch`,
 * opens a socket, starts a server or touches a database. Every interaction this suite observes is a
 * recorded call on that fake, which is what makes the hook's own behaviour — and nothing else —
 * the thing under test.
 *
 * Two conventions keep the assertions honest. Every refetch is asserted with a call-count *delta*
 * and `toHaveBeenLastCalledWith`, never an exact total, because React may double-invoke the mount
 * effect. And the 404 cases hold the next list answer open, so a task leaving the list can only be
 * the hook's own removal rather than the arrival of a fresh server list.
 */

import { act, renderHook, waitFor } from '@testing-library/react';

import { ApiError } from '../../src/api/client';
import type { TaskApi } from '../../src/api/client';
import type { CreateTaskInput, Task, TaskFilters, UpdateTaskInput } from '../../src/api/types';
import { useTasks } from '../../src/state/useTasks';
import type { UseTasksResult } from '../../src/state/useTasks';
import { createFakeTaskApi, makeApiError, makeTask } from '../support/helpers';
import type { FakeTaskApi } from '../support/helpers';

/**
 * The filters a list starts with and `clearFilters` restores. Spelled here rather than imported,
 * because the hook does not export it; a change to it is meant to fail this suite.
 */
const DEFAULT_FILTERS: TaskFilters = { status: 'all', priority: null, sort: 'createdAt' };

/** A non-default filter set, so a refetch can be proved to carry the active filters and not the defaults. */
const ACTIVE_FILTERS: TaskFilters = { status: 'open', priority: 'high', sort: 'dueDate' };

/**
 * The wording the hook puts in the notice region after an action found its task already gone.
 * Spelled here for the same reason: the plan fixes this text and a change to it should be visible.
 */
const MISSING_TASK_NOTICE = 'That task no longer exists.';

/** The creation moment of every fixture task; a fixed literal, never the wall clock. */
const CREATED_AT = '2026-02-01T09:15:00.000Z';

/** A later, fixed instant, used to prove the list shows the timestamps the server sent. */
const UPDATED_AT = '2026-02-02T08:30:00.000Z';

/** The identifier of the task under test, fixed so an argument assertion compares like for like. */
const TASK_ID = '9c8f5b1e-6f2a-4a1d-9c77-2f0b1d3e4a55';

/** The identifier of the task the server no longer holds in the 404 cases. */
const GONE_TASK_ID = '1f4c2d7a-8b93-4e06-a1f5-7c9d0e2b3a44';

/** A second surviving identifier, so a removal can be checked by id rather than by position. */
const OTHER_TASK_ID = '3d7e9a1c-5b28-4f60-8a3d-2e6b1c4f7d90';

/** The create body the create case sends, so its argument assertion names one value. */
const CREATE_INPUT: CreateTaskInput = { title: 'Write the suite', priority: 'high' };

/** The patch the update case sends, so its argument assertion names one value. */
const UPDATE_PATCH: UpdateTaskInput = { title: 'Renamed task', priority: 'low' };

/** A failure the server answered with, for the cases about a rejected action or a failed load. */
function serverFailure(): ApiError {
  return makeApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong' });
}

/** A failure for a request that never reached the server, the client's spelling of `status: 0`. */
function offlineFailure(): ApiError {
  return makeApiError({ status: 0, code: 'INTERNAL_ERROR' });
}

/** The failure the server returns for a task it no longer holds: a real 404 `ApiError`. */
function missingTaskFailure(taskId: string): ApiError {
  return makeApiError({ status: 404, code: 'NOT_FOUND', message: `Task ${taskId} was not found` });
}

/** The message the server owns for the `dueDate` rule, spelled as `TaskForm` displays it. */
const DUE_DATE_FORMAT_MESSAGE = 'Due date must be a date in YYYY-MM-DD format';

/** The message the server owns for the `title` rule. */
const TITLE_REQUIRED_MESSAGE = 'Title is required';

/** The field map a refused due date answers with — the detail a boolean cannot carry. */
const REJECTED_FIELDS: Record<string, string> = { dueDate: DUE_DATE_FORMAT_MESSAGE };

/** The 400 a create answers with when it refuses one field, field map and all. */
function fieldRejection(): ApiError {
  return makeApiError({
    status: 400,
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    fields: REJECTED_FIELDS,
  });
}

/**
 * Narrows what the hook's failure channel holds to the failure the client raises.
 *
 * That member is typed `unknown`, because a rejection is whatever was thrown, so every case below
 * narrows rather than trusting the channel's contents.
 */
function failureFrom(channel: unknown): ApiError {
  if (!(channel instanceof ApiError)) {
    throw new Error(`Expected the channel to hold an ApiError, received ${String(channel)}.`);
  }
  return channel;
}

/** The fake client every case injects; rebuilt in `beforeEach` so no mock state leaks between cases. */
let api: FakeTaskApi = createFakeTaskApi();

/** What the fake server currently holds, read by the client's `listTasks` when it is called. */
let serverTasks: Task[] = [];

/** The resolver of a deliberately held list answer, or `null` when none is being held. */
let heldListResolver: ((tasks: Task[]) => void) | null = null;

beforeEach(() => {
  api = createFakeTaskApi();
  serverTasks = [];
  heldListResolver = null;
  api.listTasks.mockImplementation(() => Promise.resolve([...serverTasks]));
});

/** Renders the hook with an injected client, defaulting to the fake this suite holds. */
function renderTasks(client: TaskApi = api) {
  return renderHook(() => useTasks(client));
}

/** The render result type, inferred so this suite never names Testing Library's own generics. */
type RenderedHook = ReturnType<typeof renderTasks>;

/**
 * Tells the fake server what it holds, renders the hook and waits for the first load to settle.
 *
 * @param initial - The list `listTasks` answers the first request with.
 * @returns The render result, ready for the hook's state and actions to be read.
 */
async function renderReady(initial: readonly Task[]): Promise<RenderedHook> {
  serverTasks = [...initial];
  const rendered = renderTasks();
  await waitFor(() => {
    expect(rendered.result.current.status).toBe('ready');
  });
  return rendered;
}

/** The number of list requests the fake has recorded so far. */
function listCalls(): number {
  return api.listTasks.mock.calls.length;
}

/** Waits until the fake has recorded at least one list request since `before`. */
async function expectRefetchedSince(before: number): Promise<void> {
  await waitFor(() => {
    expect(listCalls()).toBeGreaterThan(before);
  });
}

/**
 * Holds the next list answer open, so a state change that is not the arrival of a server list can be
 * observed on its own. A case that holds an answer must release it before the render is torn down.
 */
function holdNextListAnswer(): void {
  heldListResolver = null;
  api.listTasks.mockImplementation(
    () =>
      new Promise<Task[]>((resolve) => {
        heldListResolver = resolve;
      }),
  );
}

/** Answers the held list request with the given list, so the server's version of the truth lands. */
async function releaseListAnswer(tasks: readonly Task[]): Promise<void> {
  const resolve = heldListResolver;
  if (resolve === null) {
    throw new Error('No list answer was being held.');
  }
  heldListResolver = null;
  await act(async () => {
    resolve([...tasks]);
  });
}

/** Runs an action inside `act` and returns the boolean it resolved with. */
async function performAction(action: () => Promise<boolean>): Promise<boolean> {
  let outcome = false;
  await act(async () => {
    outcome = await action();
  });
  return outcome;
}

/** Runs one of the hook's void controls — `setFilters`, `retry`, `clearFilters` — inside `act`. */
async function performVoid(effect: () => void): Promise<void> {
  await act(async () => {
    effect();
  });
}

/** The identifiers of a list, in the order it was given, for order- and membership-based assertions. */
function idsOf(tasks: readonly Task[]): string[] {
  return tasks.map((task) => task.id);
}

describe('the first load', () => {
  it('reports that the list is loading until the server answers', async () => {
    const { result } = renderTasks();

    expect(result.current.status).toBe('loading');
    expect(result.current.tasks).toEqual([]);

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
  });

  it('asks the server for the default filters and shows the list it returns', async () => {
    const first = makeTask({ id: TASK_ID });
    const second = makeTask({ id: OTHER_TASK_ID });
    const { result } = await renderReady([first, second]);

    expect(api.listTasks).toHaveBeenLastCalledWith(DEFAULT_FILTERS);
    expect(result.current.filters).toEqual(DEFAULT_FILTERS);
    expect(result.current.tasks).toEqual([first, second]);
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBeNull();
  });

  it.each([
    { label: 'a 500 from the server', failure: () => serverFailure() },
    { label: 'a request that never reached the server', failure: () => offlineFailure() },
  ])('reports a retryable failure for $label', async ({ failure }) => {
    api.listTasks.mockImplementation(() => Promise.reject(failure()));
    const { result } = renderTasks();

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error).toEqual(expect.any(String));
    expect(result.current.error).not.toEqual('');
    expect(result.current.tasks).toEqual([]);
  });

  it('retries with the filters that are active, not the defaults', async () => {
    api.listTasks.mockImplementation(() => Promise.reject(serverFailure()));
    const { result } = renderTasks();
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    await performVoid(() => result.current.setFilters(ACTIVE_FILTERS));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    const reloaded = [makeTask({ id: TASK_ID })];
    serverTasks = reloaded;
    api.listTasks.mockImplementation(() => Promise.resolve([...serverTasks]));

    await performVoid(() => result.current.retry());

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(api.listTasks).toHaveBeenLastCalledWith(ACTIVE_FILTERS);
    expect(result.current.tasks).toEqual(reloaded);
  });
});

/**
 * One of the hook's four mutations, described so the same five properties can be asserted of each:
 * the client method it calls and with what, that a success resolves `true` and refetches with the
 * active filters, that a rejection resolves `false` and leaves the list alone, and whether a 404
 * from it can mean the task disappeared.
 */
interface MutationCase {
  /** Named in the test titles. */
  readonly action: string;
  /** Performs the hook action for the task under test. */
  readonly invoke: (actions: UseTasksResult, taskId: string) => Promise<boolean>;
  /** Arms the client method to reject with the given failure. */
  readonly reject: (client: FakeTaskApi, failure: ApiError) => void;
  /** The arguments the client method must have been last called with. */
  readonly expectedArgs: (taskId: string) => unknown[];
  /** The client mock to assert that call on, passed straight to `expect`. */
  readonly mock: (client: FakeTaskApi) => unknown;
  /** Whether a 404 from this action means the named task has disappeared from the server. */
  readonly tracksMissingTask: boolean;
}

/** The four mutations, each with a success, a rejection and — for three of them — a 404 case. */
const MUTATIONS: readonly MutationCase[] = [
  {
    action: 'createTask',
    invoke: (actions) => actions.createTask(CREATE_INPUT),
    reject: (client, failure) => {
      client.createTask.mockRejectedValue(failure);
    },
    expectedArgs: () => [CREATE_INPUT],
    mock: (client) => client.createTask,
    // A create names no existing task, so a 404 from it can never mean a task disappeared.
    tracksMissingTask: false,
  },
  {
    action: 'updateTask',
    invoke: (actions, taskId) => actions.updateTask(taskId, UPDATE_PATCH),
    reject: (client, failure) => {
      client.updateTask.mockRejectedValue(failure);
    },
    expectedArgs: (taskId) => [taskId, UPDATE_PATCH],
    mock: (client) => client.updateTask,
    tracksMissingTask: true,
  },
  {
    action: 'toggleTask',
    invoke: (actions, taskId) => actions.toggleTask(taskId, true),
    reject: (client, failure) => {
      client.toggleTask.mockRejectedValue(failure);
    },
    expectedArgs: (taskId) => [taskId, true],
    mock: (client) => client.toggleTask,
    tracksMissingTask: true,
  },
  {
    action: 'deleteTask',
    invoke: (actions, taskId) => actions.deleteTask(taskId),
    reject: (client, failure) => {
      client.deleteTask.mockRejectedValue(failure);
    },
    expectedArgs: (taskId) => [taskId],
    mock: (client) => client.deleteTask,
    tracksMissingTask: true,
  },
];

/** The three mutations whose task can turn out to be gone: everything but a create. */
const MISSING_TASK_MUTATIONS = MUTATIONS.filter((mutation) => mutation.tracksMissingTask);

describe('a mutation that succeeds', () => {
  describe.each(MUTATIONS)('$action', (mutation) => {
    it('calls the client, refetches with the active filters and shows what the server returned', async () => {
      const { result } = await renderReady([makeTask({ id: TASK_ID })]);
      await performVoid(() => result.current.setFilters(ACTIVE_FILTERS));
      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      const before = listCalls();
      const refetched = [makeTask({ id: TASK_ID, title: 'From the server' })];
      serverTasks = refetched;

      const outcome = await performAction(() => mutation.invoke(result.current, TASK_ID));

      expect(outcome).toBe(true);
      expect(mutation.mock(api)).toHaveBeenLastCalledWith(...mutation.expectedArgs(TASK_ID));
      await expectRefetchedSince(before);
      // The refetch carries the filters that are active, not the ones a list starts with.
      expect(api.listTasks).toHaveBeenLastCalledWith(ACTIVE_FILTERS);
      expect(result.current.tasks).toEqual(refetched);
      expect(result.current.notice).toBeNull();
      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
    });
  });

  it('refetches with the default filters when none were changed', async () => {
    const { result } = await renderReady([makeTask({ id: TASK_ID })]);
    const before = listCalls();

    const outcome = await performAction(() => result.current.createTask(CREATE_INPUT));

    expect(outcome).toBe(true);
    await expectRefetchedSince(before);
    expect(api.listTasks).toHaveBeenLastCalledWith(DEFAULT_FILTERS);
  });

  it('reopens a completed task through the pair of arguments the client takes', async () => {
    const completed = makeTask({ id: TASK_ID, completed: true });
    const { result } = await renderReady([completed]);

    const outcome = await performAction(() => result.current.toggleTask(TASK_ID, false));

    expect(outcome).toBe(true);
    expect(api.toggleTask).toHaveBeenLastCalledWith(TASK_ID, false);
  });
});

describe('a mutation the server rejects', () => {
  describe.each(MUTATIONS)('$action', (mutation) => {
    it('resolves false, leaves the list untouched and starts no refetch', async () => {
      const list = [makeTask({ id: TASK_ID }), makeTask({ id: OTHER_TASK_ID })];
      const { result } = await renderReady(list);
      mutation.reject(api, serverFailure());
      const before = listCalls();

      const outcome = await performAction(() => mutation.invoke(result.current, TASK_ID));

      // The rejection is caught rather than escaping: that is what the `false` reports.
      expect(outcome).toBe(false);
      await act(async () => {
        await Promise.resolve();
      });
      expect(listCalls()).toBe(before);
      expect(result.current.status).toBe('ready');
      expect(result.current.tasks).toEqual(list);
      expect(result.current.error).toBeNull();
      expect(result.current.notice).toBeNull();
    });
  });
});

/**
 * The detail a rejected request carries and the `Promise<boolean>` result cannot: the server's own
 * message and the field map that places each of its entries beside the control it names. The caller
 * that awaited the action reads it from `readActionFailure`, which is what `App.tsx` does before it
 * re-throws it to the form that submitted the request.
 */
describe('the failure a rejected action leaves for its caller', () => {
  it('reports the rejection, with its message and field map, once the action resolves false', async () => {
    const { result } = await renderReady([makeTask({ id: TASK_ID })]);
    const failure = fieldRejection();
    api.createTask.mockRejectedValue(failure);

    expect(result.current.readActionFailure()).toBeNull();

    const outcome = await performAction(() => result.current.createTask(CREATE_INPUT));

    expect(outcome).toBe(false);
    const reported = failureFrom(result.current.readActionFailure());
    expect(reported).toBe(failure);
    expect(reported.status).toBe(400);
    expect(reported.message).toBe('Request validation failed');
    expect(reported.fields).toEqual(REJECTED_FIELDS);
  });

  it('reports the newest rejection, and nothing once an action succeeds', async () => {
    const { result } = await renderReady([makeTask({ id: TASK_ID })]);
    const refusedCreate = fieldRejection();
    const refusedSave = makeApiError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      fields: { title: TITLE_REQUIRED_MESSAGE },
    });

    api.createTask.mockRejectedValueOnce(refusedCreate);
    await performAction(() => result.current.createTask(CREATE_INPUT));
    expect(failureFrom(result.current.readActionFailure()).fields).toEqual(REJECTED_FIELDS);

    api.updateTask.mockRejectedValueOnce(refusedSave);
    await performAction(() => result.current.updateTask(TASK_ID, UPDATE_PATCH));

    const newest = failureFrom(result.current.readActionFailure());
    expect(newest).toBe(refusedSave);
    expect(newest.fields).toEqual({ title: TITLE_REQUIRED_MESSAGE });

    const outcome = await performAction(() => result.current.createTask(CREATE_INPUT));

    expect(outcome).toBe(true);
    expect(result.current.readActionFailure()).toBeNull();
  });

  it('holds nothing while the next attempt is still in flight', async () => {
    const { result } = await renderReady([]);
    api.createTask.mockRejectedValueOnce(fieldRejection());
    await performAction(() => result.current.createTask(CREATE_INPUT));
    expect(result.current.readActionFailure()).not.toBeNull();

    // The next attempt is held open, so the channel can be read while that attempt is unfinished.
    // It must describe the newest attempt rather than the rejection the previous one left behind,
    // so a failure the user has already been shown is never reported as a later attempt's own.
    const held: { answer: (() => void) | null } = { answer: null };
    api.createTask.mockImplementation(
      () =>
        new Promise<Task>((resolve) => {
          held.answer = () => {
            resolve(makeTask({ id: TASK_ID }));
          };
        }),
    );

    let attempt: Promise<boolean> | null = null;
    await act(async () => {
      attempt = result.current.createTask(CREATE_INPUT);
    });

    expect(result.current.readActionFailure()).toBeNull();

    const answer = held.answer;
    if (answer === null) {
      throw new Error('The held create never started.');
    }

    await act(async () => {
      answer();
      await attempt;
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.readActionFailure()).toBeNull();
  });
});

describe('when the task an action named is already gone', () => {
  describe.each(MISSING_TASK_MUTATIONS)('$action', (mutation) => {
    it('drops the stale task, says so and refetches with the active filters', async () => {
      const kept = makeTask({ id: TASK_ID });
      const gone = makeTask({ id: GONE_TASK_ID });
      const { result } = await renderReady([gone, kept]);
      await performVoid(() => result.current.setFilters(ACTIVE_FILTERS));
      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // The next list answer is held, so the removal below can only be the hook's own.
      holdNextListAnswer();
      mutation.reject(api, missingTaskFailure(gone.id));
      const before = listCalls();

      const outcome = await performAction(() => mutation.invoke(result.current, gone.id));

      expect(outcome).toBe(false);
      expect(idsOf(result.current.tasks)).not.toContain(gone.id);
      expect(idsOf(result.current.tasks)).toContain(kept.id);
      expect(result.current.notice).toBe(MISSING_TASK_NOTICE);
      await expectRefetchedSince(before);
      expect(api.listTasks).toHaveBeenLastCalledWith(ACTIVE_FILTERS);

      // Once the server answers, its list wins — in its own order and including what it still holds.
      await releaseListAnswer([kept, gone]);
      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
      expect(idsOf(result.current.tasks)).toEqual([kept.id, gone.id]);
    });
  });

  it('keeps the notice when the filters change afterwards', async () => {
    const kept = makeTask({ id: TASK_ID });
    const gone = makeTask({ id: GONE_TASK_ID });
    const { result } = await renderReady([gone, kept]);
    api.toggleTask.mockRejectedValue(missingTaskFailure(gone.id));

    const outcome = await performAction(() => result.current.toggleTask(gone.id, true));

    expect(outcome).toBe(false);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.notice).toBe(MISSING_TASK_NOTICE);

    serverTasks = [kept];
    await performVoid(() => result.current.setFilters(ACTIVE_FILTERS));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.notice).toBe(MISSING_TASK_NOTICE);
  });

  it('clears the notice once a later action succeeds', async () => {
    const kept = makeTask({ id: TASK_ID });
    const gone = makeTask({ id: GONE_TASK_ID });
    const { result } = await renderReady([gone, kept]);
    api.deleteTask.mockRejectedValueOnce(missingTaskFailure(gone.id));

    await performAction(() => result.current.deleteTask(gone.id));
    expect(result.current.notice).toBe(MISSING_TASK_NOTICE);

    const outcome = await performAction(() => result.current.toggleTask(kept.id, true));

    expect(outcome).toBe(true);
    expect(result.current.notice).toBeNull();
  });

  it('does not treat a 404 from a create as a disappearance', async () => {
    const existing = makeTask({ id: TASK_ID });
    const { result } = await renderReady([existing]);
    api.createTask.mockRejectedValue(missingTaskFailure('00000000-0000-4000-8000-999999999999'));
    const before = listCalls();

    const outcome = await performAction(() => result.current.createTask(CREATE_INPUT));

    expect(outcome).toBe(false);
    expect(result.current.tasks).toEqual([existing]);
    expect(result.current.notice).toBeNull();
    expect(listCalls()).toBe(before);
  });
});

describe('the filters', () => {
  it('starts at the defaults', async () => {
    const { result } = await renderReady([]);

    expect(result.current.filters).toEqual(DEFAULT_FILTERS);
  });

  it('applies the whole set from setFilters and refetches with it', async () => {
    const { result } = await renderReady([makeTask({ id: TASK_ID })]);
    const before = listCalls();

    await performVoid(() => result.current.setFilters(ACTIVE_FILTERS));

    expect(result.current.filters).toEqual(ACTIVE_FILTERS);
    await expectRefetchedSince(before);
    expect(api.listTasks).toHaveBeenLastCalledWith(ACTIVE_FILTERS);
  });

  it('calls no mutation method when the filters change', async () => {
    const { result } = await renderReady([]);

    await performVoid(() => result.current.setFilters(ACTIVE_FILTERS));

    expect(api.createTask).not.toHaveBeenCalled();
    expect(api.updateTask).not.toHaveBeenCalled();
    expect(api.toggleTask).not.toHaveBeenCalled();
    expect(api.deleteTask).not.toHaveBeenCalled();
  });

  it('restores the defaults from clearFilters and refetches with them', async () => {
    const { result } = await renderReady([makeTask({ id: TASK_ID })]);
    await performVoid(() => result.current.setFilters(ACTIVE_FILTERS));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const before = listCalls();

    await performVoid(() => result.current.clearFilters());

    expect(result.current.filters).toEqual(DEFAULT_FILTERS);
    await expectRefetchedSince(before);
    expect(api.listTasks).toHaveBeenLastCalledWith(DEFAULT_FILTERS);
  });

  it('refetches even when clearFilters changes nothing', async () => {
    const { result } = await renderReady([makeTask({ id: TASK_ID })]);
    const before = listCalls();

    await performVoid(() => result.current.clearFilters());

    expect(result.current.filters).toEqual(DEFAULT_FILTERS);
    await expectRefetchedSince(before);
  });

  it('shows the server list in its own order whatever the filters say', async () => {
    const completed = makeTask({ id: TASK_ID, completed: true, priority: 'low' });
    const open = makeTask({ id: OTHER_TASK_ID, priority: 'high', dueDate: '2026-03-01' });
    const { result } = await renderReady([completed, open]);

    await performVoid(() => result.current.setFilters(ACTIVE_FILTERS));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // Nothing is filtered or reordered here: both tasks stay, in the order the server returned them.
    expect(result.current.tasks).toEqual([completed, open]);
  });
});

describe('what the list shows', () => {
  it('does not add a created task before the refetch answers', async () => {
    const existing = makeTask({ id: TASK_ID });
    const { result } = await renderReady([existing]);

    holdNextListAnswer();
    const before = listCalls();

    const outcome = await performAction(() => result.current.createTask(CREATE_INPUT));

    expect(outcome).toBe(true);
    await expectRefetchedSince(before);
    expect(idsOf(result.current.tasks)).toEqual([existing.id]);

    await releaseListAnswer([existing]);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(idsOf(result.current.tasks)).toEqual([existing.id]);
  });

  it('does not remove a deleted task before the refetch answers', async () => {
    const first = makeTask({ id: TASK_ID });
    const second = makeTask({ id: OTHER_TASK_ID });
    const { result } = await renderReady([first, second]);

    holdNextListAnswer();
    const before = listCalls();

    const outcome = await performAction(() => result.current.deleteTask(first.id));

    expect(outcome).toBe(true);
    await expectRefetchedSince(before);
    expect(idsOf(result.current.tasks)).toEqual([first.id, second.id]);

    await releaseListAnswer([second]);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(idsOf(result.current.tasks)).toEqual([second.id]);
  });

  it('keeps the timestamps the server sent', async () => {
    const task = makeTask({ id: TASK_ID });
    const { result } = await renderReady([task]);

    // The patch's own resolved value differs from the list; the list must show the refetch's task.
    api.updateTask.mockResolvedValue(
      makeTask({ id: TASK_ID, title: 'Renamed task', updatedAt: UPDATED_AT }),
    );
    const refetched = makeTask({
      id: TASK_ID,
      title: 'Renamed task',
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    serverTasks = [refetched];

    const outcome = await performAction(() => result.current.updateTask(TASK_ID, UPDATE_PATCH));

    expect(outcome).toBe(true);
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.tasks).toEqual([refetched]);
    expect(result.current.tasks.map((shown) => shown.updatedAt)).toEqual([UPDATED_AT]);
  });

  it('reaches the server only through the client it was handed', async () => {
    const { result } = await renderReady([makeTask({ id: TASK_ID })]);

    const outcome = await performAction(() => result.current.createTask(CREATE_INPUT));

    expect(outcome).toBe(true);
    expect(api.createTask).toHaveBeenCalled();
    expect(api.listTasks).toHaveBeenCalled();
  });
});

