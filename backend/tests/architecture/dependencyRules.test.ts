/**
 * Architecture enforcement for the layered dependency direction.
 *
 * The rule set lives in the repository root's `.dependency-cruiser.cjs` and nowhere else. This
 * module runs it — over `backend/src` and over `frontend/src` — through dependency-cruiser's
 * JavaScript API, so `npm test` fails the moment an import breaks the layering (interface ->
 * application -> domain, infrastructure behind the ports the application declares, the domain free
 * of every package and built-in) or the rule set itself has been deleted or softened. No rule is
 * restated here, so there is only ever one definition of the layering to keep in step.
 *
 * Each workspace is cruised on its own, with its own `tsconfig.json`, because a cruise resolves
 * against a single TypeScript program. The target is given relative to the repository root and
 * `baseDir` is set to that root explicitly, because dependency-cruiser resolves a target and
 * reports a module relative to `baseDir`: left at its default of `process.cwd()`, the backend
 * workspace's own `npm test` — which starts in `backend/` — would report modules as `src/...` and
 * every rule pattern, written against `backend/src/...`, would match nothing.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cruise, format } from 'dependency-cruiser';
import type { ICruiseOptions, ICruiseResult, IFlattenedRuleSet } from 'dependency-cruiser';
import { beforeAll, describe, expect, it } from 'vitest';

/** An object read out of the untyped CommonJS configuration file. */
type ConfigRecord = Record<string, unknown>;

/** A workspace to cruise, named the way the documented command names it. */
interface Workspace {
  /** The workspace's name, for the report text. */
  name: string;
  /** The directory to cruise, relative to the repository root. */
  target: string;
  /** The TypeScript program the workspace's modules are resolved with. */
  tsConfigFile: string;
}

/** One workspace's cruise: what it covered, what it reported, and that in a readable form. */
interface WorkspaceCruise {
  /** The workspace's name. */
  name: string;
  /** The directory cruised, relative to the repository root. */
  target: string;
  /** The cruise result, whose `summary` carries the violations and the rule set used. */
  result: ICruiseResult;
  /** The same result rendered by the `err` reporter: the rule, its severity and the import chain. */
  report: string;
}

/** The rule set as the configuration file declares it, plus the severity a rule falls back to. */
interface LoadedRuleSet {
  /** The rule set, in the shape dependency-cruiser's cruise options take. */
  ruleSet: IFlattenedRuleSet;
  /** The configuration file's own `options` block, passed to the cruise unchanged. */
  options: ConfigRecord;
  /** The forbidden rules as declared, for the guard's own assertions. */
  forbidden: ConfigRecord[];
  /** The configuration's rule-set-level default severity, if it declares one. */
  defaultSeverity: string | null;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configFile = '.dependency-cruiser.cjs';
const configPath = join(repoRoot, configFile);

/**
 * A TypeScript cruise of both workspaces is the heaviest work in the suite, so it gets a budget of
 * its own rather than the workspace default.
 */
const cruiseTimeoutMs = 60_000;

const workspaces: Workspace[] = [
  { name: 'backend', target: 'backend/src', tsConfigFile: join(repoRoot, 'backend/tsconfig.json') },
  {
    name: 'frontend',
    target: 'frontend/src',
    tsConfigFile: join(repoRoot, 'frontend/tsconfig.json'),
  },
];

/** The rule set is what keeps these apart; a rule set that has lost one of them has been gutted. */
const minimumForbiddenRules = 7;

/**
 * The layering each of the forbidden rules stands for, paired with the fragment of the serialised
 * rule set that shows the concept is still expressed. Deliberately keyed on concepts rather than
 * on rule names, so a rule may be renamed or reworded without tripping the guard.
 */
const requiredRuleConcepts: { concept: string; fragment: string }[] = [
  {
    concept: 'the domain layer free of every package, built-in and other layer',
    fragment: 'domain',
  },
  {
    concept: 'the application layer free of the framework, the driver and the adapters',
    fragment: 'application',
  },
  { concept: 'the HTTP interface kept to the application and the domain', fragment: 'interface' },
  { concept: 'infrastructure never depending on the interface', fragment: 'infrastructure' },
  { concept: 'neither npm workspace importing the other', fragment: 'workspace' },
  {
    concept: 'frontend components never importing the API client',
    fragment: 'frontend/src/components',
  },
  {
    concept: "the API client as the interface's one HTTP caller",
    fragment: 'api/client',
  },
  { concept: 'no module taking part in a dependency cycle', fragment: 'circular' },
];

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return 'an array';
  }
  return value === null ? 'null' : typeof value;
}

