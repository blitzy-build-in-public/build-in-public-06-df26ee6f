/**
 * Shared test support for the `@todo/frontend` jsdom test layer.
 *
 * Three sibling folders import this module — `tests/api` builds response bodies from its task
 * builder, `tests/state` injects the fake client into the hook and rejects with real `ApiError`s,
 * and `tests/components` renders through its render helper — so the fixtures and the single
 * `ApiError` construction live here rather than being repeated in each suite.
 *
 * It is deliberately not a suite. `frontend/vite.config.ts` collects `tests/**\/*.test.ts(x)`, and a
 * support module named like a suite would be collected and then fail for holding no test: the name
 * `helpers.tsx` is what keeps it out of that set, so it must not be renamed.
 *
 * This project has no user rules to cite — `review_rules` reports none — so nothing here cites one.
 * What governs the file is the request's own constraints: strict TypeScript, no secrets and no
 * external service, and a layer that runs entirely in jsdom. Nothing here opens a socket, spawns a
 * process, reads the filesystem or replaces `fetch`; a suite that stubs the global `fetch` does so
 * itself.
 *
 * Everything here is deterministic: timestamps are fixed literals and task identifiers come from a
 * counter, so a failing assertion reports the same values on every run.
 */

import { render } from '@testing-library/react';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { MockedFunction } from 'vitest';

import { ApiError } from '../../src/api/client';
import type { TaskApi } from '../../src/api/client';
import type { ApiErrorBody, Task } from '../../src/api/types';

/**
 * The failure classes the error contract defines, read off the wire envelope rather than restated,
 * so a fourth class could never be added to `ApiErrorBody` without reaching every call site here.
 */
type ApiErrorCode = ApiErrorBody['error']['code'];

/**
 * The creation moment of every fixture task, and its initial `updatedAt`.
 *
 * A fixed literal, never the wall clock: the plan puts timestamp assertions in the unit layer
 * against a fixed clock, and a fixture that read the current time would make two runs disagree.
 */
const CREATED_AT = '2026-02-01T09:15:00.000Z';

/** The title every fixture task carries until an override replaces it. */
const DEFAULT_TITLE = 'Buy milk';

/**
 * The count of fixture tasks built so far, which is what makes each built task's id distinct.
 *
 * A counter rather than `crypto.randomUUID()`: the sequence has to be reproducible, so a suite that
 * fails reports the same identifiers on every run. It lives at module scope, whose lifetime is one
 * test file, which is all the uniqueness a suite needs.
 */
let builtTaskCount = 0;

/** The next fixture identifier, formatted into the UUID shape the API generates. */
function nextTaskId(): string {
  builtTaskCount += 1;
  return `00000000-0000-4000-8000-${String(builtTaskCount).padStart(12, '0')}`;
}

/**
 * A displayable sentence for a failure a caller gave no message for, derived from its status with
 * the same wording the client uses for a body it could not read: one short sentence per class of
 * failure, and never anything internal.
 *
 * A status of `0` is the client's spelling of a request that never reached the server, which is why
 * it reads differently from a failure the server answered.
 */
function defaultMessage(status: number): string {
  if (status === 0) {
    return 'The server could not be reached. Check that it is running, then try again.';
  }
  if (status === 400) {
    return 'The request was rejected. Check the values you supplied and try again.';
  }
  if (status === 404) {
    return 'The requested item no longer exists on the server.';
  }
  return 'The server could not complete the request. Try again in a moment.';
}

/**
 * The task API with each of its methods replaced by a mock, which is what a suite arms and asserts
 * on.
 *
 * The mapped type keeps the two in step: each property carries both `TaskApi`'s signature and the
 * mock installed in its place, so a signature change in `api/client.ts` fails `tsc` here rather than
 * a test run, and an instance is assignable to `TaskApi` — which is what lets `useTasks` take it —
 * with no cast.
 */
export type FakeTaskApi = { [K in keyof TaskApi]: MockedFunction<TaskApi[K]> };

