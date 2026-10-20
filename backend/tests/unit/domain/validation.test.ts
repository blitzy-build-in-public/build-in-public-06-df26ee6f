/**
 * Unit suite for the domain's field rules: every rule of the validation contract and the exact
 * message each rule produces.
 *
 * Those message strings are the contract rather than incidental wording — the HTTP layer returns
 * them in a field-error map and the interface renders each one verbatim beside the control it
 * belongs to — so every assertion here pins a literal string, the `200` and `2000` of the two
 * length messages included. Interpolating a bound would let a sentence the interface shows drift
 * away from the sentence this suite agrees to.
 *
 * The domain is pure, so no fixture module, clock substitute or database takes part. Every date is
 * a fixed literal, because no rule consults the current date: a past due date is as valid as any
 * other, and the leap-year cases below are arithmetic rather than wall-clock behaviour.
 */
import { describe, it, expect } from 'vitest';

import {
  FIELD_MESSAGES,
  isReadOnlyField,
  isValidCalendarDate,
  isValidPriority,
  normalizeDescription,
  normalizeTitle,
  validateNewTask,
  validatePatch,
} from '../../../src/domain/validation.js';
import type { FieldErrors } from '../../../src/domain/validation.js';
import {
  DEFAULT_PRIORITY,
  DESCRIPTION_MAX_LENGTH,
  TASK_PRIORITIES,
  TITLE_MAX_LENGTH,
} from '../../../src/domain/task.js';
import type { NewTaskInput, TaskPatch } from '../../../src/domain/task.js';

/** The longest title the rule accepts, taken from the entity so the bound is stated once. */
const atTitleMax = 'a'.repeat(TITLE_MAX_LENGTH);
/** One character past it: the title the acceptance criterion for a 201-character title rejects. */
const overTitleMax = 'a'.repeat(TITLE_MAX_LENGTH + 1);
/** Both padded with spaces, so the bound is proved to apply after trimming rather than before. */
const paddedAtTitleMax = `  ${atTitleMax}  `;
const paddedOverTitleMax = `  ${overTitleMax}  `;
/** Whitespace only and longer than the bound: it trims to nothing, so it is missing, not long. */
const blankTitleOverMax = ' '.repeat(TITLE_MAX_LENGTH + 5);

const atDescriptionMax = 'd'.repeat(DESCRIPTION_MAX_LENGTH);
const overDescriptionMax = 'd'.repeat(DESCRIPTION_MAX_LENGTH + 1);
const paddedAtDescriptionMax = `  ${atDescriptionMax}  `;
const paddedOverDescriptionMax = `  ${overDescriptionMax}  `;

/** A title that satisfies its rule, used wherever the field under test is a different one. */
const validTitle = 'Buy milk';
/** A plausible identifier and instant, for the fields the system owns. */
const suppliedId = '9c8f5b1e-6f2a-4a1d-9c77-2f0b1d3e4a55';
const suppliedTimestamp = '2026-02-01T09:15:00.000Z';

/**
 * Asserts the exact field map a create body produces.
 *
 * The whole map is compared, so each case proves its message and that no other key was invented.
 */
function expectNewTaskErrors(input: NewTaskInput, expected: FieldErrors): void {
  expect(validateNewTask(input)).toEqual(expected);
}

/** Asserts the exact field map a patch body produces, against the validator's own return value. */
function expectPatchErrors(patch: TaskPatch, expected: FieldErrors): void {
  expect(validatePatch(patch)).toEqual(expected);
}

/**
 * A request body exactly as the JSON text arrives.
 *
 * `JSON.parse` creates every key it reads as an own property, `__proto__` included, which no object
 * literal can express: `{ __proto__: … }` sets the object's prototype instead of creating a key, so
 * the validator would never be handed the name under test.
 *
 * @param json The body text, as a client sends it.
 * @returns The parsed body, carrying exactly the JSON object's own keys.
 */
function parseBody(json: string): Record<string, unknown> {
  return JSON.parse(json);
}

