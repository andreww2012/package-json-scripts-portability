import type {Statement, Word} from 'unbash';
import type {AnalyzeScriptOptions} from './analyze-script.ts';
import {checkCommandUsage} from './command-usage.ts';
import {
  CMD_BUILTINS,
  COMMANDS,
  EXEC_SUBCOMMANDS,
  EXEC_VALUE_OPTIONS,
  PACKAGE_MANAGER_VALUE_OPTIONS,
  PORTABLE_SHELL_BUILTINS,
  WRAPPER_VALUE_OPTIONS,
} from './commands.ts';
import {type Context, type Shell, withCovered} from './context.ts';
import {DEPENDENCY_BINARY, commandFix, pathCommandFix, replacement} from './fixes.ts';
import {NODE_SCRIPT_SUGGESTION, SHELL_SCRIPT_SUGGESTION, truncate} from './messages.ts';
import {PLATFORMS, POSIX_PLATFORMS, type Platform, WINDOWS_PLATFORMS} from './platforms.ts';
import type {Reporter, ScriptFix} from './reporter.ts';
import {
  ASSIGNMENT,
  WHITESPACE,
  isPlainAssignment,
  isShortOptionCluster,
  staticValue,
} from './words.ts';

interface InvocationResult {
  crossEnv: boolean;
  name: string | undefined;
  /** The innermost command that receives the arguments, e.g. `rm` in `cross-env A=1 rm -rf dist` */
  target: string | undefined;
}

const MAX_DEPTH = 10;

/** Where Yarn v1 replaces `/` with `\` in a command's name: at the start and after an operator */
const YARN_COMMAND_START = /(?:^|&&|&|\|\||\|)\s*$/;

/**
 * Checks whether a name is a package spec rather than a path, e.g. `@scope/name` or
 * `github:user/repo` (for `npx`)
 */
const isPackageSpec = (name: string) => name.startsWith('@') || name.includes(':');
const SHELL_SCRIPT = /\.(?:bash|command|sh|zsh)$/;
const WINDOWS_SCRIPT = /\.(?:bat|cmd|exe|ps1|vbs)$/i;

/** Exit statuses of commands that `exit` can replace at the end of a script */
const EXIT_STATUSES: ReadonlyMap<string, string> = new Map([
  [':', '0'],
  ['false', '1'],
  ['true', '0'],
]);

/**
 * Finds the command that a command runs, e.g. `rm` in `cross-env A=1 rm -rf dist`.
 * @param values The static values of the outer command's arguments
 * @param start Index of the first argument to consider
 * @param valueOptions Options of the outer command that take a value
 * @param shouldSkipAssignments Whether to skip `NAME=value` arguments
 * @returns Index of the nested command's name, or -1 if there is none
 */
const findCommandIndex = (
  values: readonly (string | undefined)[],
  start: number,
  valueOptions: readonly string[],
  shouldSkipAssignments = false,
) => {
  for (let index = start; index < values.length; index++) {
    const value = values[index];

    if (value == null) {
      return index;
    }
    if (value === '--') {
      return index + 1;
    }
    if (value.startsWith('-') && value.length > 1) {
      if (valueOptions.includes(value)) {
        index++;
      }
      continue;
    }
    if (!(shouldSkipAssignments && ASSIGNMENT.test(value))) {
      return index;
    }
  }

  return -1;
};

const isCommandOption = (value: string) => isShortOptionCluster(value, 'c');

export interface NestedWordsOptions {
  bashOptions?: ReadonlySet<string>;
  crossEnv: boolean;
  /** Whether `concurrently` runs the script, which expands globs of script names itself */
  maskScriptGlobs?: boolean;
  shell: Shell;
}

/** Analyzes words that a command runs as a script, e.g. in `sh -c "..."` */
type NestedWordsAnalyzer = (
  words: readonly Word[],
  context: Context,
  options: NestedWordsOptions,
) => void;

/** Checks commands, e.g. whether they're available everywhere, and the commands they run */
export class CommandChecker {
  readonly #analyzeNestedWords: NestedWordsAnalyzer;
  readonly #dependencies: ReadonlySet<string>;
  readonly #ignoredCommands: ReadonlySet<string>;
  /** Fixes that depend on where a command is, by the command's name, e.g. `exit 0` for `true` */
  readonly #positionalFixes = new Map<Word, ScriptFix>();
  readonly #reporter: Reporter;

