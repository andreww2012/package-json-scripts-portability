# package-json-scripts-portability

Finds package.json scripts that don't work the same on Windows, macOS and Linux, with npm, pnpm, Yarn or Bun, and suggests fixes.

Package managers run scripts with `sh` on macOS and Linux and with cmd.exe on Windows, and `sh` differs too: it's dash on Debian/Ubuntu and Bash 3.2 on macOS.
This package parses a script with [unbash](https://npmx.dev/unbash) and reports what breaks, or behaves differently, on some of these platforms:

- Commands that don't exist everywhere, e.g. `rm`, `cp`, `open` or `del`
- Shell syntax that cmd.exe or dash doesn't support, e.g. `FOO=1 cmd`, `$VAR`, single quotes, `;`, `&`, line breaks or `[[ ... ]]`
- Options that differ between GNU, BSD and Windows tools, e.g. `sed -i`, `grep -P` or `mkdir -p`
- Windows syntax that POSIX shells don't support, e.g. `%VAR%` or backslash paths

It also checks the scripts that other commands run, e.g. in `sh -c "..."`, `cross-env`, `concurrently` or `npx`.
Where a fix keeps the script working the same way, it's included, e.g. `rimraf dist` for `rm -rf dist`.
It only reads scripts: it doesn't run them, and doesn't check what's installed.

## Usage

```ts
import {analyzeScript, applyFix, formatPlatforms} from 'package-json-scripts-portability';

const [issue] = analyzeScript('rm -rf dist');
// {
//   messageId: 'unsupportedCommand',
//   data: {command: 'rm', suggestion: 'Use `rimraf` instead.'},
//   platforms: ['win32'],
//   pos: 0,
//   end: 2,
//   fix: {description: 'Replace `rm -rf` with `rimraf`.', edits: [{pos: 0, end: 6, text: 'rimraf'}]},
// }

if (issue?.fix) {
  applyFix('rm -rf dist', issue.fix); // 'rimraf dist'
}

formatPlatforms(['darwin', 'win32']); // 'macOS and Windows'
```

`analyzeScript(script, options?)` returns the issues of a script, with offsets into it.
Its options are:

- `dependencies`: the package's dependencies, e.g. to know that `del` is del-cli's binary
- `ignoreCommands`: commands that shouldn't be reported
- `portableShell`: whether the script runs in Yarn's portable shell (Yarn v2+), which supports POSIX syntax on all platforms
- `yarnClassic`: whether Yarn v1 runs the script, which doesn't set `HOME`, and replaces `/` with `\` in command names on Windows

The `data` of an issue depends on its `messageId`:

| `messageId`            | `data`                           |
| :--------------------- | :------------------------------- |
| `inconsistentBehavior` | `syntax`, `reason`, `suggestion` |
| `unsupportedCommand`   | `command`, `suggestion`          |
| `unsupportedSyntax`    | `syntax`, `suggestion`           |
| `unsupportedUsage`     | `usage`, `reason`, `suggestion`  |

## Setup checklist

This project was created from [@andreww2012](https://github.com/andreww2012)'s [generic TypeScript project template](https://github.com/andreww2012/typescript-project-template).
Review these things and you're good to go:

### `package.json`

- [ ] Review [the license](./LICENSE.md)
- [ ] Review the installed dependencies, `engines` and `devEngines` fields
- [ ] Review the scripts section
- [x] Add `keywords`

### pnpm settings

- [ ] Review [the pnpm workspace config file](./pnpm-workspace.yaml) (even if you don't use workspace/monorepo features, this file is the only way of configuring pnpm)

### oxfmt

- [ ] Review [the oxfmt config file](./oxfmt.config.ts), including the ignored files

### TypeScript

- [ ] Review the [TypeScript config file](./tsconfig.json)

### ESLint

- [ ] Review [the ESLint config file](./eslint.config.ts)

### CSpell

- [ ] Review [the CSpell config file](./cspell.config.ts)

### knip

- [ ] Review [the knip config file](./knip.config.ts)

### Vitest

- [ ] Review [the Vitest config file](./vitest.config.ts)

### tsdown

- [ ] Review [the tsdown config file](./tsdown.config.ts)

### CI

- [ ] Review [the CI workflow](./.github/workflows/ci.yml)
- [ ] Allow GitHub Actions to create pull requests in the repository settings (Actions → General), so that changesets can open release pull requests
- [ ] Set up [trusted publishing](https://docs.npmjs.com/trusted-publishers) on npm, so that CI can publish the package

### npm-check-updates

- [ ] Review [the `ncu` config file](./.ncurc.js), see [its options](https://github.com/andreww2012/typescript-project-template/tree/main/packages/npm-check-updates-config#options)

### Changesets

- [ ] Review [the changesets config file](./.changeset/config.json)

### Git

- [ ] Review [the `.gitignore` file](./.gitignore)
- [ ] Review [the `commitlint` config file](./commitlint.config.ts)
- [ ] Review [the `lefthook` config file](./lefthook.yml)

### AI

- [ ] Review [the `AGENTS.md` file](./AGENTS.md)

### ⚠️ Final TODO item

- [ ] Remove this checklist :-)
