# package-json-scripts-portability [![npm](https://img.shields.io/npm/v/package-json-scripts-portability)](https://npmx.dev/package-json-scripts-portability)

Finds package.json scripts that don't work the same on Windows, macOS and Linux, and suggests fixes.
Package managers run scripts with cmd.exe on Windows and with `sh` elsewhere, and `sh` differs too: it's dash on Debian/Ubuntu and Bash 3.2 on macOS.

- 🖥️ **Every platform**: cmd.exe on Windows, Bash 3.2 and BSD tools on macOS, dash and GNU tools on Linux.
- 🔍 **Commands, syntax and options**: `rm`, `open`, `FOO=1 cmd`, `$VAR`, single quotes, `;`, `&`, `[[ ... ]]`, `sed -i`, `mkdir -p`, `%VAR%`, backslash paths and many more.
- 🪆 **Nested scripts**: also checks what `sh -c`, [cross-env], [concurrently], `npx` and the like run.
- 🔀 **Fallbacks**: `rm -rf dist || rmdir /s /q dist` works everywhere, so it's not reported.
- 🔧 **Safe fixes**: only when the script keeps working the same way, e.g. `rimraf dist` for `rm -rf dist`.
- 📦 **Package managers**: npm, pnpm, Yarn, aube, upm and `node --run`, including the quirks of Yarn v1 and the portable shell of Yarn v2+.
- 🔒 **Static**: parses the scripts with [unbash] and never runs them.

## Examples

| Script                         | Breaks on      | Why                                                         | Fix                                     |
| ------------------------------ | -------------- | ----------------------------------------------------------- | --------------------------------------- |
| `rm -rf dist`                  | Windows        | There's no `rm`                                             | `rimraf dist`                           |
| `NODE_ENV=production webpack`  | Windows        | cmd.exe doesn't support inline environment variables        | `cross-env NODE_ENV=production webpack` |
| `eslint 'src/**/*.ts'`         | Windows        | cmd.exe passes the single quotes on to the command          | `eslint "src/**/*.ts"`                  |
| `tsc; vite build`              | Windows        | cmd.exe doesn't support `;`                                 | `tsc && vite build`                     |
| `npm run a & npm run b`        | Windows        | cmd.exe runs the commands one by one                        |                                         |
| `node x.js > /dev/null`        | Windows        | There's no `/dev/null`                                      | `node x.js`                             |
| `mkdir -p dist/assets`         | Windows        | cmd.exe's `mkdir` doesn't support `-p`                      |                                         |
| `open http://localhost:3000`   | Linux, Windows | `open` only exists on macOS                                 |                                         |
| `sed -i 's/a/b/' file.txt`     | macOS, Windows | BSD `sed -i` requires a backup suffix, Windows has no `sed` |                                         |
| `sh -c "[[ -f x ]] && node x"` | Linux, Windows | dash doesn't support `[[ ... ]]`, Windows has no `sh`       |                                         |
| `node scripts\build.js`        | macOS, Linux   | POSIX shells treat backslashes as escape characters         | `node scripts/build.js`                 |
| `if exist dist rd /s /q dist`  | macOS, Linux   | It's cmd.exe syntax                                         |                                         |

The scripts are shown as they are after JSON decoding: in package.json, `node scripts\build.js` is written as `"node scripts\\build.js"`.

## Usage

```sh
pnpm i package-json-scripts-portability
```

Replace `pnpm i` with the installation command of your package manager.

Node.js 22+ is required.

```ts
import {analyzeScript, applyFix, formatPlatforms} from 'package-json-scripts-portability';

const script = 'rm -rf dist';

analyzeScript(script).forEach((issue) => {
  // {
  //   messageId: 'unsupportedCommand',
  //   data: {command: 'rm', suggestion: 'Use `rimraf` instead.'},
  //   platforms: ['win32'],
  //   pos: 0,
  //   end: 2,
  //   fix: {description: 'Replace `rm -rf` with `rimraf`.', edits: [{pos: 0, end: 6, text: 'rimraf'}]},
  //   runners: ['npm'],
  // }

  script.slice(issue.pos, issue.end); // 'rm'
  formatPlatforms(issue.platforms); // 'Windows'

  if (issue.fix) {
    applyFix(script, issue.fix); // 'rimraf dist'
  }
});
```

### Checking a package.json

Pass the dependencies and tell what runs the scripts:

```ts
import {readFile} from 'node:fs/promises';
import {
  type AnalyzeScriptOptions,
  analyzeScript,
  formatPlatforms,
  getRunner,
} from 'package-json-scripts-portability';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
// e.g. `pnpm@10.0.0`, or `yarn@1.22.22` for Yarn v1
const packageManager: string = packageJson.packageManager || '';
const [name = '', version] = packageManager.split('@', 2);
const options: AnalyzeScriptOptions = {
  dependencies: Object.keys({...packageJson.dependencies, ...packageJson.devDependencies}),
  runner: getRunner(name, version),
};

Object.entries<string>(packageJson.scripts || {}).forEach(([scriptName, script]) => {
  analyzeScript(script, options).forEach((issue) => {
    const text = script.slice(issue.pos, issue.end);
    console.log(`${scriptName}: \`${text}\` breaks on ${formatPlatforms(issue.platforms)}`);
  });
});
```

### Messages

Issues don't contain ready-made messages: `messageId` tells the kind of the issue, and `data` has the parts of the message.
`platforms` and `runners` aren't in `data`, so that you can format them yourself, for example with `formatPlatforms` and `formatRunners`.

| `messageId`            | `data`                           | Example message                                                                                                                                 |
| ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupportedCommand`   | `command`, `suggestion`          | `rm` is not available on Windows. Use `rimraf` instead.                                                                                         |
| `unsupportedSyntax`    | `syntax`, `suggestion`           | The `;` command separator is not supported on Windows. Use `&&` instead.                                                                        |
| `unsupportedUsage`     | `usage`, `reason`, `suggestion`  | `mkdir -p` is not supported on Windows: cmd.exe's `mkdir` doesn't support POSIX options. Use a Node.js script instead.                          |
| `inconsistentBehavior` | `syntax`, `reason`, `suggestion` | The `&` operator works differently on Windows: cmd.exe runs the commands sequentially instead of in the background. Use `concurrently` instead. |

These messages come from the following templates.
They use ESLint's placeholder syntax, so in an ESLint rule you can pass them as `meta.messages` and the `data` below to `context.report()`.

```ts
import {
  type ScriptIssue,
  type ScriptIssueMessageId,
  formatPlatforms,
} from 'package-json-scripts-portability';

const MESSAGES: Readonly<Record<ScriptIssueMessageId, string>> = {
  inconsistentBehavior: '{{syntax}} works differently on {{platforms}}: {{reason}}. {{suggestion}}',
  unsupportedCommand: '`{{command}}` is not available on {{platforms}}. {{suggestion}}',
  unsupportedSyntax: '{{syntax}} is not supported on {{platforms}}. {{suggestion}}',
  unsupportedUsage: '`{{usage}}` is not supported on {{platforms}}: {{reason}}. {{suggestion}}',
};
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

const formatIssue = (issue: ScriptIssue) => {
  const data: Record<string, string> = {...issue.data, platforms: formatPlatforms(issue.platforms)};
  return MESSAGES[issue.messageId].replaceAll(PLACEHOLDER, (_, key: string) => data[key] || '');
};
```

## Package managers

