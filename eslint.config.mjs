/**
 * Flat ESLint configuration for the whole repository.
 *
 * One configuration serves both workspaces, the end-to-end specs and the root tool
 * configuration, because the root `lint` script is `eslint .`. Rules come from the four
 * lint packages the root manifest already declares — @eslint/js, typescript-eslint,
 * eslint-plugin-react-hooks and globals — and nothing is suppressed here: a rule that fires
 * is fixed in the code it fires on.
 *
 * The layer boundaries (which layer may import which) are deliberately absent from this
 * file. `.dependency-cruiser.cjs` is the single definition of that policy, so the two
 * cannot disagree about what the architecture allows.
 */
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Every TypeScript file in the repository, so the typescript-eslint presets — and the
 * TypeScript parser they install — are never applied to a JavaScript file.
 */
const typescriptFiles = ['**/*.{ts,tsx,mts,cts}'];

/**
 * The files a TypeScript project covers, and therefore the only ones for which the parser
 * may build a program. The project service resolves each linted file to the nearest
 * `tsconfig.json` and reports a file that no project includes as a parsing error, so this
 * list must match the workspaces' `include` sets exactly: `backend/tsconfig.json` includes
 * `src` alone (adding `tests` would break `rootDir` and with it `npm start`), while
 * `frontend/tsconfig.json` includes both `src` and `tests`. The backend tests, the Vite and
 * Vitest configurations and `playwright.config.ts` are therefore linted without type
 * information rather than failing the run.
 */
const typeAwareFiles = [
  'backend/src/**/*.ts',
  'frontend/src/**/*.{ts,tsx}',
  'frontend/tests/**/*.{ts,tsx}',
];

export default [
  // Generated and local artifacts. These are the paths `.gitignore` also excludes; linting
  // them would be slow, and a finding inside a build output is not actionable.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'playwright-report/**',
      'test-results/**',
      'backend/data/**',
    ],
  },

  // The recommended JavaScript rules, over every JavaScript and TypeScript file. The
  // typescript-eslint preset below then retires the base rules a TypeScript file must not
  // obey, such as `no-undef`, `no-unused-vars` and `no-redeclare`.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    ...js.configs.recommended,
  },

  // typescript-eslint's parser and its recommended rules, scoped to the TypeScript files.
  // Each preset entry is handed the same `files` list so the parser is confined to them.
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: typescriptFiles })),

  // Type information is requested only where a program exists, which is what keeps the run
  // working for the files that belong to no project.
  {
    files: typeAwareFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // The API workspace and everything that drives it from Node (the Vitest suites, the Vite
  // and Playwright configurations) reach for `process`, `Buffer`, `__dirname` and friends.
  {
    files: ['backend/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['playwright.config.ts', '**/*.config.{ts,mts,cts}', 'e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  // The tool configuration the repository keeps in CommonJS or ESM form, including this
  // file and `.dependency-cruiser.cjs`.
  {
    files: ['**/*.{mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },

  // The browser bundle runs in a document, and its jsdom-based tests additionally see the
  // Node globals a test runner provides.
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  // Both workspaces configure Vitest with `globals: true`, so `describe`, `it`, `expect` and
  // `vi` are used without an import; `globals.vitest` is the package's own set for the
  // runner, so it cannot fall behind what the suites actually use. The two trees run in
  // different environments, so each is granted the set its own runner provides and not the
  // other's: `backend/vitest.config.ts` fixes `environment: 'node'`, so an API suite has no
  // document to reach for, while the frontend suite runs under jsdom — Node with a DOM added
  // — so it sees the browser globals and the Node ones its modules still use, such as the
  // `process.env` a suite stubs to pin a timezone.
  {
    files: ['backend/tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
  },
  {
    files: ['frontend/tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.vitest },
    },
  },

  // The hook rules, over the frontend sources that define and call the hooks.
  // `configs.flat.recommended` is the flat-shape configuration the plugin publishes for
  // ESLint 9 and later; its legacy `configs.recommended` declares plugins as a string
  // array, which ESLint 10 rejects. The published severities are kept as they are, so the
  // hook code has to be correct rather than muted.
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
];
