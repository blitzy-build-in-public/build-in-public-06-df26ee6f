/**
 * Integration suite for the lifecycle of the two resources `composeApp` opens: the SQLite handle and
 * the HTTP application built around it.
 *
 * Why this needs a suite of its own. Every other integration suite composes the application and
 * releases it on the success path, so the two paths below are invisible to them: a composition that
 * throws after the handle is already open, and a release whose own server close rejects. Neither is
 * reported when it goes wrong — the process simply keeps the database file, its `-wal` sidecar and
 * its `-shm` sidecar open for the rest of its life — so each case is asserted on what the process
 * holds rather than on what `composeApp` returns. All three cases drive the whole composed path
 * through `composeApp`, over a database file reserved by `../support/tempDatabase.ts`: never the
 * developer's `backend/data/todo.db`, never the end-to-end suite's file, and never another clone's.
 *
 * How a leaked handle is observed. `/proc/self/fd` is the only view a test has of the handles the
 * SQLite driver holds: it reports no count of them, but the file and the two sidecars a WAL
 * connection keeps open are each an open descriptor under the directory the file lives in. The probe
 * below reads exactly the descriptors whose target lies inside this suite's own directory, and it is
 * shown to see a live handle before an empty result is relied on, so a zero means "released" rather
 * than "never seen". The case that cannot show a live handle first — the composition that fails — is
 * shown to have opened one by the database file the opener left behind instead. Every case skips
 * itself where `/proc/self/fd` is absent, so a platform without it reports no failure.
 *
 * Deliberately not here: the handle a refused `openDatabase` opens and must release itself
 * (`migrations.test.ts` owns the opener), what any route answers (the HTTP suites own that), and the
 * process-level behaviour of `main` — the restart suite spawns the real entry point twice for it.
 */
import { existsSync, readdirSync, readlinkSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { composeApp, type AppConfig } from '../../src/main.js';
import { createTempDatabase, type TempDatabase } from '../support/tempDatabase.js';

/**
 * A level the application logger cannot be built with, so `buildApp` throws.
 *
 * Pino rejects an unknown level while the Fastify instance is constructed, before any route is
 * registered, which is what makes it the injection that fails the composition after the database
 * handle is already open.
 */
const UNBUILDABLE_LOG_LEVEL = 'not-a-level';

/**
 * The message the deliberately throwing `onClose` hook carries.
 *
 * One no other part of the system can produce, so a rejection whose message is this one is
 * unmistakably the failed server close, and a rejection that lost it is visibly not that failure.
 */
const CLOSE_FAILURE_MESSAGE = 'the application close failed — must reach the caller, not be swallowed';

/**
 * The temporary locations the cases reserved, so the teardown can remove them however each case
 * ended: a failed assertion must not leave a directory holding a `-wal` and a `-shm` sidecar behind.
 */
const reservedTemps: TempDatabase[] = [];

/**
 * Reserves a temporary directory for the opener to create its database file in.
 *
 * The directory is tracked before anything is opened inside it, so a directory whose open throws is
 * still removed by the teardown. The file itself is deliberately not created here: `openDatabase`
 * creates it, which is what lets one case use its existence as proof that the composition reached
 * the opener before it failed.
 */
function reserveTempDatabase(prefix: string): TempDatabase {
  const temp = createTempDatabase(prefix);
  reservedTemps.push(temp);

  return temp;
}

/**
 * The configuration the cases compose with.
 *
 * `port` is inert because `composeApp` does not listen, so no socket is bound and this suite can run
 * beside every other suite on the host; the database path is the file the case just reserved.
 */
function composedConfig(databasePath: string, logLevel: string): AppConfig {
  return { port: 0, databasePath, logLevel };
}

/**
 * Every open descriptor of this process whose target lies inside `directory`.
 *
 * An entry that vanishes between listing the directory and reading it resolves to nothing and is
 * skipped, since `/proc/self/fd` is read while the process opens and closes descriptors of its own
 * (the readdir call itself is one). The one case that cannot first show a live handle treats the
 * database file's presence as its control; the other two assert a non-zero count while their
 * application is live.
 */
function openTargetsUnder(directory: string): string[] {
  const targets: string[] = [];

  for (const entry of readdirSync('/proc/self/fd')) {
    let target: string;

    try {
      target = readlinkSync(`/proc/self/fd/${entry}`);
    } catch {
      continue;
    }

    if (target.startsWith(directory)) {
      targets.push(target);
    }
  }

  return targets;
}

/** Removes every temporary directory this suite reserved, whatever the case did with it. */
afterEach(() => {
  for (const temp of reservedTemps.splice(0)) {
    // `cleanup` is idempotent, so a case that already removed its directory is a silent no-op here.
    temp.cleanup();
  }
});

describe('the resource lifecycle of the composition root', () => {
  it.skipIf(!existsSync('/proc/self/fd'))(
    'releases the database handle when building the HTTP application fails',
    async () => {
      const temp = reserveTempDatabase('todo-compose-failure-');

      // The composition fails on the unbuildable logger level, inside `buildApp` and therefore after
      // the handle was opened. The rejection is the framework's own, unchanged: releasing the handle
      // must not replace it.
      await expect(
        composeApp(composedConfig(temp.path, UNBUILDABLE_LOG_LEVEL)),
      ).rejects.toThrow(UNBUILDABLE_LOG_LEVEL);

      // The control this case can have: the opener ran and created the file, so a zero count below
      // says the handle on it was released rather than that the composition failed before opening.
      expect(existsSync(temp.path)).toBe(true);
      expect(openTargetsUnder(temp.directory)).toStrictEqual([]);
    },
  );

  it.skipIf(!existsSync('/proc/self/fd'))(
    'releases the database handle when the application close rejects, and still rejects',
    async () => {
      const temp = reserveTempDatabase('todo-compose-close-');
      const composed = await composeApp(composedConfig(temp.path, 'silent'));
      await composed.app.ready();

      // The control: the file, its `-wal` and its `-shm` are all visible while the application is
      // live, so the empty result asserted after the close means the three were released.
      expect(openTargetsUnder(temp.directory).length).toBeGreaterThan(0);

      // A server whose close fails is what the finding describes. The hook is registered after the
      // application is ready because that is when a real server would carry its own close steps.
      composed.app.addHook('onClose', async () => {
        throw new Error(CLOSE_FAILURE_MESSAGE);
      });

      // The failure reaches the caller — nothing here swallows it — and yet the handle is gone.
      await expect(composed.close()).rejects.toThrow(CLOSE_FAILURE_MESSAGE);
      expect(openTargetsUnder(temp.directory)).toStrictEqual([]);
    },
  );

  it.skipIf(!existsSync('/proc/self/fd'))(
    'releases both resources on the ordinary path, so a successful close is unchanged',
    async () => {
      const temp = reserveTempDatabase('todo-compose-release-');
      const composed = await composeApp(composedConfig(temp.path, 'silent'));
      await composed.app.ready();

      expect(openTargetsUnder(temp.directory).length).toBeGreaterThan(0);

      // The ordinary release resolves, and it releases just as completely as the failing one above:
      // the guard on the close must not have turned a clean shutdown into a partial one.
      await expect(composed.close()).resolves.toBeUndefined();
      expect(openTargetsUnder(temp.directory)).toStrictEqual([]);

      // The file itself is still there — only the descriptors are gone — so the zero above cannot be
      // an artifact of the directory having been removed underneath the probe.
      expect(existsSync(temp.path)).toBe(true);
    },
  );
});
