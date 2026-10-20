/**
 * The SQLite adapter for the application's persistence port: the one module in the product that
 * knows about rows, columns, prepared statements and the table's 0/1 integers.
 *
 * It stores and returns exactly what it is handed. Nothing here generates an identifier, reads a
 * clock, trims a value or re-checks a rule — the domain has accepted every field by the time a task
 * arrives, and the create and update use cases have already stamped it — so no second copy of a
 * rule, and no message a user could see, lives in this file.
 *
 * Reads apply no predicate and no ordering, because filtering and sorting belong to the application
 * layer — one implementation of each, so that two stores cannot produce two different orderings —
 * and because the listing budget is one scan of a table the product caps at 1,000 rows.
 *
 * Every member returns a promise although the driver is synchronous, so the application layer is
 * never told how, or how quickly, the data is held.
 */
import Database from 'better-sqlite3';

import type { TaskRepository } from '../application/TaskRepository.js';
import type { Task, TaskPriority } from '../domain/task.js';

// Every value is bound as a `?` at call time, so no request value can alter the shape of a
// statement. A plain INSERT rather than `INSERT OR REPLACE`: the primary key turns a duplicate
// identifier into an error, so inserting can never overwrite a stored task.
const INSERT_TASK_SQL =
  'INSERT INTO tasks (id, title, description, priority, due_date, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

// The column list is explicit rather than `SELECT *`, so a column a later migration adds cannot
// change what this mapping reads.
const FIND_TASK_BY_ID_SQL =
  'SELECT id, title, description, priority, due_date, completed, created_at, updated_at FROM tasks WHERE id = ?';

// No WHERE and no ORDER BY, deliberately: the application layer owns filter and sort.
const FIND_ALL_TASKS_SQL =
  'SELECT id, title, description, priority, due_date, completed, created_at, updated_at FROM tasks';

// `created_at` is absent because it never changes after creation, and the WHERE clause names only
// the primary key: a write always lands on the row as it stands, which is last write wins, with no
// compare-and-set and no conflict result.
const UPDATE_TASK_SQL =
  'UPDATE tasks SET title = ?, description = ?, priority = ?, due_date = ?, completed = ?, updated_at = ? WHERE id = ?';

const DELETE_TASK_SQL = 'DELETE FROM tasks WHERE id = ?';

/**
 * A `tasks` row as this class reads it: the column names, with `priority` already narrowed to a
 * level. A `TaskRow` exists only as the output of {@link toTaskRow}, which is the single point
 * where a stored value becomes an entity value and the reason no cast appears in this file.
 */
interface TaskRow {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  due_date: string | null;
  completed: number;
  created_at: string;
  updated_at: string;
}

/** True for the priority names the table's CHECK constraint allows and the entity accepts. */
function isTaskPriority(value: string): value is TaskPriority {
  return value === 'low' || value === 'medium' || value === 'high';
}

/** True for a driver value that could be a row, so its columns can be read one by one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Narrows a driver result to a task row: every column's stored type is checked, `completed` must be
 * one of the two integers the table holds and `due_date` a date string or SQL `NULL`.
 *
 * This is a reading guard, not a second copy of the domain's rules — it carries no message a user
 * sees and repairs nothing. A row that fails it was corrupted or edited outside the application,
 * which is a genuine failure: it throws, and the error reaches the interface's error handler like
 * any other unexpected error.
 *
 * `Statement.get` and `Statement.all` answer `unknown`, so reading through this guard is what lets
 * a stored row become a `Task` without a cast.
 *
 * @throws Error when the value is not a row this class can interpret.
 */
function toTaskRow(value: unknown): TaskRow {
  if (!isRecord(value)) {
    throw new Error('Stored task row is not a table row.');
  }

  const { id, title, description, priority, due_date, completed, created_at, updated_at } = value;

  if (
    typeof id !== 'string' ||
    typeof title !== 'string' ||
    typeof description !== 'string' ||
    typeof priority !== 'string' ||
    !isTaskPriority(priority) ||
    (typeof due_date !== 'string' && due_date !== null) ||
    (completed !== 0 && completed !== 1) ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string'
  ) {
    throw new Error('Stored task row holds a column of an unexpected type.');
  }

  return { id, title, description, priority, due_date, completed, created_at, updated_at };
}

