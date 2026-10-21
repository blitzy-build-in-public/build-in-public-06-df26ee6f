import type { Clock } from '../../src/application/Clock.js';

/**
 * The instant a clock is frozen at when the caller supplies none. A fixed past
 * moment, so every suite that constructs a clock without an argument starts from
 * the same reproducible time instead of whatever the machine's clock reads.
 */
const DEFAULT_INSTANT = '2026-02-01T09:15:00.000Z';

/**
 * An injectable, fully deterministic {@link Clock} for tests.
 *
 * It satisfies the application layer's time port — so it is accepted unchanged by
 * every use case that takes its clock as `{ clock }` — and adds the two mutations
 * a test needs to move time itself: `set` pins the instant to a new value, and
 * `advance` steps the frozen instant forward. Nothing here reads the system
 * clock, which is what makes a `createdAt` / `updatedAt` assertion reproducible
 * rather than dependent on when the suite happened to run.
 */
export interface FixedClock extends Clock {
  /** Replaces the frozen instant with the given `Date` or date string. */
  set(instant: Date | string): void;
  /** Moves the frozen instant forward by `milliseconds`; a negative value moves it back. */
  advance(milliseconds: number): void;
}

/**
 * Creates an independent clock frozen at `instant`.
 *
 * The instant defaults to `2026-02-01T09:15:00.000Z`, a fixed past moment, so a
 * caller that omits the argument knows exactly what it froze at and can compare
 * a task's timestamps against it. No mutable state lives at module scope, so two
 * clocks never share an instant and `createFixedClock()` called twice yields two
 * independent clocks.
 *
 * `now()` returns a **fresh** `Date` on every call. Handing back a shared object
 * would let one caller's `setTime` move the instant for every other caller in the
 * same test, so the frozen instant can only be changed through `set` and
 * `advance`.
 *
 * The clock never consults the wall clock — not to resolve a missing argument and
 * not in `now()` — which is what makes the `createdAt` / `updatedAt` assertion of
 * the update use case deterministic.
 *
 * @param instant The instant to freeze at, as a `Date` or a date string. Throws
 * if the value does not parse to a real time, rather than letting an
 * "Invalid Date" reach a use case's `toISOString()` call.
 */
export function createFixedClock(instant: Date | string = DEFAULT_INSTANT): FixedClock {
  // Held as epoch milliseconds rather than as a `Date`: it lets `now()` build a
  // fresh object on every call, makes `advance` a plain arithmetic step, and
  // keeps the mutable state inside this closure where no other clock can see it.
  let currentMs = toMillis(instant);

  return {
    now(): Date {
      return new Date(currentMs);
    },
    set(nextInstant: Date | string): void {
      // Routed through the same normaliser as the factory, so a value accepted at
      // construction is accepted here and a bad one fails the same way.
      currentMs = toMillis(nextInstant);
    },
    advance(milliseconds: number): void {
      currentMs += milliseconds;
    },
  };
}

/**
 * Normalises a `Date` or date string to epoch milliseconds.
 *
 * The guard is stricter than a test fixture strictly needs: without it a mistyped
 * instant would surface as a `RangeError` from `toISOString()` deep inside a use
 * case, naming neither the clock nor the value that was wrong. It is the only
 * validation this fixture performs.
 */
function toMillis(instant: Date | string): number {
  const ms = typeof instant === 'string' ? new Date(instant).getTime() : instant.getTime();

  if (!Number.isFinite(ms)) {
    throw new Error(`invalid clock instant: ${String(instant)}`);
  }

  return ms;
}
