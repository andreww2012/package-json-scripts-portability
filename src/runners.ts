import {listFormat} from './messages.ts';
import {
  allUnionMembers,
  arrayDifference,
  arrayIntersection,
  isSemverInRange,
  parseSemver,
  setHas,
} from './utils.ts';

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
export const PACKAGE_MANAGER_RUNNERS: readonly Runner[] = arrayDifference(RUNNERS, ['node']);

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
 * @param scriptName The script's name in `package.json`
 * @param scripts `true` for all scripts, `false` for none, or whether each script is
 * runner-agnostic, on top of the defaults
 * @returns Whether the script is runner-agnostic
 */
export const isRunnerAgnosticScript = (
  scriptName: string | undefined,
  scripts?: boolean | Readonly<Record<string, boolean>>,
) => {
  if (typeof scripts === 'boolean') {
    return scripts;
  }
  if (scriptName == null) {
    return false;
  }
  // Not `scripts[scriptName] ?? ...`: names like `constructor` are inherited properties. `null`
  // from JavaScript callers means the defaults too
  return scripts != null && Object.hasOwn(scripts, scriptName)
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

/** With `shell-emulator` on, pnpm runs the scripts with Yarn's portable shell */
const SHELL_EMULATOR_TRAITS: Readonly<Partial<Record<Runner, RunnerTraits>>> = {
  pnpm: {...RUNNER_TRAITS.pnpm, portableShell: true},
  'pnpm-10': {...RUNNER_TRAITS['pnpm-10'], portableShell: true},
};

/** Package managers whose runner always has the same name, i.e. all of them but pnpm and Yarn */
const SAME_NAME_RUNNERS: ReadonlySet<Runner> = new Set(['aube', 'npm', 'upm']);

/** A version in a version range, e.g. `1.22` in `^1.22 || ^4` */
const RANGE_VERSIONS = /\d+(?:\.\d+){0,2}/g;
/** Longer versions and version ranges are unknown: checking them takes too long */
const MAX_VERSION_CHARACTERS = 256;

/**
 * Gets major versions that a version or a version range matches, enough to tell whether it matches
 * versions before a major version, and versions from it on.
 * @param version A version, e.g. `1.22.22`, or a version range, e.g. `^1.22 || ^4`
 * @param major The major version, e.g. `2`
 * @returns The major versions, or none for an unknown version, e.g. `latest`
 */
const matchedMajors = (version: string, major: number) => {
  if (version.length > MAX_VERSION_CHARACTERS) {
    return [];
  }

  const exact = parseSemver(version);
  if (exact) {
    return [exact.major];
  }

  // A range matches intervals of versions, so it's enough to check 0.0.0, the major version, and
  // each version of the range along with the ones right after it, e.g. 2.0.0 for `>1`
  const candidates = [
    [0, 0, 0],
    [major, 0, 0],
    ...[...version.matchAll(RANGE_VERSIONS)].flatMap(([text]) => {
      const [first = 0, second = 0, third = 0] = text.split('.').map(Number);
      return [
        [first, second, third],
        [first, second, third + 1],
        [first, second + 1, 0],
        [first + 1, 0, 0],
      ];
    }),
  ];
  return candidates
    .filter((candidate) => isSemverInRange(candidate.join('.'), version))
    .map(([candidateMajor = 0]) => candidateMajor);
};

/**
 * Gets the runner for a package manager, e.g. the one in the `packageManager` or
 * `devEngines.packageManager` field of `package.json`.
 * @param name Name of the package manager, e.g. `yarn`
 * @param version Its version or version range, which tells Yarn v1 from Yarn v2+, and pnpm v10
 * from later versions, e.g. `1.22.22`
 * @returns The runner, or `undefined` if it's an unknown package manager or Yarn of an unknown
 * version
 */
export const getRunner = (name: string, version = '') => {
  if (name === 'pnpm') {
    // Unknown versions and ranges like `>=10` may be pnpm v11+, which doesn't set `HOME`
    const majors = matchedMajors(version, 11);
    return majors.length > 0 && majors.every((major) => major <= 10) ? 'pnpm-10' : 'pnpm';
  }
  if (name !== 'yarn') {
    return setHas(SAME_NAME_RUNNERS, name) ? name : undefined;
  }

  // A range like `>=1` may be either Yarn v1 or Yarn v2+
  const majors = matchedMajors(version, 2);
  const isClassic = majors.some((major) => major <= 1);
  if (isClassic === majors.some((major) => major >= 2)) {
    return undefined;
  }
  return isClassic ? 'yarn-classic' : 'yarn';
};

/**
 * Gets how a runner runs the scripts.
 * @param runner What runs the scripts
 * @param isShellEmulated Whether pnpm's `shell-emulator` setting is on
 * @returns The runner's traits
 */
export const runnerTraits = (runner: Runner, isShellEmulated: boolean) =>
  (isShellEmulated && SHELL_EMULATOR_TRAITS[runner]) || RUNNER_TRAITS[runner];

/**
 * Reads a runner's traits and remembers the values that were read.
 * An analysis gives the same result for all runners with the same values of the traits it read, so
 * it must read them only through this
 */
export class TraitsReader {
  readonly #readValues = new Map<keyof RunnerTraits, unknown>();
  readonly #traits: RunnerTraits;

  constructor(traits: RunnerTraits) {
    this.#traits = traits;
  }

  get<Key extends keyof RunnerTraits>(key: Key) {
    const value = this.#traits[key];
    this.#readValues.set(key, value);
    return value;
  }

  /** Checks whether other traits have the same values as the ones that were read */
  matches(traits: RunnerTraits) {
    return this.#readValues.entries().every(([key, value]) => traits[key] === value);
  }
}

/**
 * Formats runners as a list for people, e.g. "pnpm and Yarn v1".
 * @param runners The runners to format
 * @returns The formatted list
 */
export const formatRunners = (runners: readonly Runner[]) =>
  listFormat.format(
    arrayIntersection(RUNNERS, runners).map((runner) => RUNNER_TRAITS[runner].label),
  );