describe('validateNewTask', () => {
  it('accepts a fully valid task and reports nothing at all', () => {
    const errors = validateNewTask({
      title: validTitle,
      description: 'Two litres',
      priority: 'high',
      dueDate: '2026-02-14',
    });

    expect(errors).toStrictEqual({});
  });

  const acceptedInputs: { name: string; input: NewTaskInput }[] = [
    { name: 'a title alone', input: { title: validTitle } },
    { name: 'an empty description', input: { title: validTitle, description: '' } },
    { name: 'a whitespace-only description', input: { title: validTitle, description: '   ' } },
    { name: 'an explicit null due date', input: { title: validTitle, dueDate: null } },
    { name: 'a title of exactly the maximum length', input: { title: atTitleMax } },
    { name: 'a maximum-length title surrounded by spaces', input: { title: paddedAtTitleMax } },
    {
      name: 'a description of exactly the maximum length',
      input: { title: validTitle, description: atDescriptionMax },
    },
    {
      name: 'a maximum-length description surrounded by spaces',
      input: { title: validTitle, description: paddedAtDescriptionMax },
    },
  ];

  it.each(acceptedInputs)('accepts $name', ({ input }) => {
    expectNewTaskErrors(input, {});
  });

  it.each(TASK_PRIORITIES)('accepts the %s priority', (priority) => {
    expectNewTaskErrors({ title: validTitle, priority }, {});
  });

  describe('the title rule', () => {
    const missingTitles: { name: string; input: NewTaskInput }[] = [
      { name: 'an empty body', input: {} },
      { name: 'an absent title', input: { description: 'Two litres' } },
      { name: 'an empty title', input: { title: '' } },
      { name: 'a whitespace-only title', input: { title: '   ' } },
      { name: 'a title of tabs and newlines only', input: { title: ' \t\n ' } },
      {
        name: 'a whitespace-only title longer than the maximum',
        input: { title: blankTitleOverMax },
      },
    ];

    // Trimming precedes the bound, which is what makes the whitespace-only case missing rather
    // than long: length is measured on what a reader would actually see.
    it.each(missingTitles)('requires a title given $name', ({ input }) => {
      expectNewTaskErrors(input, { title: 'Title is required' });
    });

    // Presence rather than truthiness decides which rule a supplied title meets: a key that is
    // present with a value of another kind is the not-a-string message, while an absent key or one
    // that trims away is the required-title message. `null` and `undefined` are such values.
    const nonStringTitles: { name: string; value: unknown }[] = [
      { name: 'null', value: null },
      { name: 'undefined', value: undefined },
      { name: 'a number', value: 3 },
      { name: 'an object', value: {} },
      { name: 'an array', value: ['Buy milk'] },
      { name: 'a boolean', value: true },
    ];

    it.each(nonStringTitles)('reports a title of $name as not a string', ({ value }) => {
      expectNewTaskErrors({ title: value }, { title: 'Title must be a string' });
    });

    it('rejects a title that is one character over the maximum', () => {
      expect(overTitleMax).toHaveLength(TITLE_MAX_LENGTH + 1);
      expectNewTaskErrors({ title: overTitleMax }, { title: 'Title must be 200 characters or fewer' });
    });

    it('rejects a title that only exceeds the maximum once it is trimmed', () => {
      expectNewTaskErrors(
        { title: paddedOverTitleMax },
        { title: 'Title must be 200 characters or fewer' },
      );
    });

    /**
     * The bound counts the characters a reader sees, so a character outside the basic plane counts
     * once even though a surrogate pair stores it in two UTF-16 code units. Each case states its own
     * width in code units and asserts it, so the pair proves which unit the bound uses.
     */
    const astralTitles: {
      name: string;
      title: string;
      codeUnits: number;
      expected: FieldErrors;
    }[] = [
      {
        name: 'accepts a title of 200 astral characters',
        title: '🎉'.repeat(TITLE_MAX_LENGTH),
        codeUnits: TITLE_MAX_LENGTH * 2,
        expected: {},
      },
      {
        name: 'rejects a title of 201 astral characters',
        title: '🎉'.repeat(TITLE_MAX_LENGTH + 1),
        codeUnits: (TITLE_MAX_LENGTH + 1) * 2,
        expected: { title: 'Title must be 200 characters or fewer' },
      },
    ];

    it.each(astralTitles)('$name', ({ title, codeUnits, expected }) => {
      expect(title).toHaveLength(codeUnits);
      expectNewTaskErrors({ title }, expected);
    });
  });

  describe('the description rule', () => {
    const nonStringDescriptions: { name: string; value: unknown }[] = [
      { name: 'null', value: null },
      { name: 'a number', value: 3 },
      { name: 'an object', value: {} },
      { name: 'a boolean', value: true },
    ];

    it.each(nonStringDescriptions)('reports a description of $name as not a string', ({ value }) => {
      expectNewTaskErrors(
        { title: validTitle, description: value },
        { description: 'Description must be a string' },
      );
    });

    it('rejects a description one character over the maximum', () => {
      expect(overDescriptionMax).toHaveLength(DESCRIPTION_MAX_LENGTH + 1);
      expectNewTaskErrors(
        { title: validTitle, description: overDescriptionMax },
        { description: 'Description must be 2000 characters or fewer' },
      );
    });

    it('rejects a description that only exceeds the maximum once it is trimmed', () => {
      expectNewTaskErrors(
        { title: validTitle, description: paddedOverDescriptionMax },
        { description: 'Description must be 2000 characters or fewer' },
      );
    });

    /** The description half of the code-point bound, measured the same way as the title's. */
    const astralDescriptions: {
      name: string;
      description: string;
      codeUnits: number;
      expected: FieldErrors;
    }[] = [
      {
        name: 'accepts a description of 2000 astral characters',
        description: '🎉'.repeat(DESCRIPTION_MAX_LENGTH),
        codeUnits: DESCRIPTION_MAX_LENGTH * 2,
        expected: {},
      },
      {
        name: 'rejects a description of 2001 astral characters',
        description: '🎉'.repeat(DESCRIPTION_MAX_LENGTH + 1),
        codeUnits: (DESCRIPTION_MAX_LENGTH + 1) * 2,
        expected: { description: 'Description must be 2000 characters or fewer' },
      },
    ];

    it.each(astralDescriptions)('$name', ({ description, codeUnits, expected }) => {
      expect(description).toHaveLength(codeUnits);
      expectNewTaskErrors({ title: validTitle, description }, expected);
    });
  });

  describe('the priority rule', () => {
    const unsupportedPriorities: { name: string; value: unknown }[] = [
      { name: 'a level that does not exist', value: 'urgent' },
      { name: 'a level in another case', value: 'HIGH' },
      { name: 'an empty string', value: '' },
      { name: 'null', value: null },
      { name: 'undefined', value: undefined },
      { name: 'a number', value: 3 },
      { name: 'an object', value: {} },
      { name: 'a boolean', value: true },
    ];

    it.each(unsupportedPriorities)('reports $name as an unsupported priority', ({ value }) => {
      expectNewTaskErrors(
        { title: validTitle, priority: value },
        { priority: 'Priority must be one of: low, medium, high' },
      );
    });
  });

  describe('the due date rule', () => {
    const acceptedDates: string[] = [
      '2026-02-14',
      '2024-02-29',
      '2028-02-29',
      '1999-12-31',
      '2026-01-01',
      '2026-12-31',
    ];

    it.each(acceptedDates)('accepts the calendar date %s, however far in the past', (dueDate) => {
      expectNewTaskErrors({ title: validTitle, dueDate }, {});
    });

    const malformedDates: { name: string; value: unknown }[] = [
      { name: 'a single-digit month and day', value: '2026-2-4' },
      { name: 'a day-first order', value: '14-02-2026' },
      { name: 'slashes instead of hyphens', value: '2026/02/14' },
      { name: 'a full ISO timestamp', value: '2026-02-14T00:00:00.000Z' },
      { name: 'digits without separators', value: 20260214 },
      { name: 'an empty string', value: '' },
      { name: 'a boolean', value: true },
    ];

    it.each(malformedDates)('reports $name as a format failure', ({ value }) => {
      expectNewTaskErrors(
        { title: validTitle, dueDate: value },
        { dueDate: 'Due date must be a date in YYYY-MM-DD format' },
      );
    });

    const impossibleDates: string[] = [
      '2026-02-30',
      '2026-13-01',
      '2027-02-29',
      '2026-00-10',
      '2026-04-31',
    ];

    it.each(impossibleDates)('reports the well-shaped %s as no calendar date', (dueDate) => {
      expectNewTaskErrors(
        { title: validTitle, dueDate },
        { dueDate: 'Due date must be a valid calendar date' },
      );
    });
  });

  describe('the completed rule', () => {
    const suppliedOnCreate: { name: string; value: unknown }[] = [
      { name: 'true', value: true },
      { name: 'false', value: false },
      { name: 'null', value: null },
      { name: 'the string "false"', value: 'false' },
    ];

    // A task is always created incomplete, so any supplied value is refused and the message names
    // the rule rather than the kind of value: this single branch covers every form of it.
    it.each(suppliedOnCreate)('rejects a create body supplying completed as $name', ({ value }) => {
      expectNewTaskErrors(
        { title: validTitle, completed: value },
        { completed: 'Completed cannot be set when creating a task' },
      );
    });
  });

  describe('the fields the system owns', () => {
    const readOnlyFields: { name: string; input: NewTaskInput; expected: FieldErrors }[] = [
      {
        name: 'id',
        input: { title: validTitle, id: suppliedId },
        expected: { id: 'id cannot be changed' },
      },
      {
        name: 'createdAt',
        input: { title: validTitle, createdAt: suppliedTimestamp },
        expected: { createdAt: 'createdAt cannot be changed' },
      },
      {
        name: 'updatedAt',
        input: { title: validTitle, updatedAt: suppliedTimestamp },
        expected: { updatedAt: 'updatedAt cannot be changed' },
      },
    ];

    it.each(readOnlyFields)('rejects a supplied $name', ({ input, expected }) => {
      expectNewTaskErrors(input, expected);
    });

    const unknownFields: { name: string; input: NewTaskInput; expected: FieldErrors }[] = [
      {
        name: 'a misspelled property',
        input: { title: validTitle, foo: 1 },
        expected: { foo: 'Unknown field' },
      },
      {
        name: 'a property differing from a known one only in case',
        input: { title: validTitle, Title: 'Buy oat milk' },
        expected: { Title: 'Unknown field' },
      },
      {
        name: 'two unknown properties',
        input: { title: validTitle, foo: 1, bar: null },
        expected: { foo: 'Unknown field', bar: 'Unknown field' },
      },
    ];

    // Keyed by the raw property name the client sent, so a typo is reported against the value it
    // would otherwise have silently discarded.
    it.each(unknownFields)('rejects $name', ({ input, expected }) => {
      expectNewTaskErrors(input, expected);
    });

    /**
     * A property named `__proto__` is the one unknown name that is also an accessor on
     * `Object.prototype`, so it is the name that proves the map stores what a body carries as data.
     * The bodies are parsed rather than written as literals: see {@link parseBody}.
     */
    const protoBodies: { name: string; json: string }[] = [
      {
        name: 'a __proto__ property holding an object',
        json: '{"title":"Buy milk","__proto__":{"polluted":true}}',
      },
      {
        name: 'a __proto__ property holding a string',
        json: '{"title":"Buy milk","__proto__":"polluted"}',
      },
    ];

    it.each(protoBodies)('reports $name under that name, as an own key of the map', ({ json }) => {
      const errors = validateNewTask(parseBody(json));

      expect(Object.keys(errors)).toStrictEqual(['__proto__']);
      expect(errors['__proto__']).toBe('Unknown field');
      // The map stays an ordinary object: had the name reached it as an assignment it would have
      // run the inherited accessor, which stores nothing and, for an object value, replaces this
      // map's prototype with the body's.
      expect(Object.getPrototypeOf(errors)).toBe(Object.prototype);
      // Own and enumerable is what carries the name to the client, which reads it from the field
      // map of the error body.
      expect(JSON.stringify(errors)).toBe('{"__proto__":"Unknown field"}');
    });
  });

  describe('per-field accumulation', () => {
    it('reports every offending field in one body rather than stopping at the first', () => {
      expectNewTaskErrors(
        { title: '', priority: 'urgent' },
        {
          title: 'Title is required',
          priority: 'Priority must be one of: low, medium, high',
        },
      );
    });

    it('reports an offence for each of the fields a compound body gets wrong', () => {
      expectNewTaskErrors(
        {
          title: overTitleMax,
          description: overDescriptionMax,
          priority: 'urgent',
          dueDate: '2026-02-30',
        },
        {
          title: 'Title must be 200 characters or fewer',
          description: 'Description must be 2000 characters or fewer',
          priority: 'Priority must be one of: low, medium, high',
          dueDate: 'Due date must be a valid calendar date',
        },
      );
    });

    it('reports a supplied completion and an unknown property alongside the field offences', () => {
      expectNewTaskErrors(
        { title: '   ', completed: true, notes: 'later' },
        {
          title: 'Title is required',
          completed: 'Completed cannot be set when creating a task',
          notes: 'Unknown field',
        },
      );
    });
  });
});

