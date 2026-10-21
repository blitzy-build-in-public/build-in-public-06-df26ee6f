# To-Do App

A modular, single-user to-do web application: a React and Vite browser interface, a Fastify JSON
HTTP API, and tasks persisted in a local SQLite file. It is built in layers — domain, application,
infrastructure and interface — so the domain rules, the storage and the interface can each be
changed or tested without touching the others.

## Prerequisites

- Node.js 20.19.0 or later, and npm 10 or later. The root `package.json` declares
  `"node": ">=20.19.0"` and `"npm": ">=10"`; the Node floor is what Vite 8, ESLint 10,
  `@eslint/js` 10 and jsdom 29 require.
- No database server and no other system service. The store is a SQLite file inside this checkout.
- A browser for the end-to-end suite:

```bash
npx playwright install --with-deps chromium
```

`better-sqlite3` 12.11.1 is a native module. `npm ci` downloads a prebuilt binary for the platform
when one exists and builds it from source otherwise, in which case Node's build prerequisites are
needed: `python3`, `make` and a C++ compiler. It is pinned to 12.11.1 rather than to 13.x because
13.x requires Node 22, while this product targets Node 20 LTS.

## Install

From the repository root:

```bash
npm ci
```

This installs both npm workspace packages, `backend` and `frontend`, from the single committed
`package-lock.json`.

## Run in development

```bash
npm run dev
```

Starts the API in watch mode and the Vite development server together with `concurrently`. Open
http://localhost:5173 in a browser.

The browser talks only to the Vite development server, which proxies every request whose path starts
with `/api` to the API on `http://localhost:3000`. The interface therefore uses the relative base
`/api`, and no cross-origin configuration exists. Export `PORT` before starting to move the API and
the proxy target together:

```bash
PORT=4000 npm run dev
```

The development server's own port is fixed at 5173 and is overridden with `--port` on its workspace
script, which is also how a checkout that has to avoid a busy port starts it:

```bash
npm run dev --workspace @todo/frontend -- --port 5200 --strictPort
```

## Build and run the built application

```bash
npm run build
```

Type-checks the backend and emits `backend/dist` with `tsc`, then bundles the frontend into
`frontend/dist` with Vite.

```bash
npm start
```

Runs the built API from `backend/dist`, which is `node dist/main.js` in the backend workspace. It
reads the same three configuration variables and binds the same port.

```bash
npm run preview
```

Serves the built frontend from `frontend/dist` through Vite's preview server on
http://localhost:4173. The preview server inherits the development server's proxy, so `/api` still
reaches the API on `PORT`.

## Test

```bash
npm test
```

Runs the backend unit, integration and architecture suites, then the frontend component and unit
suites.

```bash
npm run test:coverage
```

Runs the same suites with coverage. The backend workspace enforces at least 90% lines, statements,
functions and branches across `backend/src/domain/**` and `backend/src/application/**` and fails the
run when a threshold is not met; coverage for the infrastructure, interface and frontend layers is
reported and not gated.

```bash
npm run test:e2e
```

Playwright drives a real browser against the API process and the Vite development server, both
started by `playwright.config.ts` from the checkout as it stands, so no production build is needed.
It requires the chromium install from Prerequisites and runs with a single worker, because every
spec shares one SQLite file, `backend/data/e2e.db`, which `e2e/globalSetup.ts` deletes before the
run begins.

## Quality gates

```bash
npm run lint
```

ESLint 10 over both workspaces, using the flat configuration in `eslint.config.mjs`.

```bash
npm run typecheck
```

`tsc --noEmit` in each workspace.

`npm run typecheck` covers the three compiler programs: the backend program
(`backend/tsconfig.json`) covers `backend/src` alone, the frontend app program
(`frontend/tsconfig.json`) covers `frontend/src` and `frontend/tests`, and
`frontend/tsconfig.node.json` covers `frontend/vite.config.ts`. Four groups of delivered files
belong to none of the three, so that command does not type-check them: every file under
`backend/tests/**` and `e2e/**`, plus `backend/vitest.config.ts` and `playwright.config.ts`. The
backend program takes `src` alone because it sets `rootDir: "src"` and emits `dist`: adding `tests`
to its `include` raises TS6059, and dropping `rootDir` to admit them would emit `dist/src/main.js`,
which `npm start` does not run. Each of those files is transpiled and executed by its own runner
instead — Vitest for the backend test tree and its configuration, Playwright for the end-to-end
configuration and the files under `e2e/**` — and no compiler program and no lint rule type-checks
any of them.