By default, the scripts are checked as npm runs them: with `sh` on macOS and Linux, and with cmd.exe on Windows.
If something else runs them, set `runner`, e.g. with [`getRunner`](#api) from the `packageManager` field.
It decides which shell runs the scripts and which environment variables they get.
For example, unlike npm and pnpm v10, pnpm v11+ doesn't set `HOME`, which Windows doesn't set either, and `node --run` doesn't set `npm_*` variables.

| Scripts are run by | Options                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| npm                | None, or `runner: 'npm'`                                                             |
| pnpm v11+          | `runner: 'pnpm'`, and `shellEmulator: true` if its `shell-emulator` setting is on    |
| pnpm v10 and older | `runner: 'pnpm-10'`, and `shellEmulator: true` if its `shell-emulator` setting is on |
| [aube]             | `runner: 'aube'`                                                                     |
| [upm]              | `runner: 'upm'`                                                                      |
| Yarn v2+           | `runner: 'yarn'`                                                                     |
| Yarn v1            | `runner: 'yarn-classic'`                                                             |
| `node --run`       | `runner: 'node'`                                                                     |
| Bun                | None, but the results for Windows only apply to `bun run --shell=system`             |
| Deno or Nub        | Not supported yet, as they run the scripts with their own shells                     |

Whatever runs the scripts, the commands that package managers run are checked too, e.g. in `pnpm exec`, `aubx` or `upx`.

### Several runners

Pass several runners to report what breaks with any of them, e.g. `runner: ['npm', 'pnpm']`.
Each issue lists the runners that have it in `runners`, and is on the platforms where any of them has it.

### Runner-agnostic scripts

Some scripts can run with any package manager.
For example, the install scripts of a published package run with the package manager of whoever installs it.
Pass the script's name in `scriptName`, and such scripts are checked with all package managers instead of `runner`:

```ts
import {analyzeScript, formatRunners} from 'package-json-scripts-portability';

const script = 'cross-env CONFIG=${HOME}/.config node install.js';

analyzeScript(script, {runner: 'npm', scriptName: 'postinstall'}).forEach((issue) => {
  formatRunners(issue.runners); // 'aube, pnpm, upm, and Yarn v1', since only npm and pnpm v10 set `HOME`
});
```

By default, `preinstall`, `install`, `postinstall` and `prepare` (which runs when the package is installed from git) are runner-agnostic.
`runnerAgnosticScripts` changes that: `true` makes all scripts runner-agnostic, `false` none, and an object sets it for each script on top of the defaults, e.g. `{prepare: false, release: true}`.
Install scripts of a private package only run with its own package manager, so pass `runnerAgnosticScripts: false` for one.

Runner-agnostic scripts aren't checked with `node --run`, since it doesn't install packages.

## Options

| Option                  | Default                       | Description                                                                                                                     |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `dependencies`          | `[]`                          | Names of the package's dependencies. With [del-cli], `del` is reported as cmd.exe's builtin, which takes precedence on Windows. |
| `ignoreCommands`        | `[]`                          | Commands not to report, e.g. ones that you install on every platform. The commands that they run are still checked.             |
| `runner`                | `'npm'`                       | What runs the scripts, or a list of runners, see [Package managers](#package-managers).                                         |
| `runnerAgnosticScripts` | Install scripts and `prepare` | Scripts that are checked with all package managers, see [Runner-agnostic scripts](#runner-agnostic-scripts).                    |
| `scriptName`            | None                          | The script's name in package.json, e.g. `postinstall`, to tell whether it's runner-agnostic.                                    |
| `shellEmulator`         | `false`                       | Whether pnpm's `shell-emulator` setting is on, so that it runs the scripts with Yarn's shell.                                   |

## API

- `analyzeScript(script, options?)` returns the issues of a script, which are not necessarily sorted by position.
  Each issue has:
  - `messageId` and `data`: see [Messages](#messages).
  - `platforms`: where the script doesn't work as intended, as `process.platform` values: `'darwin'`, `'linux'` or `'win32'`.
  - `pos` and `end`: the offsets of the reported text in the script, `end` excluded.
  - `fix`: a `description` and non-overlapping `edits` (`pos`, `end`, `text`), if the issue has a fix that keeps the script working the same way.
  - `runners`: the runners that have the issue, e.g. `['pnpm', 'yarn-classic']`.
- `applyFix(script, fix)` returns the script with all edits of a fix applied.
- `formatPlatforms(platforms)` formats platforms for people, e.g. `'macOS, Linux, and Windows'`.
- `formatRunners(runners)` formats runners for people, e.g. `'pnpm and Yarn v1'`.
- `getRunner(name, version?)` gets the `runner` value for a package manager, e.g. from the `packageManager` or `devEngines.packageManager` field: `getRunner('yarn', '1.22.22')` is `'yarn-classic'`.
  It returns `undefined` for other package managers, like Bun, and for Yarn without a version, since Yarn v1 and v2+ run scripts differently.
  For pnpm, it returns `'pnpm-10'` for v10 and older, and `'pnpm'` otherwise, including for no version and for ranges like `>=10`, which allow v11+.
- `PLATFORMS` is the list of all platforms: `['darwin', 'linux', 'win32']`.
- `RUNNER_AGNOSTIC_SCRIPTS` is the set of the scripts that are runner-agnostic by default: `preinstall`, `install`, `postinstall` and `prepare`.
- `RUNNERS` is the list of all `runner` values: `['aube', 'node', 'npm', 'pnpm', 'pnpm-10', 'upm', 'yarn', 'yarn-classic']`.

The types `AnalyzeScriptOptions`, `Platform`, `Runner`, `ScriptEdit`, `ScriptFix`, `ScriptIssue` and `ScriptIssueMessageId` are exported too.

## Limitations

- Scripts are only parsed, so it doesn't know which commands are installed or which files exist.
  Commands from npm packages, like `rimraf`, are assumed to work everywhere.
- The scripts of shells (`sh -c`), cross-env, concurrently, `npx`, `npm exec`, `pnpm dlx` and the like, and of commands like `env` and `xargs` are checked.
  Other tools that run commands, like `nodemon --exec`, are not, since each of them takes different options.
- Unquoted globs are only reported if they contain `**/`: many tools expand simpler globs themselves when the shell doesn't.
- A script that isn't valid shell syntax is only checked for cmd.exe syntax like `if exist`.
- `node --run` and upm don't run `pre` and `post` scripts, which isn't checked.
- Whether the package is private isn't known, so its install scripts are runner-agnostic, unless you tell otherwise.

## License

[MIT](./LICENSE.md)

[aube]: https://aube.sh
[concurrently]: https://npmx.dev/concurrently
[cross-env]: https://npmx.dev/cross-env
[del-cli]: https://npmx.dev/del-cli
[unbash]: https://npmx.dev/unbash
[upm]: https://npmx.dev/upm