describe('validatePatch', () => {
  // An empty patch is a body-level failure the HTTP layer raises, because no field name could
  // carry it. Nothing is invented here, and this case holds that boundary in place.
  it('reports nothing for an empty patch, inventing no field key of its own', () => {
    const errors = validatePatch({});

    expect(errors).toStrictEqual({});
  });

  const acceptedPatches: { name: string; patch: TaskPatch }[] = [
    { name: 'a title alone', patch: { title: 'Buy oat milk' } },
    { name: 'a description', patch: { description: 'One litre' } },
    { name: 'an empty description, which clears it', patch: { description: '' } },
    { name: 'a whitespace-only description, which also clears it', patch: { description: '  ' } },
    { name: 'a due date', patch: { dueDate: '2026-02-14' } },
    { name: 'an explicit null due date, which clears it', patch: { dueDate: null } },
    { name: 'completion', patch: { completed: true } },
    { name: 'reopening', patch: { completed: false } },
    {
      name: 'every field at once',
      patch: {
        title: 'Buy oat milk',
        description: '',
        priority: 'high',
        dueDate: null,
        completed: true,
      },
    },
  ];

  it.each(acceptedPatches)('accepts a patch carrying $name', ({ patch }) => {
    expectPatchErrors(patch, {});
  });

  it.each(TASK_PRIORITIES)('accepts the %s priority', (priority) => {
    expectPatchErrors({ priority }, {});
  });

  it('does not require a title, so a patch that omits one is valid', () => {
    expectPatchErrors({ description: 'One litre' }, {});
  });

  describe('the title rule', () => {
    const missingTitles: { name: string; patch: TaskPatch }[] = [
      { name: 'an empty title', patch: { title: '' } },
      { name: 'a whitespace-only title', patch: { title: '   ' } },
      { name: 'a title of only a tab and a newline', patch: { title: '\t\n' } },
    ];

    it.each(missingTitles)('requires a title that is present but empty: $name', ({ patch }) => {
      expectPatchErrors(patch, { title: 'Title is required' });
    });

    const nonStringTitles: { name: string; value: unknown }[] = [
      { name: 'null', value: null },
      { name: 'a number', value: 3 },
      { name: 'an object', value: {} },
      { name: 'a boolean', value: true },
    ];

    it.each(nonStringTitles)('reports a title of $name as not a string', ({ value }) => {
      expectPatchErrors({ title: value }, { title: 'Title must be a string' });
    });

    it('reports the same messages as a create body for a title that is too long', () => {
      expectPatchErrors({ title: overTitleMax }, { title: 'Title must be 200 characters or fewer' });
      expectPatchErrors(
        { title: paddedOverTitleMax },
        { title: 'Title must be 200 characters or fewer' },
      );
    });
  });

  describe('the description rule', () => {
    const nonStringDescriptions: { name: string; value: unknown }[] = [
      { name: 'null', value: null },
      { name: 'a number', value: 3 },
      { name: 'an object', value: {} },
    ];

    it.each(nonStringDescriptions)('reports a description of $name as not a string', ({ value }) => {
      expectPatchErrors(
        { description: value },
        { description: 'Description must be a string' },
      );
    });

    it('reports the same message as a create body for a description that is too long', () => {
      expectPatchErrors(
        { description: overDescriptionMax },
        { description: 'Description must be 2000 characters or fewer' },
      );
      expectPatchErrors(
        { description: paddedOverDescriptionMax },
        { description: 'Description must be 2000 characters or fewer' },
      );
    });
  });

  describe('the priority and due date rules', () => {
    const unsupportedPriorities: { name: string; value: unknown }[] = [
      { name: 'a level that does not exist', value: 'urgent' },
      { name: 'an empty string', value: '' },
      { name: 'null', value: null },
      { name: 'a number', value: 3 },
    ];

    it.each(unsupportedPriorities)('reports $name as an unsupported priority', ({ value }) => {
      expectPatchErrors({ priority: value }, { priority: 'Priority must be one of: low, medium, high' });
    });

    const malformedDates: { name: string; value: unknown }[] = [
      { name: 'a single-digit month and day', value: '2026-2-4' },
      { name: 'a full ISO timestamp', value: '2026-02-14T00:00:00.000Z' },
      { name: 'digits without separators', value: 20260214 },
    ];

    it.each(malformedDates)('reports $name as a format failure', ({ value }) => {
      expectPatchErrors(
        { dueDate: value },
        { dueDate: 'Due date must be a date in YYYY-MM-DD format' },
      );
    });

    const impossibleDates: string[] = ['2026-02-30', '2026-13-01', '2026-04-31'];

    it.each(impossibleDates)('reports the well-shaped %s as no calendar date', (dueDate) => {
      expectPatchErrors({ dueDate }, { dueDate: 'Due date must be a valid calendar date' });
    });
  });

  describe('the completed rule', () => {
    const nonBooleans: { name: string; value: unknown }[] = [
      { name: 'the string "true"', value: 'true' },
      { name: 'the string "false"', value: 'false' },
      { name: 'a number', value: 1 },
      { name: 'zero', value: 0 },
      { name: 'null', value: null },
      { name: 'undefined', value: undefined },
    ];

    it.each(nonBooleans)('reports a completion of $name as not a boolean', ({ value }) => {
      expectPatchErrors({ completed: value }, { completed: 'Completed must be true or false' });
    });
  });

  describe('the fields the system owns', () => {
    const readOnlyFields: { name: string; patch: TaskPatch; expected: FieldErrors }[] = [
      { name: 'id', patch: { id: suppliedId }, expected: { id: 'id cannot be changed' } },
      {
        name: 'createdAt',
        patch: { createdAt: suppliedTimestamp },
        expected: { createdAt: 'createdAt cannot be changed' },
      },
      {
        name: 'updatedAt',
        patch: { updatedAt: suppliedTimestamp },
        expected: { updatedAt: 'updatedAt cannot be changed' },
      },
    ];

    it.each(readOnlyFields)('rejects a supplied $name', ({ patch, expected }) => {
      expectPatchErrors(patch, expected);
    });

    it('rejects an unknown property with the same message as a create body', () => {
      expectPatchErrors({ title: 'Buy oat milk', foo: 1 }, { foo: 'Unknown field' });
    });

    /**
     * The same name reached from a patch body, where the offending key is the whole body: the map
     * holds that one own key and nothing else.
     */
    const protoPatches: { name: string; json: string }[] = [
      {
        name: 'a lone __proto__ property holding an object',
        json: '{"__proto__":{"polluted":true}}',
      },
      { name: 'a lone __proto__ property holding a string', json: '{"__proto__":"polluted"}' },
    ];

    it.each(protoPatches)('rejects $name under its own name', ({ json }) => {
      const errors = validatePatch(parseBody(json));

      expect(Object.keys(errors)).toStrictEqual(['__proto__']);
      expect(errors['__proto__']).toBe('Unknown field');
      expect(Object.getPrototypeOf(errors)).toBe(Object.prototype);
    });
  });

  describe('per-field accumulation', () => {
    it('reports every offending field in one patch rather than stopping at the first', () => {
      expectPatchErrors(
        { title: '', priority: 'urgent' },
        {
          title: 'Title is required',
          priority: 'Priority must be one of: low, medium, high',
        },
      );
    });

    it('reports an offence for each of the fields a compound patch gets wrong', () => {
      expectPatchErrors(
        {
          title: overTitleMax,
          description: overDescriptionMax,
          dueDate: '2026-02-30',
          completed: 'yes',
        },
        {
          title: 'Title must be 200 characters or fewer',
          description: 'Description must be 2000 characters or fewer',
          dueDate: 'Due date must be a valid calendar date',
          completed: 'Completed must be true or false',
        },
      );
    });
  });
});