The frontend program's Node types are hoisted, and that hoisting is a contract.
`frontend/tsconfig.node.json` names `"node"` in its `types` because `frontend/vite.config.ts` reads
`process.env.PORT` to build the `/api` proxy target, and the program resolves those types from
`@types/node`, which the frontend manifest does not declare: `backend/package.json` declares it
once, as `"@types/node": "20.19.43"`, and the single npm-workspace install hoists it to the
repository-root `node_modules`, which is where the frontend program resolves it from. That
devDependency is therefore part of the frontend's `typecheck` script: it must stay declared in
`backend/package.json`, because the frontend half of `npm run typecheck` depends on it.

The whole verification run, from a clean checkout:

```bash
npm ci && npx playwright install --with-deps chromium && npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e
```

## Commands

| Command | What it runs |
|---------|--------------|
| `npm ci` | installs both workspaces from `package-lock.json` |
| `npm run dev` | the API under `tsx watch` and the Vite development server, together |
| `npm run build` | `tsc` for the backend, then `vite build` for the frontend |
| `npm start` | the built API from `backend/dist` |
| `npm run preview` | Vite's preview server for `frontend/dist` |
| `npm test` | `vitest run` in the backend workspace, then in the frontend workspace |
| `npm run test:coverage` | the same suites with the v8 coverage provider |
| `npm run test:e2e` | the Playwright suite against both servers |
| `npm run lint` | ESLint over the repository |
| `npm run typecheck` | `tsc --noEmit` in each workspace |
| `npx playwright install --with-deps chromium` | the browser the end-to-end suite drives |

## Configuration

The API process reads three variables at startup. Each has a default, so the application runs with
no environment set at all. `.env.example` documents those three with the same defaults, plus the one
more variable in the table below that the API process does not read; it is a reference only and is
not loaded, because the process reads the real environment and no `.env` file exists.

| Variable | Default | Effect | How it is overridden |
|----------|---------|--------|----------------------|
| `PORT` | `3000` | the port the API binds, and the target the frontend's `/api` proxy forwards to | exported in the shell before `npm run dev` or `npm start`, or set in the Playwright `webServer` entry |
| `DATABASE_PATH` | `./data/todo.db` | the SQLite file to open, resolved against the process working directory, with the parent directory created when it is missing | exported in the shell, or passed as `config.databasePath` to `composeApp` by the tests |
| `LOG_LEVEL` | `info` | the pino level for the application logger, and therefore for the cause logged with a 500 response | exported in the shell; the test suites pass `silent` so their output stays readable |
| `VITE_DEV_PORT` | `5173` | the port the Vite development server that `npm run test:e2e` starts listens on, and therefore the run's `baseURL` | exported in the shell before `npm run test:e2e` |

The first three rows are the API process's own. `VITE_DEV_PORT` is read by `playwright.config.ts`
alone and never by the API process: it is the port the Vite development server that `npm run
test:e2e` starts listens on, and therefore the run's `baseURL`. Move it by exporting it in the shell
before that command. That is the end-to-end run's remedy for a 5173 that is busy — the same problem
`npm run dev` solves with `--port` on its frontend workspace script, described under Run in
development.

Because npm runs a workspace script with the workspace directory as its working directory,
`DATABASE_PATH` resolves to `backend/data/todo.db` when the application is started through the root
scripts.

## Data and storage

Tasks live in one SQLite file. The directory and the file are created on first run, and the schema
is created or upgraded by the migrations in `backend/src/infrastructure/migrations.ts`, which track
the file's version through `PRAGMA user_version` — so a later change to the schema ships as a
migration rather than as a manual edit. The connection is opened with a five-second busy timeout and
`journal_mode = WAL`, so a read proceeds while a write commits and a writer arriving mid-commit
waits instead of failing. Concurrent edits to one task are last-write-wins, and `updatedAt` reports
the write that survived.

SQLite keeps the write-ahead log's index in a memory-mapped `-shm` file beside the database. If that
file becomes unwritable after startup — an immutable attribute, permissions that no longer permit
the write, or a filesystem or mount that cannot back the mapping — a request that touches it faults
the process inside the mapping, and no handler in the process can turn that fault into a response:
the request gets none, and the log ends at the startup line. The recovery is to restore write access
to the file (clear the immutable attribute, repair its permissions, or repair the filesystem) and
start the process again; tasks already written are in the database file. An unwritable `-wal` file,
or a filesystem that is full, is an ordinary storage failure by contrast: reads keep succeeding and
a write answers the generic 500 with the cause logged at error level, while the process stays up.
WAL is what lets a read proceed while a write commits, and the mapping its index needs is what makes
the fault above possible.