/** Reads a list of rules, refusing anything the cruise could not be validated with. */
function readRuleArray(value: unknown, label: string): ConfigRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${configFile}: '${label}' must be an array of rules, found ${describeValue(value)}`,
    );
  }
  return value.map((rule, index) => {
    if (!isRecord(rule)) {
      throw new Error(`${configFile}: '${label}[${index}]' must be a rule object`);
    }
    return rule;
  });
}

/** The rule's name, or a placeholder that still identifies it in a failure message. */
function ruleName(rule: ConfigRecord): string {
  return typeof rule.name === 'string' ? rule.name : '<rule without a name>';
}

/** A rule's own severity, falling back to the rule-set-level default the configuration declares. */
function ruleSeverity(rule: ConfigRecord, defaultSeverity: string | null): string | null {
  return typeof rule.severity === 'string' ? rule.severity : defaultSeverity;
}

/** The rule-set-level default severity a configuration may declare. */
function readDefaultSeverity(configuration: ConfigRecord): string | null {
  const declared = configuration.allowedSeverity ?? configuration.severity;
  return typeof declared === 'string' ? declared : null;
}

/**
 * Loads the rule set through a `require` created from this module's own URL: the configuration
 * file is CommonJS, and its contents are untyped, so every field this module reads is checked
 * rather than assumed.
 */
function loadRuleSet(): LoadedRuleSet {
  const require = createRequire(import.meta.url);
  const loaded: unknown = require(configPath);

  if (!isRecord(loaded)) {
    throw new Error(`${configFile} must export a configuration object`);
  }

  const forbidden = readRuleArray(loaded.forbidden, 'forbidden');
  const allowed = readRuleArray(loaded.allowed ?? [], 'allowed');
  const required = readRuleArray(loaded.required ?? [], 'required');
  const options = isRecord(loaded.options) ? loaded.options : {};

  return {
    // The untyped CommonJS value narrowed to the tool's own rule-set type; every field is passed
    // through exactly as the configuration file declares it.
    ruleSet: { forbidden, allowed, required } as unknown as IFlattenedRuleSet,
    options,
    forbidden,
    defaultSeverity: readDefaultSeverity(loaded) ?? readDefaultSeverity(options),
  };
}

/**
 * Cruises one workspace with the loaded rule set.
 *
 * The configuration's own `options` are spread flat, which is the shape the JavaScript API takes —
 * unlike the configuration file, which nests them under `options`. `ruleSet` and `validate: true`
 * come last so nothing the file declares can switch validation off; without `validate`, a rule set
 * only populates the report's `ruleSetUsed` and every violation goes unreported.
 */
async function cruiseWorkspace(
  workspace: Workspace,
  loaded: LoadedRuleSet,
): Promise<WorkspaceCruise> {
  const options: ConfigRecord = {
    ...loaded.options,
    baseDir: repoRoot,
    ruleSet: loaded.ruleSet,
    validate: true,
  };

  // Each workspace is cruised with its own TypeScript program, which is what the configuration
  // file's comment asks for; its own default is the backend's. When a workspace has no program
  // yet, the key is removed rather than left in place: dependency-cruiser resolves the path
  // eagerly and an absent one fails the cruise outright, and the program only feeds module path
  // mapping, which no module in either workspace uses — a workspace that cannot resolve its own
  // modules is what `npm run typecheck` reports.
  if (existsSync(workspace.tsConfigFile)) {
    options.tsConfig = { fileName: workspace.tsConfigFile };
  } else {
    delete options.tsConfig;
  }

  const { output } = await cruise([workspace.target], options as unknown as ICruiseOptions);

  if (typeof output === 'string') {
    throw new Error(`The cruise over ${workspace.target} returned rendered output, not a result`);
  }

  const rendered = (await format(output, { outputType: 'err' })).output;

  return {
    name: workspace.name,
    target: workspace.target,
    result: output,
    report:
      typeof rendered === 'string'
        ? rendered
        : JSON.stringify(output.summary.violations, null, 2),
  };
}

describe('layered dependency rules', () => {
  let loaded: LoadedRuleSet;
  let cruises: WorkspaceCruise[] = [];

  beforeAll(async () => {
    expect(
      existsSync(configPath),
      `${configPath} is missing — the layered dependency rules it declares are what this suite enforces`,
    ).toBe(true);

    for (const workspace of workspaces) {
      expect(
        existsSync(join(repoRoot, workspace.target)),
        `${join(repoRoot, workspace.target)} is missing — the cruise over it would pass vacuously`,
      ).toBe(true);
    }

    loaded = loadRuleSet();
    cruises = [];
    for (const workspace of workspaces) {
      cruises.push(await cruiseWorkspace(workspace, loaded));
    }
  }, cruiseTimeoutMs);

  it(
    'finds no dependency the rule set forbids',
    () => {
      for (const { name, target, result, report } of cruises) {
        expect(
          result.summary.totalCruised,
          `The cruise over ${target} read no modules at all — it validated nothing, so its empty ` +
            `violation list means nothing. Check that ${target} holds sources and that ${configFile} ` +
            `resolves them.`,
        ).toBeGreaterThan(0);

        const forbiddenUsed = result.summary.ruleSetUsed?.forbidden?.length ?? 0;
        expect(
          forbiddenUsed,
          `The cruise over ${target} ran without a forbidden rule set (${name}: ` +
            `${result.summary.ruleSetUsed ? 'an empty' : 'no'} forbidden list in the report), so it ` +
            `could not have found a violation.`,
        ).toBeGreaterThan(0);

        expect(result.summary.violations, report).toEqual([]);
      }
    },
    cruiseTimeoutMs,
  );

  it('keeps the rule set complete and every rule at severity error', () => {
    const { forbidden, defaultSeverity } = loaded;

    expect(
      forbidden.length,
      `${configFile} declares ${forbidden.length} forbidden rules, fewer than the ${minimumForbiddenRules} ` +
        'the layering needs — every layer boundary must stay forbidden in that file.',
    ).toBeGreaterThanOrEqual(minimumForbiddenRules);

    const notErrors = forbidden
      .filter((rule) => ruleSeverity(rule, defaultSeverity) !== 'error')
      .map((rule) => `${ruleName(rule)} (${ruleSeverity(rule, defaultSeverity) ?? 'no severity'})`);

    expect(
      notErrors,
      `Every rule in ${configFile} must declare severity: 'error' — a rule left at the default ` +
        "'warn' is reported and then ignored, so it can no longer fail a run. Declare " +
        "severity: 'error' on each rule listed here.",
    ).toEqual([]);

    const serialised = JSON.stringify(loaded.ruleSet).toLowerCase();

    for (const { concept, fragment } of requiredRuleConcepts) {
      expect(
        serialised,
        `The rule set in ${configFile} no longer expresses ${concept} — restore the rule that ` +
          'forbids it.',
      ).toContain(fragment);
    }
  });
});
