/**
 * The time port: the core's only source of the current instant.
 *
 * Nothing in `src/domain` or `src/application` reads the system clock directly —
 * `Date.now()` and `new Date()` are not called there — so every timestamp a use
 * case writes arrives through this port. Injecting it is what lets a test pin
 * the instant and assert that `createdAt` never moves while `updatedAt` does.
 *
 * This module declares the port and nothing else. The implementation used by the
 * running process lives in `src/infrastructure/systemClock.ts`; the
 * deterministic substitute the tests use lives in the test support directory.
 */
export interface Clock {
  /**
   * Returns the current instant.
   *
   * A caller reads the clock once per operation and does not cache the result
   * across operations: the instant a task is created in serves as both its
   * `createdAt` and its `updatedAt`, so those two are identical on a new task.
   *
   * The result is the instant itself rather than a formatted string — the
   * domain's transitions take a `Date` and serialise it with `toISOString()` —
   * so no formatting, locale or time-zone decision is taken here.
   *
   * Implementations must be free of side effects: reading the time writes
   * nothing, logs nothing and touches no storage. A test implementation returns
   * the same instant on every call until the test changes it, while the
   * production implementation returns the system time.
   */
  now(): Date;
}