To reset the data, stop the process and delete the database file together with its sidecars:

```bash
rm -f backend/data/todo.db backend/data/todo.db-wal backend/data/todo.db-shm
```

The next start recreates the directory, the file and the current schema.

## Project layout

```plaintext
.
├── package.json                 # workspace root: scripts, engines, shared dev dependencies
├── package-lock.json            # the single lockfile for both workspaces
├── tsconfig.base.json           # strict compiler options both workspaces extend
├── eslint.config.mjs            # flat lint configuration for the repository
├── .dependency-cruiser.cjs      # the seven layer rules the architecture test runs
├── playwright.config.ts         # the two servers the end-to-end suite starts
├── .gitignore                   # generated and local state kept out of the repository
├── .env.example                 # the configuration variables and their defaults
├── README.md                    # prerequisites, install, run, build, test, configuration, layout, API summary
├── backend/
│   ├── package.json             # @todo/backend
│   ├── tsconfig.json            # NodeNext resolution, emits dist
│   ├── vitest.config.ts         # node environment, and the inner-layer coverage thresholds
│   ├── src/
│   │   ├── domain/              # the Task entity, its field rules and its errors: no I/O, no package
│   │   ├── application/         # the six use cases, the TaskRepository and Clock ports, query semantics
│   │   ├── infrastructure/      # the SQLite adapter, the database opener, the migrations, the clock
│   │   ├── interface/http/      # the routes, request parsing and the single error mapper
│   │   └── main.ts              # composition root and process entry point
│   └── tests/
│       ├── unit/                # the domain rules and each use case
│       ├── contract/            # the shared repository conformance suite
│       ├── integration/         # the SQLite adapter, the migrations, the routes, the list budget
│       ├── architecture/        # runs the dependency rules
│       └── support/             # in-memory repository, fixed clock, temporary database
├── frontend/
│   ├── package.json             # @todo/frontend
│   ├── tsconfig.json            # Bundler resolution and JSX for the app and its tests
│   ├── tsconfig.node.json       # compilation unit for the Vite configuration
│   ├── vite.config.ts           # react plugin, the /api proxy, the test configuration
│   ├── index.html               # the served document and the mount point
│   ├── src/
│   │   ├── api/                 # the wire types, and the only module that calls fetch
│   │   ├── state/               # list, filter and action state, and the presentation selectors
│   │   ├── components/          # form, list, task item, priority tag, filter bar, confirm dialog
│   │   ├── styles/global.css    # custom properties, reset and the mobile-first breakpoints
│   │   ├── App.tsx              # composes the screen and creates the API client
│   │   └── main.tsx             # mounts the React root
│   └── tests/                   # api, state and component suites, with their setup and helpers
└── e2e/                         # the Playwright specs, their global setup and request helpers
```

## Architecture

Dependencies point inward only: interface -> application -> domain, with infrastructure implementing
the interfaces the application declares. The domain layer imports nothing outside itself — no npm
package, no `node:` built-in, no other layer — and the application layer imports the domain and its
ports but never Fastify, better-sqlite3 or React. `backend/src/main.ts` is the composition root and
the only module that names a concrete implementation. On the frontend, `frontend/src/api/client.ts`
is the only module that performs an HTTP request: `App.tsx` constructs it, and every component below
receives its data and its actions as props.

`.dependency-cruiser.cjs` states that direction as seven rules — domain purity, application purity,
interface-not-to-infrastructure, infrastructure-not-to-interface, no cross-workspace import,
components-not-to-api-client, and no circular dependencies.
`backend/tests/architecture/dependencyRules.test.ts` runs them through dependency-cruiser's
JavaScript API and fails the suite on a single violation, so `npm test` is what enforces the
layering. The same check runs from the command line with
`npx depcruise backend/src frontend/src --config .dependency-cruiser.cjs`.

The storage adapter is swappable because every use case depends on the `TaskRepository` port: the
use-case tests run against an in-memory implementation, and the shared conformance suite in
`backend/tests/contract/taskRepositoryContract.ts` runs against both that implementation and the
SQLite adapter.

## API summary

