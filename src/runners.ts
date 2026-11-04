import {listFormat} from './messages.ts';
import {allUnionMembers, arrayIntersection, setHas} from './utils.ts';

/** What can run the scripts: a package manager, or `node` for `node --run` */
export type Runner = 'aube' | 'node' | 'npm' | 'pnpm' | 'pnpm-10' | 'upm' | 'yarn' | 'yarn-classic';

export const RUNNERS: readonly Runner[] = allUnionMembers<Runner, {readonly: true}>()([
  'aube',
  'node',
  'npm',
  'pnpm',
  'pnpm-10',
  'upm',
  'yarn',
  'yarn-classic',
]);

/** Runners that are package managers: all of them but `node`, which doesn't install packages */
export const PACKAGE_MANAGER_RUNNERS: readonly Runner[] = RUNNERS.filter(
  (runner) => runner !== 'node',
);

/**
 * Scripts that run with any package manager by default, as they run on the machine of whoever
 * installs the package: install scripts, and `prepare`, which runs when it's installed from git
 */
export const RUNNER_AGNOSTIC_SCRIPTS: ReadonlySet<string> = new Set([
  'install',
  'postinstall',
  'preinstall',
  'prepare',
]);

/**
 * Checks whether any package manager may run a script.
 * @param scriptName The script's name in package.json
 * @param scripts `true` for all scripts, `false` for none, or whether each script is, on top of
 * the defaults
 * @returns Whether the script is runner-agnostic
 */
export const isRunnerAgnosticScript = (
  scriptName: string | undefined,
  scripts: boolean | Readonly<Record<string, boolean>> = {},
) => {
  if (typeof scripts === 'boolean') {
    return scripts;
  }
  if (scriptName == null) {
    return false;
  }
  // Not `scripts[scriptName] ?? ...`: names like `constructor` are inherited properties
  return Object.hasOwn(scripts, scriptName)
    ? scripts[scriptName] === true
    : RUNNER_AGNOSTIC_SCRIPTS.has(scriptName);
};

/** How a runner runs the scripts */
export interface RunnerTraits {
  /** Whether it replaces `/` with `\` in the script's command names on Windows */
  convertsSlashes?: boolean;
  /** How reports name it */
  label: string;
  /** The `INIT_CWD` and `npm_*` variables that it sets, if it doesn't set them all */
  packageManagerVariables?: ReadonlySet<string>;

  /**
   * Whether it runs the scripts with Yarn's portable shell, which supports POSIX syntax
   * everywhere
   */
  portableShell?: boolean;
  /** Whether it sets `HOME`, which Windows doesn't */
  setsHome?: boolean;
}

// From each runner's source code
const RUNNER_TRAITS: Readonly<Record<Runner, RunnerTraits>> = {
  aube: {
    label: 'aube',
  },
  node: {
    label: '`node --run`',
    packageManagerVariables: new Set(),
  },
  npm: {
    label: 'npm',
    setsHome: true,
  },
  pnpm: {
    label: 'pnpm',
  },
  // pnpm v10 and older, whose config defaults set `HOME`
  'pnpm-10': {
    label: 'pnpm v10',
    setsHome: true,
  },
  upm: {
    label: 'upm',
    packageManagerVariables: new Set([
      'INIT_CWD',
      'npm_lifecycle_event',
      'npm_lifecycle_script',
      'npm_package_json',
      'npm_package_name',
      'npm_package_version',
    ]),
  },
  yarn: {
    label: 'Yarn',
    portableShell: true,
  },
  'yarn-classic': {
    convertsSlashes: true,
    label: 'Yarn v1',
  },
};

/** Runners that package managers of the same name are, i.e. all of them but pnpm and Yarn */
const SAME_NAME_RUNNERS: ReadonlySet<Runner> = new Set(['aube', 'npm', 'upm']);

/** The first number of a version or a version range, e.g. `1` in `^1.22.0` */
const MAJOR_VERSION = /\d+/;
/** A version range without an upper bound, e.g. `>=10`, which includes later major versions */
const UNBOUNDED_RANGE = /^\s*>/;

/**
 * Gets the runner for a package manager, e.g. the one in the `packageManager` or
 * `devEngines.packageManager` field of package.json.
 * @param name Name of the package manager, e.g. `yarn`
 * @param version Its version or version range, which tells Yarn v1 from Yarn v2+, and pnpm v10
 * from later versions, e.g. `1.22.22`
 * @returns The runner, or `undefined` if it's an unknown package manager or Yarn of an unknown
 * version
 */
export const getRunner = (name: string, version = '') => {
  const major = Number(MAJOR_VERSION.exec(version)?.[0]);

  if (name === 'pnpm') {
    // Unknown versions and ranges like `>=10` may be pnpm v11+, which doesn't set `HOME`
    return major <= 10 && !UNBOUNDED_RANGE.test(version) ? 'pnpm-10' : 'pnpm';
  }
  if (name !== 'yarn') {
    return setHas(SAME_NAME_RUNNERS, name) ? name : undefined;
  }
  if (major === 1) {
    return 'yarn-classic';
  }
  return major >= 2 ? 'yarn' : undefined;
};

/**
 * Gets how a runner runs the scripts.
 * @param runner What runs the scripts
 * @param isShellEmulated Whether pnpm's `shell-emulator` setting is on
 * @returns The runner's traits
 */
export const runnerTraits = (runner: Runner, isShellEmulated: boolean) =>
  // pnpm runs the scripts with Yarn's portable shell then
  isShellEmulated && (runner === 'pnpm' || runner === 'pnpm-10')
    ? {
        ...RUNNER_TRAITS[runner],
        portableShell: true,
      }
    : RUNNER_TRAITS[runner];

/**
 * Formats runners as a list for people, e.g. "pnpm and Yarn v1".
 * @param runners The runners to format
 * @returns The formatted list
 */
export const formatRunners = (runners: readonly Runner[]) =>
  listFormat.format(
    arrayIntersection(RUNNERS, runners).map((runner) => RUNNER_TRAITS[runner].label),
  );
