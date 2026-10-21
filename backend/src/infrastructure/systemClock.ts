import type { Clock } from '../application/Clock.js';

/**
 * The production `Clock`: the time source the running process injects into every use case that stamps
 * a timestamp.
 *
 * A `const` object rather than a class or a factory, because it holds no state — the composition root
 * builds it once and hands the same instance to `CreateTask`, `UpdateTask` and `ToggleTaskCompletion`.
 * The deterministic clock the tests inject in its place lives in the test support directory, and
 * nothing in the domain or application layers reads the system time directly, so exchanging one for
 * the other changes no layer above this one.
 *
 * `now()` builds a new `Date` on every call rather than returning a cached one: a shared instance
 * would let one caller's mutation reach the next caller, and each operation reads the clock for
 * itself so that two operations in flight can observe different instants.
 */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};
