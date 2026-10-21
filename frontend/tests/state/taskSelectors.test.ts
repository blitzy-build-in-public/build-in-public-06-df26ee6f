/**
 * Unit suite for the frontend's derived presentation rules, `frontend/src/state/taskSelectors.ts`.
 *
 * It pins the four values no component re-derives: today's local calendar date as a zero-padded
 * `YYYY-MM-DD` string, whether a task reads as overdue, the word a priority level displays, and the
 * style modifier the priority tag is keyed by. Every case is a call over an explicit fixed date or a
 * clock pinned per case, so nothing depends on the machine's date, the machine's locale or the
 * machine's timezone: the suite renders nothing, imports no client, replaces no `fetch`, and opens
 * no socket, no process and no database.
 *
 * The two local-versus-UTC cases pin the process timezone with `vi.stubEnv('TZ', ...)` and restore
 * it afterwards. Without that pin a host already running at UTC would let a UTC-derived
 * implementation pass a suite whose whole point is that the rule is local.
 */

import {
  isOverdue,
  priorityLabel,
  priorityModifier,
  todayLocalIsoDate,
} from '../../src/state/taskSelectors';
import type { Task, TaskPriority } from '../../src/api/types';

import { makeTask } from '../support/helpers';

/** The fixed "today" every case is measured against: midday, so no host timezone moves the day. */
const TODAY = new Date(2026, 1, 14, 12, 0, 0);

/** Today's local date, and its neighbours, as the hand-built strings the suite asserts against. */
const TODAY_ISO = '2026-02-14';
const YESTERDAY_ISO = '2026-02-13';
const TOMORROW_ISO = '2026-02-15';

/** The shape every value `todayLocalIsoDate` returns must have. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A zone west of Greenwich, where a late local evening already falls on the next UTC day. */
const WEST_OF_GREENWICH = 'America/Los_Angeles';

/** A zone east of Greenwich, where an early local morning still falls on the previous UTC day. */
const EAST_OF_GREENWICH = 'Asia/Tokyo';

/** The three priority levels, in the order the suite reports them. */
const PRIORITY_LEVELS: TaskPriority[] = ['low', 'medium', 'high'];

/**
 * A task for the overdue rule, built through the shared `makeTask` fixture so every fixture still
 * carries all eight fields the wire contract defines, with the two the rule reads named at the call
 * site and the remainder left at their defaults.
 *
 * @param dueDate - The task's `YYYY-MM-DD` due date, or `null` for a task that has none.
 * @param completed - Whether the task is complete; `false` unless a case says otherwise.
 * @returns The task, ready to hand to `isOverdue`.
 */
function taskDue(dueDate: string | null, completed = false): Task {
  return makeTask({ dueDate, completed });
}