describe('isValidPriority', () => {
  it.each(TASK_PRIORITIES)('accepts the level %s', (priority) => {
    expect(isValidPriority(priority)).toBe(true);
  });

  it('accepts the level a task takes when none is supplied', () => {
    expect(isValidPriority(DEFAULT_PRIORITY)).toBe(true);
  });

  const unsupported: { name: string; value: unknown }[] = [
    { name: 'a level that does not exist', value: 'urgent' },
    { name: 'a level in another case', value: 'HIGH' },
    { name: 'a level padded with spaces', value: ' high ' },
    { name: 'an empty string', value: '' },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'a number', value: 3 },
    { name: 'an object', value: {} },
    { name: 'a boolean', value: true },
  ];

  it.each(unsupported)('refuses $name', ({ value }) => {
    expect(isValidPriority(value)).toBe(false);
  });
});

describe('isValidCalendarDate', () => {
  const accepted: string[] = [
    '2026-02-14',
    '2024-02-29',
    '2028-02-29',
    '1999-12-31',
    '2026-02-28',
    '2026-01-01',
    '2026-12-31',
  ];

  it.each(accepted)('accepts %s', (value) => {
    expect(isValidCalendarDate(value)).toBe(true);
  });

  const refused: { name: string; value: unknown }[] = [
    { name: 'a day no February holds', value: '2026-02-30' },
    { name: 'a month past December', value: '2026-13-01' },
    { name: 'a month before January', value: '2026-00-10' },
    { name: 'a day no April holds', value: '2026-04-31' },
    { name: 'a leap day in a common year', value: '2026-02-29' },
    { name: 'a leap day in a non-leap century year', value: '1900-02-29' },
    { name: 'a single-digit month and day', value: '2026-2-4' },
    { name: 'a value that is not a date at all', value: 'abc' },
    { name: 'an empty string', value: '' },
    { name: 'a full ISO timestamp', value: '2026-02-14T00:00:00.000Z' },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'a number', value: 20260214 },
    { name: 'an object', value: {} },
  ];

  it.each(refused)('refuses $name', ({ value }) => {
    expect(isValidCalendarDate(value)).toBe(false);
  });

  it('refuses well-shaped dates a date parser would roll over instead of rejecting', () => {
    // `new Date('2026-02-30')` becomes 2 March and `new Date('2026-13-01')` becomes 1 January of
    // the next year, so a check built on parsing would accept both of these.
    expect(isValidCalendarDate('2026-02-30')).toBe(false);
    expect(isValidCalendarDate('2026-13-01')).toBe(false);
  });

  it('holds a leap day to the Gregorian year rule', () => {
    expect(isValidCalendarDate('2024-02-29')).toBe(true);
    expect(isValidCalendarDate('2028-02-29')).toBe(true);
    expect(isValidCalendarDate('2000-02-29')).toBe(true);
    expect(isValidCalendarDate('2027-02-29')).toBe(false);
    expect(isValidCalendarDate('1900-02-29')).toBe(false);
  });

  it('holds the last day of each month to that month\u2019s length', () => {
    expect(isValidCalendarDate('2026-04-30')).toBe(true);
    expect(isValidCalendarDate('2026-06-30')).toBe(true);
    expect(isValidCalendarDate('2026-09-30')).toBe(true);
    expect(isValidCalendarDate('2026-11-30')).toBe(true);
    expect(isValidCalendarDate('2026-01-31')).toBe(true);
    expect(isValidCalendarDate('2026-06-31')).toBe(false);
    expect(isValidCalendarDate('2026-09-31')).toBe(false);
    expect(isValidCalendarDate('2026-11-31')).toBe(false);
    expect(isValidCalendarDate('2026-01-32')).toBe(false);
  });

  it('refuses a day of zero in every month', () => {
    expect(isValidCalendarDate('2026-01-00')).toBe(false);
    expect(isValidCalendarDate('2026-02-00')).toBe(false);
    expect(isValidCalendarDate('2026-04-00')).toBe(false);
  });
});