  constructor(
    reporter: Reporter,
    {dependencies = [], ignoreCommands = []}: AnalyzeScriptOptions,
    analyzeNestedWords: NestedWordsAnalyzer,
  ) {
    this.#reporter = reporter;
    this.#dependencies = new Set(dependencies);
    this.#ignoredCommands = new Set(ignoreCommands);
    this.#analyzeNestedWords = analyzeNestedWords;
  }

  /**
   * Adds fixes for commands that end the script, which can change what follows them.
   * @param statements Top-level statements of a script
   */
  addPositionalFixes(statements: readonly Statement[]) {
    const last = statements.at(-1);
    if (!last || last.background) {
      return;
    }

    const list = last.command;
    const commands = list.type === 'AndOr' ? list.commands : [list];
    const final = commands.at(-1);

    // `exit` also skips the commands that follow, e.g. in `tsc || true && vite build`
    if (
      final?.type === 'Command' &&
      final.name &&
      final.prefix.length === 0 &&
      final.suffix.length === 0
    ) {
      const status = EXIT_STATUSES.get(staticValue(final.name) || '');
      if (status != null) {
        this.#positionalFixes.set(
          final.name,
          replacement(final.name, final.name.text, `exit ${status}`),
        );
      }
    }

    // In `export A=1 && jest`, only `jest` uses the variables
    const [exporting, command] = commands;
    if (
      list.type === 'AndOr' &&
      list.operators.length === 1 &&
      list.operators[0] === '&&' &&
      exporting?.type === 'Command' &&
      exporting.name &&
      staticValue(exporting.name) === 'export' &&
      exporting.prefix.length === 0 &&
      exporting.suffix.length > 0 &&
      exporting.suffix.every(isPlainAssignment) &&
      command?.type === 'Command' &&
      command.name
    ) {
      this.#positionalFixes.set(exporting.name, {
        description: 'Replace `export ... &&` with `cross-env`.',
        edits: [
          {end: exporting.name.end, pos: exporting.name.pos, text: 'cross-env'},
          {end: command.pos, pos: exporting.end, text: ' '},
        ],
      });
    }
  }

  #checkCommandAvailability(
    name: string,
    nameWord: Word,
    argumentWords: readonly Word[],
    context: Context,
  ) {
    if (name === 'del' && this.#dependencies.has('del-cli')) {
      return this.#reporter.report(
        context,
        nameWord,
        'inconsistentBehavior',
        {
          reason: "cmd.exe's builtin `del` takes precedence over del-cli's `del` binary",
          suggestion: 'Use `del-cli` instead.',
          syntax: '`del`',
        },
        WINDOWS_PLATFORMS,
        replacement(nameWord, nameWord.text, 'del-cli'),
      );
    }

    if (context.portable && PORTABLE_SHELL_BUILTINS.has(name)) {
      return [];
    }

    const lowerCaseName = name.toLowerCase();
    let info = COMMANDS.get(name);

    // Windows commands are case-insensitive
    if (!info) {
      const windowsInfo = COMMANDS.get(lowerCaseName);
      if (windowsInfo && !windowsInfo.platforms.includes('win32')) {
        info = windowsInfo;
      }
    }

    if (!info) {
      return [];
    }

    let {platforms} = info;

    if (info.bashBuiltin && context.shell === 'bash') {
      platforms = platforms.filter((platform) => platform !== 'linux');
    }

    if (context.portable && CMD_BUILTINS.has(lowerCaseName)) {
      platforms = PLATFORMS;
    }

    return this.#reporter.report(
      context,
      nameWord,
      'unsupportedCommand',
      {command: name, suggestion: info.suggestion},
      platforms,
      this.#positionalFixes.get(nameWord) ||
        commandFix(name, nameWord, argumentWords, context.source),
    );
  }

  /**
   * Checks a command and the commands that it runs.
   * @param nameWord The command's name, e.g. `rm`
   * @param argumentWords The words that follow it
   * @param context Where the command is
   * @param depth How many commands run this command, e.g. 1 for `rm` in `cross-env A=1 rm`
   * @param isCrossSpawned Whether cross-spawn runs the command (in `cross-env`), which works with
   * paths and shebangs on Windows
   * @returns What the command is, and what it runs
   */
  checkInvocation(
    nameWord: Word,
    argumentWords: Word[],
    context: Context,
    depth: number,
    isCrossSpawned = false,
  ) {
    const name = staticValue(nameWord);
    const result: InvocationResult = {
      crossEnv: name === 'cross-env' || name === 'cross-env-shell',
      name,
      target: name,
    };

    if (name == null || depth > MAX_DEPTH) {
      return result;
    }

    // An ignored command isn't reported, but the commands it runs are
    if (this.#ignoredCommands.has(name)) {
      // Not `||`: the target of a command named `""` is empty
      result.target = this.#checkWrapped(name, argumentWords, context, depth)?.target ?? name;
      return result;
    }

    const covered: Platform[] = [];

    if (SHELL_SCRIPT.test(name)) {
      covered.push(
        ...this.#reporter.report(
          context,
          nameWord,
          'unsupportedCommand',
          {
            command: truncate(nameWord.text),
            suggestion: SHELL_SCRIPT_SUGGESTION,
          },
          WINDOWS_PLATFORMS,
        ),
      );
    } else if (WINDOWS_SCRIPT.test(name)) {
      covered.push(
        ...this.#reporter.report(
          context,
          nameWord,
          'unsupportedCommand',
          {command: truncate(nameWord.text), suggestion: NODE_SCRIPT_SUGGESTION},
          POSIX_PLATFORMS,
        ),
      );
    } else if (name.includes('/') && !isPackageSpec(name)) {
      // Yarn v1 replaces `/` with `\` in some command names on Windows, which then run the `.cmd`
      // file of a dependency's binary
      const isConverted =
        context.convertsSlashes &&
        depth === 0 &&
        DEPENDENCY_BINARY.test(name) &&
        YARN_COMMAND_START.test(context.source.slice(0, nameWord.pos));

      if (!isCrossSpawned && !isConverted) {
        covered.push(
          ...this.#reporter.reportSyntax(
            context,
            nameWord,
            'posix',
            true,
            'unsupportedSyntax',
            {
              suggestion:
                'cmd.exe treats `/` as an option prefix; run files with `node`, and binaries by their name instead.',
              syntax: `Running a command by its path (\`${truncate(nameWord.text)}\`)`,
            },
            pathCommandFix(name, nameWord),
          ),
        );
      }
    } else {
      covered.push(...this.#checkCommandAvailability(name, nameWord, argumentWords, context));
    }

    covered.push(...this.#checkUsage(name, nameWord, argumentWords, context));

    // A command that runs in a command that doesn't work on a platform isn't reported for it too.
    // Not `||`: the target of a command named `""` is empty
    result.target =
      this.#checkWrapped(name, argumentWords, withCovered(context, covered), depth)?.target ?? name;

    return result;
  }

  #checkUsage(name: string, nameWord: Word, argumentWords: Word[], context: Context) {
    const values = argumentWords.map(staticValue);
    // A wrapper's options end where the command it runs starts, e.g. `xargs prettier --write`
    const wrapperValueOptions = WRAPPER_VALUE_OPTIONS.get(name);
    const commandIndex = wrapperValueOptions
      ? findCommandIndex(values, 0, wrapperValueOptions)
      : -1;
    const optionsEnd = Math.min(
      values.includes('--') ? values.indexOf('--') : values.length,
      commandIndex === -1 ? values.length : commandIndex,
    );

    return checkCommandUsage(
      name,
      argumentWords.map((argument, index) => ({text: argument.text, value: values[index]})),
      {bash: context.shell === 'bash', optionsEnd, portable: context.portable},
    ).flatMap(({argumentIndex, data, fix, messageId, platforms}) => {
      const fixedWord = fix && argumentWords[fix.argumentIndex];
      return this.#reporter.report(
        context,
        argumentIndex == null
          ? nameWord
          : {end: argumentWords[argumentIndex]?.end || nameWord.end, pos: nameWord.pos},
        messageId,
        data,
        platforms,
        fix && fixedWord
          ? {
              description: fix.description,
              edits: [{end: fixedWord.end, pos: fixedWord.pos, text: fix.text}],
            }
          : undefined,
      );
    });
  }

  #checkWrapped(name: string, argumentWords: Word[], context: Context, depth: number) {
    const values = argumentWords.map(staticValue);

    // `.` is the package in the current directory for `npx` and the like, not a command
    const invoke = (index: number, nestedContext = context, isCrossSpawned = false) => {
      const word = argumentWords[index];
      return !word || values[index] === '.'
        ? undefined
        : this.checkInvocation(
            word,
            argumentWords.slice(index + 1),
            nestedContext,
            depth + 1,
            isCrossSpawned,
          );
    };

    const nestedShellString = (
      index: number,
      shell: Shell = 'native',
      bashOptions?: ReadonlySet<string>,
    ) => {
      const word = argumentWords[index];
      if (word && depth < MAX_DEPTH) {
        this.#analyzeNestedWords([word], context, {
          bashOptions,
          crossEnv: false,
          maskScriptGlobs: name === 'concurrently',
          shell,
        });
      }
    };

    // The script of a shell's `-c` option, e.g. in `sh -c "..."`
    const commandStringIndex = () => {
      const index = values.findIndex((value) => value != null && isCommandOption(value));
      return index === -1 ? -1 : index + 1;
    };
    // `-c`/`--call` of npx and `npm exec` (a shell string), which is only their option before the
    // command they run
    const callIndex = (start: number, valueOptions: readonly string[]) => {
      const commandIndex = findCommandIndex(values, start, [...valueOptions, '--call', '-c']);
      const end = commandIndex === -1 ? values.length : commandIndex;
      const index = values.findIndex(
        (value, i) => i >= start && i < end && (value === '-c' || value === '--call'),
      );
      return index === -1 ? -1 : index + 1;
    };

    switch (name) {
      case 'bash':
      case 'ksh':
      case 'zsh': {
        nestedShellString(
          commandStringIndex(),
          'bash',
          // e.g. `bash -O globstar -c "..."`
          new Set(
            values.filter(
              (value, index): value is string => Boolean(value) && values[index - 1] === '-O',
            ),
          ),
        );
        return undefined;
      }

      case 'concurrently': {
        // Its commands are usually quoted and contain spaces, unlike its options' values
        argumentWords.forEach((argument, index) => {
          if (
            argument.parts?.some(
              (part) => part.type === 'DoubleQuoted' || part.type === 'SingleQuoted',
            ) &&
            WHITESPACE.test(argument.value)
          ) {
            nestedShellString(index);
          }
        });
        return undefined;
      }

      case 'cross-env':
      case 'cross-env-shell': {
        const index = values.findIndex((value) => value == null || !ASSIGNMENT.test(value));

        if (name === 'cross-env') {
          return invoke(index, {...context, crossEnv: true}, true);
        }

        // It joins its arguments into a single script, e.g. `cross-env-shell npm install $DEP`
        if (index !== -1 && depth < MAX_DEPTH) {
          this.#analyzeNestedWords(argumentWords.slice(index), context, {
            crossEnv: true,
            shell: 'native',
          });
        }
        return undefined;
      }

      case 'dash':
      case 'sh': {
        nestedShellString(commandStringIndex(), 'sh');
        return undefined;
      }

      case 'bun':
      case 'npm':
      case 'pnpm':
      case 'yarn': {
        // e.g. `pnpm exec rm -rf dist`
        const subcommand = findCommandIndex(values, 0, PACKAGE_MANAGER_VALUE_OPTIONS);
        if (!EXEC_SUBCOMMANDS[name].includes(values[subcommand] || '')) {
          return undefined;
        }

        const call = callIndex(subcommand + 1, EXEC_VALUE_OPTIONS);
        if (name === 'npm' && call !== -1) {
          nestedShellString(call);
          return undefined;
        }

        return invoke(findCommandIndex(values, subcommand + 1, EXEC_VALUE_OPTIONS));
      }

      case 'npx':
      case 'pnpx': {
        const call = callIndex(0, WRAPPER_VALUE_OPTIONS.get(name) || []);
        if (call !== -1) {
          nestedShellString(call);
          return undefined;
        }
        break;
      }

      default: {
        break;
      }
    }

    const valueOptions = WRAPPER_VALUE_OPTIONS.get(name);

    // `command -v` looks a command up instead of running it
    return !valueOptions ||
      (name === 'command' && values.some((value) => value === '-v' || value === '-V'))
      ? undefined
      : invoke(findCommandIndex(values, 0, valueOptions, name === 'env'));
  }
}