/**
 * Maps a validated row to the entity. `completed` crosses back from the table's 0/1 integer to the
 * boolean the API returns; every other field is taken exactly as stored, with no trimming and no
 * re-derivation, because the row already holds the canonical values the domain wrote.
 */
function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    dueDate: row.due_date,
    completed: row.completed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Stores tasks in the SQLite `tasks` table, satisfying {@link TaskRepository} exactly: the five
 * promise-returning members, no filtering, no ordering and no rule re-checked.
 *
 * The five statements are prepared once, in the constructor, and every call reuses a compiled one.
 * `insert` and `update` stay two operations rather than becoming one `save`: an upsert would
 * recreate a task that was deleted between a read and a write and so quietly undo the delete. Each
 * reports how many rows it touched, which is how a write aimed at a record that is gone becomes the
 * port's `false` and the domain's not-found instead of a silent success, while a read miss simply
 * answers `null`.
 *
 * The handle is owned by the composition root, which opens and closes it; this class never closes
 * it. A driver failure is not caught here — it propagates unchanged, so the interface's error
 * handler can answer the generic 500 and log the cause.
 *
 * The members are `async` although the driver is synchronous, and must stay that way: the body
 * still runs at the call, while a driver failure becomes a rejection instead of a synchronous
 * throw escaping a member whose signature promises a promise. The port's shared conformance suite
 * asserts exactly that with `insert(...).catch(...)`, and the in-memory implementation behaves the
 * same way, so the two stores stay observably identical.
 */
export class SqliteTaskRepository implements TaskRepository {
  /** The open handle every prepared statement below runs against. */
  private readonly db: Database.Database;

  private readonly insertStatement: Database.Statement;
  private readonly findByIdStatement: Database.Statement;
  private readonly findAllStatement: Database.Statement;
  private readonly updateStatement: Database.Statement;
  private readonly deleteStatement: Database.Statement;

  /**
   * Prepares the five statements once, so no call re-compiles a statement. The handle is stored in
   * the constructor body before it is used, rather than in a field initializer, which runs first.
   *
   * @param db Open handle carrying the migrated `tasks` table; the caller owns its lifetime.
   */
  constructor(db: Database.Database) {
    this.db = db;
    this.insertStatement = this.db.prepare(INSERT_TASK_SQL);
    this.findByIdStatement = this.db.prepare(FIND_TASK_BY_ID_SQL);
    this.findAllStatement = this.db.prepare(FIND_ALL_TASKS_SQL);
    this.updateStatement = this.db.prepare(UPDATE_TASK_SQL);
    this.deleteStatement = this.db.prepare(DELETE_TASK_SQL);
  }

  /**
   * Stores a new task, binding `null` as SQL `NULL` for an absent due date and `completed` as the
   * table's 0/1 integer. Resolves with no value once the task is stored; an identifier already in
   * the table raises the primary key's constraint error instead of replacing the task holding it.
   */
  async insert(task: Task): Promise<void> {
    this.insertStatement.run(
      task.id,
      task.title,
      task.description,
      task.priority,
      task.dueDate,
      task.completed ? 1 : 0,
      task.createdAt,
      task.updatedAt,
    );
  }

  /**
   * Returns the task holding this identifier, or `null` when the table holds none: a miss is
   * reported, never thrown for.
   */
  async findById(id: string): Promise<Task | null> {
    const row = this.findByIdStatement.get(id);

    return row === undefined ? null : toTask(toTaskRow(row));
  }

  /**
   * Returns every stored task, in whatever order the scan produces. Filtering, ordering and any
   * reliance on that order belong to the caller.
   */
  async findAll(): Promise<Task[]> {
    return this.findAllStatement.all().map((row) => toTask(toTaskRow(row)));
  }

  /**
   * Replaces the stored task wholesale and answers whether a row was really replaced. `false` means
   * the task is no longer stored, which the caller reports as not-found rather than recreating it;
   * `true` means the caller's `updatedAt` is now the row's.
   */
  async update(task: Task): Promise<boolean> {
    const result = this.updateStatement.run(
      task.title,
      task.description,
      task.priority,
      task.dueDate,
      task.completed ? 1 : 0,
      task.updatedAt,
      task.id,
    );

    return result.changes > 0;
  }

  /**
   * Removes the task holding this identifier and answers whether a row was really removed, so the
   * first delete is `true` and a repeat is `false`.
   */
  async delete(id: string): Promise<boolean> {
    return this.deleteStatement.run(id).changes > 0;
  }
}
