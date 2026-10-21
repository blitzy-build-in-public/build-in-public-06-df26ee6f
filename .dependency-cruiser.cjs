/**
 * Architecture rules for the to-do application, executed two ways:
 *
 *   - backend/tests/architecture/dependencyRules.test.ts cruises `backend/src` and
 *     `frontend/src` through dependency-cruiser's JavaScript API and fails when the report
 *     holds a single violation, so `npm test` is what enforces the layering;
 *   - `npx depcruise backend/src frontend/src --config .dependency-cruiser.cjs` reproduces the
 *     same check from the command line.
 *
 * Every rule is severity 'error', which is what makes that command exit non-zero on a violation.
 *
 * Both entry points cruise with the repository root as their base, which is what the patterns
 * below are written against: dependency-cruiser then reports a module as
 * `backend/src/domain/task.ts`. The documented command above is run from the repository root,
 * so for it the base is simply the working directory. The architecture test sets `baseDir` to
 * that root explicitly instead, because dependency-cruiser resolves the target and reports a
 * module relative to that base, whose default is the runner's working directory: `npm test`
 * starts that test's run in `backend/`, so the default base would resolve its `backend/src`
 * target to `backend/backend/src` and name any module it did reach `src/...`, matching none of
 * the patterns written against `backend/src/...`. Each pattern keeps a `(^|/)`
 * anchor in front of its directory so the same rules hold when a cruise is handed an absolute
 * path instead.
 *
 * The dependency direction they encode is interface -> application -> domain, with
 * infrastructure implementing the ports the application declares:
 *
 *   backend/src/domain         its own sibling modules only: no other layer, no node: built-in,
 *                              no npm package of any kind
 *   backend/src/application    the domain and its ports, plus node: built-ins (node:crypto
 *                              supplies a new task's UUID)
 *   backend/src/infrastructure the application (to implement its ports) and the domain
 *   backend/src/interface/http the application and the domain, never an infrastructure module,
 *                              so the HTTP layer can only ever see the ports
 *   frontend/src               itself, reaching the backend over HTTP through the API client
 *
 * backend/src/main.ts is the composition root and the only module that names a concrete
 * implementation; it sits outside the directories these rules scope, and the no-circular rule is
 * what keeps the wiring it builds acyclic.
 */
const path = require('node:path');

