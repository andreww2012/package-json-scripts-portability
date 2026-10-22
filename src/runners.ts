import {allUnionMembers, setHas} from '@andreww2012/unutils';

/** What can run the scripts: a package manager, or `node` for `node --run` */
export type Runner = 'aube' | 'node' | 'npm' | 'pnpm' | 'upm' | 'yarn' | 'yarn-classic';

export const RUNNERS: readonly Runner[] = allUnionMembers<Runner, {readonly: true}>()([
  'aube',
  'node',
  'npm',
  'pnpm',
  'upm',
  'yarn',
  'yarn-classic',
]);

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

/** Runners that package managers of the same name are, i.e. all of them but Yarn */
const SAME_NAME_RUNNERS: ReadonlySet<Runner> = new Set(['aube', 'npm', 'pnpm', 'upm']);

/** The first number of a version or a version range, e.g. `1` in `^1.22.0` */
const MAJOR_VERSION = /\d+/;

/**
 * Gets the runner for a package manager, e.g. the one in the `packageManager` or
 * `devEngines.packageManager` field of package.json.
 * @param name Name of the package manager, e.g. `yarn`
 * @param version Its version or version range, which tells Yarn v1 from Yarn v2+, e.g. `1.22.22`
 * @returns The runner, or `undefined` if it's an unknown package manager or Yarn of an unknown
 * version
 */
export const getRunner = (name: string, version = '') => {
  if (name !== 'yarn') {
    return setHas(SAME_NAME_RUNNERS, name) ? name : undefined;
  }

  const major = Number(MAJOR_VERSION.exec(version)?.[0]);
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
  runner === 'pnpm' && isShellEmulated
    ? {
        ...RUNNER_TRAITS.pnpm,
        portableShell: true,
      }
    : RUNNER_TRAITS[runner];