describe('normalizeTitle and normalizeDescription', () => {
  it('trims a title', () => {
    expect(normalizeTitle('  Buy milk  ')).toBe('Buy milk');
    expect(normalizeTitle('Buy milk')).toBe('Buy milk');
  });

  it('trims a description', () => {
    expect(normalizeDescription('  Two litres  ')).toBe('Two litres');
    expect(normalizeDescription('Two litres')).toBe('Two litres');
  });

  it('reduces a whitespace-only description to the empty string', () => {
    expect(normalizeDescription('   ')).toBe('');
  });
});

describe('isReadOnlyField', () => {
  it.each(['id', 'createdAt', 'updatedAt'])('narrows %s as owned by the system', (name) => {
    expect(isReadOnlyField(name)).toBe(true);
  });

  it.each([
    'title',
    'description',
    'priority',
    'dueDate',
    'completed',
    'readOnly',
    'ID',
    '',
    'toString',
    'constructor',
  ])('leaves %s to its own field rule', (name) => {
    // The last two guard against a membership test that walks the prototype chain instead of the
    // record's own keys, which would make an inherited name look like a field the system owns.
    expect(isReadOnlyField(name)).toBe(false);
  });
});

/**
 * Every string `value` holds, at any depth, so that a message nested inside a sub-record is
 * collected too. The read-only messages are exactly such a case: a shallow walk would miss them.
 */