/**
 * Builds a fresh fake task API: six `vi.fn()` mocks satisfying `TaskApi`, with no calls recorded
 * and no implementation inherited from any other instance.
 *
 * Every call returns new mocks, so no suite can arm a method and have another suite observe it;
 * a suite that wants a blank mock calls `mockReset()` on the one it holds.
 *
 * Each mock is pre-seeded with the safest value its contract allows, so a suite that forgets to arm
 * a method still reads a well-typed result instead of `undefined`, and every default is replaced by
 * `mockResolvedValue`, `mockResolvedValueOnce` or `mockRejectedValue`:
 *
 * - `listTasks` resolves the empty list, the honest default when no fixture is supplied.
 * - `createTask`, `updateTask` and `toggleTask` resolve a task built from their arguments, so the
 *   resolved value is coherent with the request a suite made.
 * - `deleteTask` resolves nothing, which is what the route's `204` carries.
 * - `getHealth` resolves the liveness body.
 */
export function createFakeTaskApi(): FakeTaskApi {
  const api: FakeTaskApi = {
    listTasks: vi.fn<TaskApi['listTasks']>().mockResolvedValue([]),
    createTask: vi
      .fn<TaskApi['createTask']>()
      .mockImplementation((input) => Promise.resolve(makeTask(input))),
    updateTask: vi
      .fn<TaskApi['updateTask']>()
      .mockImplementation((id, patch) => Promise.resolve(makeTask({ id, ...patch }))),
    toggleTask: vi
      .fn<TaskApi['toggleTask']>()
      .mockImplementation((id, completed) => Promise.resolve(makeTask({ id, completed }))),
    deleteTask: vi.fn<TaskApi['deleteTask']>().mockResolvedValue(undefined),
    getHealth: vi.fn<TaskApi['getHealth']>().mockResolvedValue({ status: 'ok' }),
  };

  return api;
}

/**
 * Builds a complete task, with every override applied on top of the defaults.
 *
 * All eight fields are always present, because that is the wire contract: an absent due date is
 * `null` and an empty description is `''`, never a missing key. The defaults are the ones the server
 * applies to a task created with a title alone — `'medium'` priority, no due date, not completed,
 * description empty.
 *
 * `createdAt` and `updatedAt` are the same fixed instant, matching a task that has not been updated
 * yet, and the identifier is distinct on every call, so a suite that builds several tasks gets
 * distinct list entries and distinct React keys without passing identifiers by hand.
 *
 * @param overrides - The fields to replace; anything omitted keeps its default.
 * @returns A task carrying all eight fields.
 */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: nextTaskId(),
    title: DEFAULT_TITLE,
    description: '',
    priority: 'medium',
    dueDate: null,
    completed: false,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/**
 * Builds the `ApiError` the client raises for one failure — the only place in this test tree where
 * that class is constructed.
 *
 * It has to be the real class and not an object shaped like one, because `useTasks` branches on
 * `failure instanceof ApiError` to decide whether a task has disappeared, and the component suites
 * assert the same way. The arguments are passed in the order `api/client.ts` declares its
 * constructor.
 *
 * @param options - The failure to build.
 * @param options.status - The HTTP status, or `0` for a request that never reached the server.
 * @param options.code - The failure class the envelope carries.
 * @param options.message - The displayable summary; a sentence derived from the status when absent.
 * @param options.fields - Field-level messages; `{}` when the failure belongs to no single field.
 * @returns The failure, ready to be rejected with.
 */
export function makeApiError(options: {
  status: number;
  code: ApiErrorCode;
  message?: string;
  fields?: Record<string, string>;
}): ApiError {
  const { status, code, message, fields = {} } = options;
  return new ApiError(status, code, message ?? defaultMessage(status), fields);
}

/**
 * Renders a piece of UI into the jsdom document, returning Testing Library's result unchanged so
 * `rerender`, `unmount`, `container` and `debug` stay available to the caller.
 *
 * Deliberately thin: it installs no provider and no context, because the screen is composed of
 * components that take everything they need as props, and `test.globals: true` already registers
 * Testing Library's automatic cleanup hook, so a suite needs no unmount bookkeeping.
 *
 * @param ui - The element to render.
 * @param options - Testing Library's render options, passed through untouched.
 * @returns The render result for the rendered element.
 */
export function renderUi(ui: ReactNode, options?: RenderOptions): RenderResult {
  return render(ui, options);
}

/**
 * The queries the component suites assert through, re-exported so a suite has one import site for
 * the render helper and the user-facing queries it asserts with.
 */
export { screen, within } from '@testing-library/react';
