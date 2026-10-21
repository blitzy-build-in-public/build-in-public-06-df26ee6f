/**
 * Unit suite for the create use case, `src/application/CreateTask.ts`.
 *
 * The use case is proved in isolation: its persistence port is satisfied by
 * `InMemoryTaskRepository` and its time port by a clock frozen at a fixed instant, so no Fastify
 * instance, no socket, no SQLite file and no wall clock takes part. That substitution is itself
 * evidence for the acceptance criterion that swapping `SqliteTaskRepository` for an in-memory
 * implementation requires no change to the domain or the application layer — nothing here names
 * a storage mechanism, only the port the use case was constructed with.
 *
 * What it pins: the documented defaults of a title-only create and the server-generated
 * identifier, the trimming that precedes every length rule, an explicit description, priority and
 * due date, an accepted past date, and the fact that the stored entity is exactly the returned
 * one. It then takes one case per rule of the validation contract, each asserting the field-level
 * message the use case surfaces on a `ValidationError` together with the fact that a rejected
 * create stored nothing. The rule messages are literals here because they are the contract: the
 * HTTP layer returns them to the interface, which renders each one verbatim beside its control,
 * while `tests/unit/domain/validation.test.ts` owns the rule-by-rule evidence and the guard that
 * those sentences come from the domain's single message record.
 *
 * It also carries this layer's share of the coverage gate over `src/application/**`.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { CreateTask } from '../../../src/application/CreateTask.js';
import { ValidationError, VALIDATION_ERROR_MESSAGE } from '../../../src/domain/errors.js';
import type { NewTaskInput } from '../../../src/domain/task.js';
import { createFixedClock } from '../../support/fixedClock.js';
import { InMemoryTaskRepository } from '../../support/inMemoryTaskRepository.js';

/** The instant every clock in this suite is frozen at. */
const INSTANT = new Date('2026-02-01T09:15:00.000Z');

/** The same instant as the ISO 8601 string a task carries. */
const INSTANT_ISO = INSTANT.toISOString();

/**
 * The identifier shape a create must produce: a version 4 (random) UUID, whose variant nibble is
 * one of `8`, `9`, `a` or `b`.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The eight field names a stored task always carries. */
const TASK_FIELD_NAMES: readonly string[] = [
  'id',
  'title',
  'description',
  'priority',
  'dueDate',
  'completed',
  'createdAt',
  'updatedAt',
];

/** A title that satisfies its rule, used wherever the field under test is a different one. */
const VALID_TITLE = 'Buy milk';

let repository: InMemoryTaskRepository;
let clock: ReturnType<typeof createFixedClock>;
let createTask: CreateTask;

beforeEach(() => {
  repository = new InMemoryTaskRepository();
  clock = createFixedClock(INSTANT);
  createTask = new CreateTask({ repository, clock });
});

/**
 * Asserts that creating `input` was rejected with the field-level contract, and that the store was
 * left untouched.
 *
 * A rejection is one outcome with five parts — the domain error's class, its machine-readable
 * code, the status the interface must return, its summary and its per-field messages — so every
 * rejection case is asserted the same way and no case can pass by throwing something else.
 *
 * @param input The untrusted create body to submit.
 * @param fields The exact field map the rejection must carry, message by message.
 */
async function expectRejected(input: NewTaskInput, fields: Record<string, string>): Promise<void> {
  const error: unknown = await createTask.execute(input).then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(ValidationError);

  const validationError = error as ValidationError;
  expect(validationError.code).toBe('VALIDATION_ERROR');
  expect(validationError.statusCode).toBe(400);
  expect(validationError.message).toBe(VALIDATION_ERROR_MESSAGE);
  expect(validationError.fields).toEqual(fields);

  // A rejected create is not a partially applied one: nothing reached the port.
  await expect(repository.findAll()).resolves.toEqual([]);
}