function collectMessages(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.values(value as Record<string, unknown>).flatMap(collectMessages);
}

describe('FIELD_MESSAGES drift guard', () => {
  /**
   * One validator call per message the two validators can produce, provoked inside the guard itself
   * rather than read from the cases above it: the guard then holds when it is the only case selected,
   * and it needs no shared state and no ordering.
   *
   * The create side supplies the required, over-long and non-string title, the over-long and
   * non-string description, the unsupported priority, the malformed due date, the well-shaped due
   * date that is no calendar date and the completion supplied on a create; the patch side supplies
   * the completion that is not a boolean, the unknown property and the three read-only names.
   */
  const provokingCalls: { name: string; validate: () => FieldErrors }[] = [
    { name: 'a missing title', validate: () => validateNewTask({}) },
    { name: 'an over-long title', validate: () => validateNewTask({ title: overTitleMax }) },
    { name: 'a title of another kind', validate: () => validateNewTask({ title: 3 }) },
    {
      name: 'an over-long description',
      validate: () => validateNewTask({ title: validTitle, description: overDescriptionMax }),
    },
    {
      name: 'a description of another kind',
      validate: () => validateNewTask({ title: validTitle, description: null }),
    },
    {
      name: 'an unsupported priority',
      validate: () => validateNewTask({ title: validTitle, priority: 'urgent' }),
    },
    {
      name: 'a malformed due date',
      validate: () => validateNewTask({ title: validTitle, dueDate: '2026-2-4' }),
    },
    {
      name: 'a well-shaped due date that is no calendar date',
      validate: () => validateNewTask({ title: validTitle, dueDate: '2026-02-30' }),
    },
    {
      name: 'a completion supplied on a create',
      validate: () => validateNewTask({ title: validTitle, completed: true }),
    },
    {
      name: 'a completion that is not a boolean',
      validate: () => validatePatch({ completed: 'yes' }),
    },
    { name: 'an unknown property', validate: () => validatePatch({ colour: 'red' }) },
    { name: 'a supplied id', validate: () => validatePatch({ id: suppliedId }) },
    { name: 'a supplied createdAt', validate: () => validatePatch({ createdAt: suppliedTimestamp }) },
    { name: 'a supplied updatedAt', validate: () => validatePatch({ updatedAt: suppliedTimestamp }) },
  ];

  it('holds every message the validators returned', () => {
    const declared = collectMessages(FIELD_MESSAGES);

    const observed = new Set<string>();
    for (const { validate } of provokingCalls) {
      for (const message of Object.values(validate())) {
        observed.add(message);
      }
    }

    // The calls returned messages, so the check below cannot pass on an empty list.
    expect(observed.size).toBeGreaterThan(0);

    // One direction only: the record may hold a message no domain validator returns, because the
    // empty patch is rejected upstream, but a validator may never invent a message of its own.
    const undeclared = [...observed].filter((message) => !declared.includes(message));
    expect(undeclared).toEqual([]);
  });
});