describe('taskSelectors', () => {
  afterEach(() => {
    // Both are restored per case, so a clock or a timezone one case pins never reaches the next.
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('todayLocalIsoDate', () => {
    /**
     * Each case pairs a local instant with the `YYYY-MM-DD` string it must render. The expected
     * values are hand-built literals rather than anything a locale-aware formatter produced, so the
     * suite asserts the documented format instead of agreeing with the host's locale.
     */
    const LOCAL_DATE_CASES: ReadonlyArray<{ scenario: string; today: Date; expected: string }> = [
      {
        scenario: 'renders a two-digit month and day unchanged',
        today: new Date(2026, 1, 14),
        expected: TODAY_ISO,
      },
      {
        scenario: 'zero-pads a single-digit month',
        today: new Date(2026, 0, 5),
        expected: '2026-01-05',
      },
      {
        scenario: 'zero-pads a single-digit day',
        today: new Date(2026, 8, 9),
        expected: '2026-09-09',
      },
      {
        scenario: 'zero-pads a single-digit month and day together',
        today: new Date(2026, 0, 1),
        expected: '2026-01-01',
      },
      {
        scenario: 'keeps a two-digit day in a two-digit month',
        today: new Date(2026, 10, 25),
        expected: '2026-11-25',
      },
      {
        scenario: 'renders the last day of a year',
        today: new Date(2026, 11, 31),
        expected: '2026-12-31',
      },
      {
        scenario: 'renders the first day of the next year',
        today: new Date(2027, 0, 1),
        expected: '2027-01-01',
      },
      {
        scenario: 'renders a leap day',
        today: new Date(2024, 1, 29),
        expected: '2024-02-29',
      },
    ];

    it.each(LOCAL_DATE_CASES)('$scenario', ({ today, expected }) => {
      expect(todayLocalIsoDate(today)).toMatch(ISO_DATE_PATTERN);
      expect(todayLocalIsoDate(today)).toBe(expected);
    });

    it('takes the default argument from the clock, so a caller may omit the date', () => {
      vi.useFakeTimers();
      vi.setSystemTime(TODAY);

      expect(todayLocalIsoDate()).toBe(TODAY_ISO);
    });

    it('reads a late local evening west of Greenwich as that local day, not the UTC day', () => {
      // The timezone is set before the instant is built, so 22:30 means 22:30 in that zone.
      vi.stubEnv('TZ', WEST_OF_GREENWICH);
      const lateEvening = new Date(2026, 1, 14, 22, 30);
      vi.useFakeTimers();
      vi.setSystemTime(lateEvening);

      // The instant is 2026-02-15T06:30Z, while the local calendar day is still the fourteenth.
      expect(todayLocalIsoDate()).toBe(TODAY_ISO);
    });

    it('reads an early local morning east of Greenwich as that local day, not the UTC day', () => {
      vi.stubEnv('TZ', EAST_OF_GREENWICH);
      const earlyMorning = new Date(2026, 1, 14, 0, 5);
      vi.useFakeTimers();
      vi.setSystemTime(earlyMorning);

      // The instant is 2026-02-13T15:05Z, while the local calendar day is already the fourteenth.
      expect(todayLocalIsoDate()).toBe(TODAY_ISO);
    });
  });

  describe('isOverdue', () => {
    /**
     * Every combination the overdue rule turns on — a date behind, on and ahead of today, a
     * completed task on each of those, and a task with no due date at all — measured against the
     * same fixed today.
     */
    const OVERDUE_CASES: ReadonlyArray<{
      scenario: string;
      dueDate: string | null;
      completed: boolean;
      expected: boolean;
    }> = [
      {
        scenario: 'flags an open task due yesterday',
        dueDate: YESTERDAY_ISO,
        completed: false,
        expected: true,
      },
      {
        scenario: 'flags an open task due long ago',
        dueDate: '2020-01-01',
        completed: false,
        expected: true,
      },
      {
        scenario: 'does not flag an open task due today',
        dueDate: TODAY_ISO,
        completed: false,
        expected: false,
      },
      {
        scenario: 'does not flag an open task due tomorrow',
        dueDate: TOMORROW_ISO,
        completed: false,
        expected: false,
      },
      {
        scenario: 'does not flag an open task due far in the future',
        dueDate: '2027-01-01',
        completed: false,
        expected: false,
      },
      {
        scenario: 'never flags a completed task, however long past its due date',
        dueDate: '2020-01-01',
        completed: true,
        expected: false,
      },
      {
        scenario: 'never flags a completed task due yesterday',
        dueDate: YESTERDAY_ISO,
        completed: true,
        expected: false,
      },
      {
        scenario: 'never flags a completed task due today',
        dueDate: TODAY_ISO,
        completed: true,
        expected: false,
      },
      {
        scenario: 'never flags an open task with no due date',
        dueDate: null,
        completed: false,
        expected: false,
      },
      {
        scenario: 'never flags a completed task with no due date',
        dueDate: null,
        completed: true,
        expected: false,
      },
    ];

    it.each(OVERDUE_CASES)('$scenario', ({ dueDate, completed, expected }) => {
      expect(isOverdue(taskDue(dueDate, completed), TODAY)).toBe(expected);
    });

    it('takes today from the clock when no date is passed, keeping due today not overdue', () => {
      vi.useFakeTimers();
      vi.setSystemTime(TODAY);

      expect(isOverdue(taskDue(TODAY_ISO))).toBe(false);
      expect(isOverdue(taskDue(YESTERDAY_ISO))).toBe(true);
    });

    it('compares the calendar day alone, so the time of day never changes the verdict', () => {
      const startOfDay = new Date(2026, 1, 14, 0, 0, 0, 0);
      const endOfDay = new Date(2026, 1, 14, 23, 59, 59, 999);

      expect(isOverdue(taskDue(TODAY_ISO), startOfDay)).toBe(false);
      expect(isOverdue(taskDue(TODAY_ISO), endOfDay)).toBe(false);
      expect(isOverdue(taskDue(YESTERDAY_ISO), startOfDay)).toBe(true);
      expect(isOverdue(taskDue(YESTERDAY_ISO), endOfDay)).toBe(true);
    });

    it('compares across a month boundary by the dates themselves', () => {
      const firstOfFebruary = new Date(2026, 1, 1);
      const lastOfJanuary = new Date(2026, 0, 31);

      expect(isOverdue(taskDue('2026-01-31'), firstOfFebruary)).toBe(true);
      expect(isOverdue(taskDue('2026-02-01'), firstOfFebruary)).toBe(false);
      expect(isOverdue(taskDue('2026-02-01'), lastOfJanuary)).toBe(false);
    });

    it('does not flag a task due today when the local evening is tomorrow in UTC', () => {
      vi.stubEnv('TZ', WEST_OF_GREENWICH);
      const lateEvening = new Date(2026, 1, 14, 22, 30);
      vi.useFakeTimers();
      vi.setSystemTime(lateEvening);

      // A UTC-derived today would already be the fifteenth and would flag a task due the fourteenth.
      expect(isOverdue(taskDue(TODAY_ISO))).toBe(false);
    });

    it('flags a task due yesterday when the local morning is still yesterday in UTC', () => {
      vi.stubEnv('TZ', EAST_OF_GREENWICH);
      const earlyMorning = new Date(2026, 1, 14, 0, 5);
      vi.useFakeTimers();
      vi.setSystemTime(earlyMorning);

      // A UTC-derived today would still be the thirteenth, which is not before the task's due date.
      expect(isOverdue(taskDue(YESTERDAY_ISO))).toBe(true);
    });

    it('leaves the task it is given untouched, since the flag is presentation only', () => {
      const task = taskDue(YESTERDAY_ISO);
      const before = { ...task };

      expect(isOverdue(task, TODAY)).toBe(true);
      expect(task).toEqual(before);
    });
  });

  describe('priorityLabel', () => {
    /** The word each level displays with, as declared: the level's own name, capitalised. */
    const LABEL_CASES: ReadonlyArray<{ priority: TaskPriority; label: string }> = [
      { priority: 'low', label: 'Low' },
      { priority: 'medium', label: 'Medium' },
      { priority: 'high', label: 'High' },
    ];

    it.each(LABEL_CASES)('renders $priority as the word $label', ({ priority, label }) => {
      expect(priorityLabel(priority)).toBe(label);
      // The word is what carries the meaning, so it is never the raw level the value itself spells.
      expect(priorityLabel(priority)).not.toBe(priority);
    });

    it('gives the three levels three different words', () => {
      const labels = PRIORITY_LEVELS.map((level) => priorityLabel(level));

      expect(new Set(labels).size).toBe(PRIORITY_LEVELS.length);
      for (const label of labels) {
        expect(label.length).toBeGreaterThan(0);
      }
    });
  });

  describe('priorityModifier', () => {
    /**
     * The three class names the priority tag indexes its own stylesheet with. They are asserted as
     * literals because they are a three-file contract: a transformed variant would leave the tag
     * unstyled without failing any other check.
     */
    const MODIFIER_CASES: ReadonlyArray<{ priority: TaskPriority; modifier: string }> = [
      { priority: 'low', modifier: 'low' },
      { priority: 'medium', modifier: 'medium' },
      { priority: 'high', modifier: 'high' },
    ];

    it.each(MODIFIER_CASES)('keys $priority by the class name $modifier', ({ priority, modifier }) => {
      expect(priorityModifier(priority)).toBe(modifier);
    });

    it('gives the three levels three different, non-empty modifiers', () => {
      const modifiers = PRIORITY_LEVELS.map((level) => priorityModifier(level));

      expect(new Set(modifiers).size).toBe(PRIORITY_LEVELS.length);
      for (const modifier of modifiers) {
        expect(modifier.length).toBeGreaterThan(0);
      }
    });

    /**
     * Pins a read as a function of the level alone rather than of the calls around it: every
     * expected value comes from `MODIFIER_CASES`, and the second pass reads the three levels in a
     * rotated order, so no level's two reads sit next to each other and an answer that depended on
     * the call history could not satisfy both.
     */
    it('keys each level the same pinned class name on every call, in either order', () => {
      // The same three levels one place to the left, so the two passes never share an order.
      const rotatedCases = [...MODIFIER_CASES.slice(1), ...MODIFIER_CASES.slice(0, 1)];
      const tableOrder = MODIFIER_CASES.map(({ priority }) => priorityModifier(priority));
      const rotatedOrder = rotatedCases.map(({ priority }) => priorityModifier(priority));

      expect(tableOrder).toStrictEqual(MODIFIER_CASES.map(({ modifier }) => modifier));
      expect(rotatedOrder).toStrictEqual(rotatedCases.map(({ modifier }) => modifier));
    });
  });
});