Every route sits under `/api`, accepts and returns JSON, and is validated on the server. A task
always carries all eight fields, so an absent due date is `null` and an empty description is `""`:

```json
{
  "id": "9c8f5b1e-6f2a-4a1d-9c77-2f0b1d3e4a55",
  "title": "Buy milk",
  "description": "",
  "priority": "medium",
  "dueDate": "2026-02-14",
  "completed": false,
  "createdAt": "2026-02-01T09:15:00.000Z",
  "updatedAt": "2026-02-01T09:15:00.000Z"
}
```

| Method | Path | Purpose | Query parameters | Request body | Success response |
|--------|------|---------|------------------|--------------|------------------|
| GET | `/api/tasks` | list tasks, filtered and sorted by the server | `status`, `priority`, `sort` | none | 200, an array of task objects |
| POST | `/api/tasks` | create a task | none | `title` required; `description`, `priority` and `dueDate` optional | 201, the created task |
| GET | `/api/tasks/:id` | read one task | none | none | 200, the task |
| PATCH | `/api/tasks/:id` | update the supplied fields of a task | none | any non-empty subset of `title`, `description`, `priority`, `dueDate`, `completed` | 200, the updated task |
| DELETE | `/api/tasks/:id` | delete a task | none | none | 204, empty body |
| GET | `/api/health` | report liveness | none | none | 200, `{"status":"ok"}` |

### Listing parameters

All three parameters are optional, and an empty value means the same as an absent one, so
`GET /api/tasks?status=&priority=&sort=` is a request for the defaults:

| Parameter | Accepted values | Default |
|-----------|-----------------|---------|
| `status` | `all`, `open`, `completed` | `all` |
| `priority` | `low`, `medium`, `high` | no priority filter |
| `sort` | `dueDate`, `priority`, `createdAt` | `createdAt` |

Ordering is applied after filtering. `createdAt` puts the most recently created task first, `dueDate`
puts the earliest due date first and places every task with no due date after the dated ones, and
`priority` orders `high`, then `medium`, then `low`. Ties break on `id` ascending, so an order is
always reproducible. A repeated parameter such as `?status=open&status=completed`, or a value
outside the accepted set, is a 400 naming that parameter; an unknown extra parameter is ignored.

### Errors

Every 4xx and 5xx response carries one envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "fields": {
      "title": "Title is required"
    }
  }
}
```

`code` is one of `VALIDATION_ERROR`, `NOT_FOUND` or `INTERNAL_ERROR`. `fields` is always present: it
maps each offending field name to a message for a rule violation, and is empty for a failure that
belongs to no field. A 400 reports field-level validation, a body that is absent or not a JSON
object, a read-only or unknown property, an empty patch, or an unsupported or repeated query value.
A 404 reports an identifier matching no task, or a method and path matching no route. A 500 carries a
fixed generic body, `Internal server error`, while the cause is logged server-side and never sent to
the client.

### Request bodies

`POST` accepts `title`, `description`, `priority` and `dueDate`. `completed` is rejected on create,
because a new task is always created incomplete. `PATCH` applies only the fields it contains, so
`"dueDate": null` clears the due date and `"description": ""` clears the description, and a body
whose only field is `completed` is the checkbox toggle. `id`, `createdAt` and `updatedAt` are
read-only in a body, and an unknown property is rejected rather than ignored.

## Use notes

- A title is required and is trimmed before it is measured: 1 to 200 characters after trimming.
- A description is optional and at most 2000 characters after trimming.
- Priority is `low`, `medium` or `high` and defaults to `medium`. Every task shows its level as a
  word as well as in colour.
- A due date is an optional calendar date in `YYYY-MM-DD` form, and a past date is accepted.
- An open task whose due date is before today is marked overdue. A completed task is never marked
  overdue, and a task with no due date never is. The flag is derived in the browser from the local
  date and is never stored.
- Filtering and sorting are applied by the server: the interface sends the query parameters and
  renders the list it receives.
- Deleting asks for confirmation first, and a task the server no longer holds is removed from the
  list with a notice.
- The interface is keyboard-operable. Every action is a native button, input, select or checkbox,
  every control has a label, and an error is announced with the field it names.

## Scope

This version is a single-user application that runs locally. There is no authentication and no
multi-user sharing, the API binds loopback only, and no credential is required. It contacts no
external service and reads no secret. Cloud deployment and CI/CD configuration are out of scope for
this version, so the repository carries no workflow, container or deployment configuration, and the
commands above are the whole of how the application is installed, run and tested.