module.exports = {
  forbidden: [
    // The domain holds the product's rules: no npm package, no node: built-in, no other layer.
    {
      name: 'domain-purity',
      severity: 'error',
      from: { path: '(^|/)backend/src/domain/' },
      /**
       * A single `to` is one condition set: dependency-cruiser ANDs its properties, so each
       * property carries the alternatives as a list and a dependency violates the rule only when
       * its resolved path matches one of these AND its dependency type matches one of those.
       * (dependency-cruiser joins a list into one alternation, so each entry carries its own
       * anchors, and every entry stays free of nested quantifiers, which its safety check — and
       * therefore the whole cruise — rejects.)
       *
       * The path list is what catches packages and built-ins. An npm import resolves into a
       * `node_modules/` directory wherever the hoisted package happens to sit — including the
       * `../node_modules/` form, which dependency-cruiser classifies as `npm-no-pkg` rather than
       * `npm`, so the type list names the whole family rather than `npm` alone. A node: built-in
       * resolves to its bare specifier (`crypto`) or to one subpath (`fs/promises`), which the
       * last two patterns match by their shape: a resolved file path always holds either a dot in
       * its final segment or a directory, neither of which a builtin specifier has.
       */
      to: {
        path: [
          '(^|/)node_modules/',
          '(^|/)backend/src/(application|infrastructure|interface)/',
          '(^|/)frontend/',
          '^[a-z][a-z0-9_]*$',
          '^(node:)?[a-z][a-z0-9_]*/[a-z][a-z0-9_]*$',
        ],
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-bundled',
          'npm-no-pkg',
          'core',
          'local',
          'localmodule',
        ],
      },
    },

    // Use cases depend on the domain and their ports, never on a framework, a driver or an adapter.
    {
      name: 'application-purity',
      severity: 'error',
      from: { path: '(^|/)backend/src/application/' },
      /**
       * Same condition-set technique as the domain rule, with two deliberate differences: only
       * the three runtime stacks are banned by path, because the application layer's remaining
       * npm imports are its own business; and 'core' is absent from the type list, so
       * `node:crypto` — which the create use case needs for the task's UUID — stays legal here.
       */
      to: {
        path: [
          '(^|/)node_modules/(fastify|better-sqlite3|react|react-dom)/',
          '(^|/)backend/src/(infrastructure|interface)/',
          '(^|/)frontend/',
        ],
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-bundled',
          'npm-no-pkg',
          'local',
          'localmodule',
        ],
      },
    },

    // The HTTP layer sees ports, not adapters: it may never import an infrastructure module.
    {
      name: 'interface-not-to-infrastructure',
      severity: 'error',
      from: { path: '(^|/)backend/src/interface/' },
      to: { path: '(^|/)backend/src/infrastructure/' },
    },

    // Infrastructure implements the ports; it never depends on the layer that drives it.
    {
      name: 'infrastructure-not-to-interface',
      severity: 'error',
      from: { path: '(^|/)backend/src/infrastructure/' },
      to: { path: '(^|/)backend/src/interface/' },
    },

    // The two npm workspaces are separate programs: neither may reach into the other's sources.
    {
      name: 'no-cross-workspace-import',
      severity: 'error',
      /**
       * One rule covers both directions. `$2` in the `to` conditions is the workspace captured
       * from this module's own path, so a backend module is allowed to import `backend/…` and a
       * frontend module `frontend/…`, while an import that crosses stays unmatched by `pathNot`
       * and is reported. Paths are matched with a leading `(^|/)` so the rule holds whether the
       * cruise reports repository-root-relative or absolute module names.
       */
      from: { path: '(^|/)(backend|frontend)/' },
      to: { path: '(^|/)(backend|frontend)/', pathNot: '$2/' },
    },

    // Components take their data and actions as props; only App.tsx constructs the API client.
    {
      name: 'frontend-components-not-to-api-client',
      severity: 'error',
      from: { path: '(^|/)frontend/src/components/' },
      to: { path: '(^|/)frontend/src/api/client(\\.(ts|tsx|js|jsx))?$' },
    },

    // No module may take part in a dependency cycle, whatever layer it belongs to.
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],

  options: {
    /**
     * `node_modules` is deliberately absent from `exclude`: excluding it drops the package
     * modules and the dependencies into them before any rule is evaluated, which leaves the npm
     * halves of the two purity rules above unable to fire. Not following them keeps the graph
     * small while the dependency into each package is still reported — which is what those rules
     * match on.
     */
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage|playwright-report|test-results)/' },

    /**
     * The backend is an ES module whose relative imports carry a `.js` extension while the file on
     * disk is `.ts`. Without this the resolver stops at `.js`, the backend's own modules never
     * enter the graph, and every rule above would silently match nothing.
     */
    tsPreCompilationDeps: true,

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.js', '.ts', '.tsx', '.mjs', '.cjs'],
    },

    /**
     * The TypeScript program behind the backend cruise. It is resolved to an absolute path
     * because dependency-cruiser's config-utl cannot read a relative tsconfig under the pinned
     * TypeScript: it throws TS18003 ("No inputs were found") and takes the whole cruise down with
     * it, whether it runs from the CLI or from the architecture test.
     *
     * Contract with backend/tests/architecture/dependencyRules.test.ts — it cruises one workspace
     * at a time and overrides this value for the frontend cruise with the absolute path to
     * `frontend/tsconfig.json`, so the backend program stays the default and each workspace is
     * cruised with its own.
     */
    tsConfig: { fileName: path.resolve(__dirname, 'backend/tsconfig.json') },
  },
};