describe('CreateTask', () => {
  describe('defaults and successful creation', () => {
    it('creates a task with the documented defaults when only a title is supplied', async () => {
      const task = await createTask.execute({ title: 'Buy milk' });

      expect(task.title).toBe('Buy milk');
      expect(task.description).toBe('');
      expect(task.priority).toBe('medium');
      expect(task.dueDate).toBeNull();
      expect(task.completed).toBe(false);
      expect(task.createdAt).toBe(INSTANT_ISO);
      expect(task.updatedAt).toBe(INSTANT_ISO);
      expect(task.updatedAt).toBe(task.createdAt);
      expect(typeof task.id).toBe('string');

      // A task is never a partial object: the eight fields are all present, always.
      expect(Object.keys(task).sort()).toEqual([...TASK_FIELD_NAMES].sort());
    });

    it('generates a UUIDv4 identifier', async () => {
      const task = await createTask.execute({ title: 'Buy milk' });

      expect(task.id).toMatch(UUID_V4);
    });

    it('yields a distinct identifier on every execution', async () => {
      const first = await createTask.execute({ title: 'Buy milk' });
      const second = await createTask.execute({ title: 'Buy milk' });

      expect(first.id).not.toBe(second.id);
    });

    it('stamps both timestamps from the injected clock and never from the wall clock', async () => {
      clock.set('2030-06-15T12:00:00.000Z');

      const task = await createTask.execute({ title: 'Buy milk' });

      expect(task.createdAt).toBe('2030-06-15T12:00:00.000Z');
      expect(task.updatedAt).toBe('2030-06-15T12:00:00.000Z');
    });

    it('trims the title and the description before storing them', async () => {
      const task = await createTask.execute({
        title: '  Buy milk  ',
        description: '  two litres  ',
      });

      expect(task.title).toBe('Buy milk');
      expect(task.description).toBe('two litres');
    });

    it('honours an explicit description, priority and due date', async () => {
      const task = await createTask.execute({
        title: 'Buy milk',
        description: 'two litres',
        priority: 'high',
        dueDate: '2026-02-14',
      });

      expect(task.description).toBe('two litres');
      expect(task.priority).toBe('high');
      expect(task.dueDate).toBe('2026-02-14');

      // A new task is always created incomplete, whatever else the body carries.
      expect(task.completed).toBe(false);
    });

    it('accepts a past due date', async () => {
      const task = await createTask.execute({ title: 'Buy milk', dueDate: '2020-01-01' });

      expect(task.dueDate).toBe('2020-01-01');
    });

    it('accepts an explicit null due date and stores no due date', async () => {
      const task = await createTask.execute({ title: 'Buy milk', dueDate: null });

      expect(task.dueDate).toBeNull();
    });

    it('accepts an explicit priority of every level', async () => {
      const levels = ['low', 'medium', 'high'] as const;

      for (const priority of levels) {
        const task = await createTask.execute({ title: 'Buy milk', priority });

        expect(task.priority).toBe(priority);
      }
    });

    it('persists exactly the returned entity through the port', async () => {
      const task = await createTask.execute({ title: 'Buy milk' });

      await expect(repository.findAll()).resolves.toEqual([task]);
      await expect(repository.findById(task.id)).resolves.toEqual(task);
    });
  });

  describe('boundaries the rules accept', () => {
    const acceptedInputs: { name: string; input: NewTaskInput }[] = [
      { name: 'a title of exactly the maximum length', input: { title: 'a'.repeat(200) } },
      {
        name: 'a maximum-length title padded with spaces',
        input: { title: `  ${'a'.repeat(200)}  ` },
      },
      {
        name: 'a description of exactly the maximum length',
        input: { title: VALID_TITLE, description: 'd'.repeat(2000) },
      },
      {
        name: 'a maximum-length description padded with spaces',
        input: { title: VALID_TITLE, description: `  ${'d'.repeat(2000)}  ` },
      },
      { name: 'an empty description', input: { title: VALID_TITLE, description: '' } },
      {
        name: 'a whitespace-only description, which trims to the empty one',
        input: { title: VALID_TITLE, description: '   ' },
      },
      { name: 'a leap-day due date in a leap year', input: { title: VALID_TITLE, dueDate: '2024-02-29' } },
      { name: 'the last day of a month', input: { title: VALID_TITLE, dueDate: '2026-01-31' } },
    ];

    it.each(acceptedInputs)('accepts $name', async ({ input }) => {
      const task = await createTask.execute(input);

      // The stored title is the trimmed value of whatever the body carried, and the accepted
      // create is persisted exactly as returned.
      expect(task.title).toBe(String(input['title']).trim());
      await expect(repository.findAll()).resolves.toEqual([task]);
    });
  });

  describe('rejections', () => {
    it('rejects a create with no title', async () => {
      await expectRejected({}, { title: 'Title is required' });
    });

    it('rejects a whitespace-only title, because trimming precedes the required rule', async () => {
      await expectRejected({ title: '   ' }, { title: 'Title is required' });
    });

    it('rejects a title of 201 characters', async () => {
      await expectRejected(
        { title: 'a'.repeat(201) },
        { title: 'Title must be 200 characters or fewer' },
      );
    });

    it('rejects a title that is not a string', async () => {
      await expectRejected({ title: 42 }, { title: 'Title must be a string' });
    });

    it('rejects a title of null', async () => {
      await expectRejected({ title: null }, { title: 'Title must be a string' });
    });

    it('rejects a description of 2001 characters', async () => {
      await expectRejected(
        { title: VALID_TITLE, description: 'd'.repeat(2001) },
        { description: 'Description must be 2000 characters or fewer' },
      );
    });

    it('rejects a description that is not a string, null included', async () => {
      await expectRejected(
        { title: VALID_TITLE, description: null },
        { description: 'Description must be a string' },
      );
    });

    it('rejects an unsupported priority', async () => {
      await expectRejected(
        { title: VALID_TITLE, priority: 'urgent' },
        { priority: 'Priority must be one of: low, medium, high' },
      );
    });

    it('rejects a priority that is not a string', async () => {
      await expectRejected(
        { title: VALID_TITLE, priority: 1 },
        { priority: 'Priority must be one of: low, medium, high' },
      );
    });

    it('rejects a due date that does not match the YYYY-MM-DD shape', async () => {
      await expectRejected(
        { title: VALID_TITLE, dueDate: '14-02-2026' },
        { dueDate: 'Due date must be a date in YYYY-MM-DD format' },
      );
    });

    it('rejects a full ISO timestamp in place of a calendar date', async () => {
      await expectRejected(
        { title: VALID_TITLE, dueDate: '2026-02-14T00:00:00.000Z' },
        { dueDate: 'Due date must be a date in YYYY-MM-DD format' },
      );
    });

    it('rejects a date whose day does not exist in that month', async () => {
      await expectRejected(
        { title: VALID_TITLE, dueDate: '2026-02-30' },
        { dueDate: 'Due date must be a valid calendar date' },
      );
    });

    it('rejects a month outside the calendar', async () => {
      await expectRejected(
        { title: VALID_TITLE, dueDate: '2026-13-01' },
        { dueDate: 'Due date must be a valid calendar date' },
      );
    });

    it('rejects a leap day in a year that has none', async () => {
      await expectRejected(
        { title: VALID_TITLE, dueDate: '2026-02-29' },
        { dueDate: 'Due date must be a valid calendar date' },
      );
    });

    it('rejects completed supplied on create, whichever value it carries', async () => {
      await expectRejected(
        { title: VALID_TITLE, completed: true },
        { completed: 'Completed cannot be set when creating a task' },
      );
      await expectRejected(
        { title: VALID_TITLE, completed: false },
        { completed: 'Completed cannot be set when creating a task' },
      );
    });

    it('rejects the read-only id field', async () => {
      await expectRejected(
        { title: VALID_TITLE, id: '9c8f5b1e-6f2a-4a1d-9c77-2f0b1d3e4a55' },
        { id: 'id cannot be changed' },
      );
    });

    it('rejects the read-only createdAt field', async () => {
      await expectRejected(
        { title: VALID_TITLE, createdAt: INSTANT_ISO },
        { createdAt: 'createdAt cannot be changed' },
      );
    });

    it('rejects the read-only updatedAt field', async () => {
      await expectRejected(
        { title: VALID_TITLE, updatedAt: INSTANT_ISO },
        { updatedAt: 'updatedAt cannot be changed' },
      );
    });

    it('rejects a property the task model does not have, naming the property the client sent', async () => {
      await expectRejected({ title: VALID_TITLE, typo: 'x' }, { typo: 'Unknown field' });
    });

    it('reports every offending field at once, not only the first', async () => {
      await expectRejected(
        { title: '', priority: 'urgent' },
        { title: 'Title is required', priority: 'Priority must be one of: low, medium, high' },
      );
    });

    it('reports one message per rule kind in a single rejection', async () => {
      await expectRejected(
        {
          id: '9c8f5b1e-6f2a-4a1d-9c77-2f0b1d3e4a55',
          title: '   ',
          description: null,
          priority: 'urgent',
          dueDate: '2026-02-30',
          completed: false,
          extra: 1,
        },
        {
          id: 'id cannot be changed',
          title: 'Title is required',
          description: 'Description must be a string',
          priority: 'Priority must be one of: low, medium, high',
          dueDate: 'Due date must be a valid calendar date',
          completed: 'Completed cannot be set when creating a task',
          extra: 'Unknown field',
        },
      );
    });

    /**
     * The same rules as above, driven from a table so that no rule's evidence rests on a single
     * hand-written case and each payload is stated once, next to the field map it must produce.
     */
    const rejectedInputs: { name: string; input: NewTaskInput; fields: Record<string, string> }[] =
      [
        { name: 'an absent title', input: {}, fields: { title: 'Title is required' } },
        {
          name: 'a whitespace-only title',
          input: { title: ' \t ' },
          fields: { title: 'Title is required' },
        },
        {
          name: 'an over-long title',
          input: { title: 'a'.repeat(201) },
          fields: { title: 'Title must be 200 characters or fewer' },
        },
        {
          name: 'a numeric title',
          input: { title: 7 },
          fields: { title: 'Title must be a string' },
        },
        {
          name: 'an over-long description',
          input: { title: VALID_TITLE, description: 'd'.repeat(2001) },
          fields: { description: 'Description must be 2000 characters or fewer' },
        },
        {
          name: 'a boolean description',
          input: { title: VALID_TITLE, description: true },
          fields: { description: 'Description must be a string' },
        },
        {
          name: 'an unknown priority',
          input: { title: VALID_TITLE, priority: 'HIGH' },
          fields: { priority: 'Priority must be one of: low, medium, high' },
        },
        {
          name: 'a null priority',
          input: { title: VALID_TITLE, priority: null },
          fields: { priority: 'Priority must be one of: low, medium, high' },
        },
        {
          name: 'a malformed due date',
          input: { title: VALID_TITLE, dueDate: '2026/02/14' },
          fields: { dueDate: 'Due date must be a date in YYYY-MM-DD format' },
        },
        {
          name: 'a due date that is not a string',
          input: { title: VALID_TITLE, dueDate: 20260214 },
          fields: { dueDate: 'Due date must be a date in YYYY-MM-DD format' },
        },
        {
          name: 'an impossible calendar date',
          input: { title: VALID_TITLE, dueDate: '2026-04-31' },
          fields: { dueDate: 'Due date must be a valid calendar date' },
        },
        {
          name: 'completed on create',
          input: { title: VALID_TITLE, completed: true },
          fields: { completed: 'Completed cannot be set when creating a task' },
        },
        {
          name: 'a supplied id',
          input: { title: VALID_TITLE, id: 'abc' },
          fields: { id: 'id cannot be changed' },
        },
        {
          name: 'a supplied createdAt',
          input: { title: VALID_TITLE, createdAt: INSTANT_ISO },
          fields: { createdAt: 'createdAt cannot be changed' },
        },
        {
          name: 'a supplied updatedAt',
          input: { title: VALID_TITLE, updatedAt: INSTANT_ISO },
          fields: { updatedAt: 'updatedAt cannot be changed' },
        },
        {
          name: 'an unknown property',
          input: { title: VALID_TITLE, notes: 'call the shop' },
          fields: { notes: 'Unknown field' },
        },
      ];

    it.each(rejectedInputs)('rejects $name', async ({ input, fields }) => {
      await expectRejected(input, fields);
    });
  });
});
