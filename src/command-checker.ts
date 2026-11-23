import type {CommandArgument, Redirection, Statement, Word} from 'unbash';
import {type UsageIssue, checkCommandUsage} from './command-usage.ts';
import {
  CMD_BUILTINS,
  COMMANDS,
  EXEC_SUBCOMMANDS,
  EXEC_VALUE_OPTIONS,
  OS_COMMANDS,
  PACKAGE_MANAGER_VALUE_OPTIONS,
  PORTABLE_SHELL_BUILTINS,
  SHELL_STATE_COMMANDS,
  TIMEOUT_VALUE_OPTIONS,
  WRAPPER_VALUE_OPTIONS,
} from './commands.ts';
import {type Context, type Shell, withCovered} from './context.ts';
import {DEPENDENCY_BINARY, commandFix, pathCommandFix, replacement} from './fixes.ts';
import {NODE_SCRIPT_SUGGESTION, SHELL_SCRIPT_SUGGESTION, truncate} from './messages.ts';
import {
  LINUX_PLATFORMS,
  PLATFORMS,
  POSIX_PLATFORMS,
  type Platform,
  WINDOWS_PLATFORMS,
} from './platforms.ts';
import type {Reporter, ScriptFix} from './reporter.ts';
import type {TraitsReader} from './runners.ts';
import {arrayDifference, arrayIncludes, arrayIntersection, setHas, slidingWindow} from './utils.ts';
import {
  ASSIGNMENT,
  WHITESPACE,
  isPlainAssignment,
  isShortOptionCluster,
  staticValue,
} from './words.ts';

interface InvocationResult {
  /**
   * Where the arguments of `cross-env` start, if it runs the command, also behind another command,
   * e.g. in `npx cross-env A=1 jest`
   */
  crossEnvStart: number | undefined;
  name: string | undefined;
  /** The innermost command that receives the arguments, e.g. `rm` in `cross-env A=1 rm -rf dist` */
  target: string | undefined;
}

/**
 * How many commands that run other commands are followed, e.g. `cross-env` in `cross-env A=1 rm`,
 * and how deep nested scripts are analyzed, e.g. in `sh -c "..."`
 */
export const MAX_DEPTH = 10;

/**
 * Checks whether Yarn v1 replaces `/` with `\` in a command's name: at the start of the script and
 * after an operator, i.e. `&&`, `&`, `||` or `|`.
 * @param source The source that the name is in
 * @param position Where the name starts in the source
 * @returns Whether it does
 */
const isYarnCommandStart = (source: string, position: number) => {
  let index = position;
  while (index > 0 && WHITESPACE.test(source[index - 1] || '')) {
    index--;
  }

  const previous = source[index - 1];
  return index === 0 || previous === '&' || previous === '|';
};

/**
 * Checks whether a command's name is in the wrong case, e.g. `MKDIR` for `mkdir`.
 * Linux finds commands by their exact name, unlike cmd.exe and macOS (with its default file system)
 * @param name Name that the command was invoked with
 * @returns Whether only its lower case is a known OS command
 */
const isWrongCase = (name: string) => {
  const lowerCaseName = name.toLowerCase();
  return name !== lowerCaseName && !COMMANDS.has(name) && OS_COMMANDS.has(lowerCaseName);
};

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

/** Options of `npx` and `npm exec` that take a shell string */
const CALL_OPTIONS: ReadonlySet<string> = new Set(['--call', '-c']);

/** Options of pnpm and aube that make the command and its arguments a shell line */
const SHELL_MODE_OPTIONS: ReadonlySet<string> = new Set(['--shell-mode', '-c']);

/** A word of letters, digits and underscores, e.g. a variable name */
const IDENTIFIER = /\w+/g;

const SHELL_OPTION = /^[+-]./;
/** A shell option that takes a value, also at the end of a cluster, e.g. `-o` in `-euo pipefail` */
const SHELL_VALUE_OPTION = /^(?:[+-][a-z]*o|--init-file|--rcfile)$/i;

/**
 * Finds the script of a shell's `-c` option, e.g. in `sh -c "..."`.
 * The shell's options end at the script file, whose arguments are its own, e.g. `-c` in
 * `sh build.sh -c x`.
 * @param values The static values of the shell's arguments
 * @returns Index of the script, or -1 if there is none
 */
const findCommandString = (values: readonly (string | undefined)[]) => {
  let index = 0;

  while (index < values.length) {
    const value = values[index];
    if (value == null || !SHELL_OPTION.test(value)) {
      break;
    }

    index += SHELL_VALUE_OPTION.test(value) ? 2 : 1;
    if (isShortOptionCluster(value, 'c')) {
      return index;
    }
  }

  return -1;
};

/**
 * Checks whether a piece of a script mentions a variable that assignments set, e.g. `$PORT` for
 * `PORT=3000`.
 * @param text The piece of the script
 * @param items The assignments, among other items of a command
 * @returns Whether it does, even if only as a word that the shell doesn't expand
 */
const doesMentionVariables = (text: string, items: readonly (CommandArgument | Redirection)[]) => {
  const names = new Set(
    items.filter((item) => item.type === 'Assignment').map((assignment) => assignment.name),
  );
  return (text.match(IDENTIFIER) || []).some((word) => names.has(word));
};

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

/** The analysis options that command checks use, prepared once for all runners */
export interface CommandOptions {
  /** Names of the package's dependencies */
  dependencies: readonly string[];
  /** Commands that shouldn't be reported */
  ignoredCommands: ReadonlySet<string>;
}

/**
 * Finds the issues with a command's options and arguments, e.g. `sed -i`.
 * @param name Name that the command was invoked with
 * @param argumentWords The words that follow it
 * @param values Their static values
 * @param context Where the command is
 * @returns The issues, which aren't reported yet
 */
const findUsageIssues = (
  name: string,
  argumentWords: readonly Word[],
  values: readonly (string | undefined)[],
  context: Context,
) => {
  // A wrapper's options end where the command it runs starts, e.g. `xargs prettier --write`
  const wrapperValueOptions = WRAPPER_VALUE_OPTIONS.get(name);
  const commandIndex = wrapperValueOptions ? findCommandIndex(values, 0, wrapperValueOptions) : -1;
  const separator = values.indexOf('--');
  const optionsEnd = Math.min(
    separator === -1 ? values.length : separator,
    commandIndex === -1 ? values.length : commandIndex,
  );

  const issues = checkCommandUsage(name, values, argumentWords, {
    bash: context.shell === 'bash',
    optionsEnd,
    portable: context.portable,
  });

  // A command in the wrong case is missing on Linux too, which is reported along with the other
  // platforms where it's missing, e.g. for `TIMEOUT 5 node x`
  return isWrongCase(name)
    ? issues.map((issue) =>
        issue.messageId === 'unsupportedCommand'
          ? {
              ...issue,
              platforms: arrayIntersection(PLATFORMS, [...issue.platforms, ...LINUX_PLATFORMS]),
            }
          : issue,
      )
    : issues;
};

/** Checks commands, e.g. whether they're available everywhere, and the commands they run */
export class CommandChecker {
  readonly #analyzeNestedWords: NestedWordsAnalyzer;
  readonly #options: CommandOptions;
  /** Fixes that depend on where a command is, by the command's name, e.g. `exit 0` for `true` */
  readonly #positionalFixes = new Map<Word, ScriptFix>();
  readonly #reporter: Reporter;
  readonly #runnerTraits: TraitsReader;

  constructor(
    reporter: Reporter,
    options: CommandOptions,
    analyzeNestedWords: NestedWordsAnalyzer,
    runnerTraits: TraitsReader,
  ) {
    this.#reporter = reporter;
    this.#options = options;
    this.#analyzeNestedWords = analyzeNestedWords;
    this.#runnerTraits = runnerTraits;
  }

  /**
   * Adds fixes for commands that end the script, which can change what follows them.
   * @param statements Top-level statements of a script
   * @param source The script's source
   */
  addPositionalFixes(statements: readonly Statement[], source: string) {
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
      command.name &&
      // `cross-env` can't run shell builtins, e.g. `cd` in `export A=1 && cd x`
      !SHELL_STATE_COMMANDS.has(staticValue(command.name) || '') &&
      // The shell expands the command's variables before `cross-env` sets them, e.g. in
      // `next dev -p $PORT`
      !doesMentionVariables(source.slice(command.pos, command.end), exporting.suffix)
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

  /**
   * Reports a command that isn't available on all platforms.
   * @param name Name that the command was invoked with
   * @param nameWord Word that the name comes from
   * @param argumentWords The words that follow it
   * @param context Where the command is
   * @param usageIssues The issues with the command's usage, e.g. on Linux for `TIMEOUT /T 5`
   * @returns The platforms of the report
   */
  #checkCommandAvailability(
    name: string,
    nameWord: Word,
    argumentWords: readonly Word[],
    context: Context,
    usageIssues: readonly UsageIssue[],
  ) {
    if (name === 'del' && this.#options.dependencies.includes('del-cli')) {
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
    const isNameWrongCase = isWrongCase(name);
    const info = COMMANDS.get(isNameWrongCase ? lowerCaseName : name);

    if (!info && !isNameWrongCase) {
      return [];
    }

    let platforms = info?.platforms || [];

    if (isNameWrongCase) {
      platforms = PLATFORMS.filter(
        (platform) =>
          // The usage report tells more, e.g. that `/T` in `TIMEOUT /T 5` is an option of cmd.exe
          usageIssues.every((issue) => !issue.platforms.includes(platform)) &&
          (platform === 'linux' ||
            platforms.includes(platform) ||
            // Yarn's shell only knows its builtins by their exact names, and Windows has no
            // executables for them, e.g. for `cd`
            (platform === 'win32' &&
              context.portable &&
              PORTABLE_SHELL_BUILTINS.has(lowerCaseName))),
      );
    } else if (info?.bashBuiltin && context.shell === 'bash') {
      platforms = arrayDifference(platforms, LINUX_PLATFORMS);
    }

    if (context.portable && CMD_BUILTINS.has(lowerCaseName)) {
      platforms = PLATFORMS;
    }

    return this.#reporter.report(
      context,
      nameWord,
      'unsupportedCommand',
      {
        command: name,
        suggestion: info?.suggestion || `Use \`${lowerCaseName}\` in lower case instead.`,
      },
      platforms,
      this.#positionalFixes.get(nameWord) ||
        commandFix(lowerCaseName, nameWord, argumentWords, context.source) ||
        // Where the command is everywhere else, the lower-case name runs the same program, apart
        // from `echo`, which is a builtin of `sh` but an executable on macOS
        (info || lowerCaseName === 'echo'
          ? undefined
          : replacement(nameWord, nameWord.text, lowerCaseName)),
    );
  }

  /**
   * Checks a command and the commands that it runs.
   * @param nameWord The command's name, e.g. `rm`
   * @param argumentWords The words that follow it
   * @param context Where the command is
   * @param depth How many commands run this command, e.g. 1 for `rm` in `cross-env A=1 rm`
   * @param isCrossSpawned Whether `cross-spawn` runs the command (in `cross-env`), which works with
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
      crossEnvStart: name === 'cross-env' || name === 'cross-env-shell' ? nameWord.end : undefined,
      name,
      target: name,
    };

    if (name == null || depth > MAX_DEPTH) {
      return result;
    }

    const values = argumentWords.map(staticValue);
    const follow = (wrapped: InvocationResult | undefined) => {
      // Not `||`: the target of a command named `""` is empty
      result.target = wrapped?.target ?? name;
      result.crossEnvStart ||= wrapped?.crossEnvStart;
    };

    // An ignored command isn't reported, but the commands it runs are
    if (this.#options.ignoredCommands.has(name)) {
      follow(this.#checkWrapped(name, argumentWords, values, context, depth));
      return result;
    }

    const firstIssue = this.#reporter.issues.length;
    const usageIssues = findUsageIssues(name, argumentWords, values, context);
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
      // file of a dependency's binary. The trait is read last, as the analysis is only reused for
      // runners with the same values of the traits that it read
      const isConverted =
        context.runnerScript &&
        depth === 0 &&
        DEPENDENCY_BINARY.test(name) &&
        isYarnCommandStart(context.source, nameWord.pos) &&
        this.#runnerTraits.get('convertsSlashes');

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
      covered.push(
        ...this.#checkCommandAvailability(name, nameWord, argumentWords, context, usageIssues),
      );
    }

    covered.push(...this.#reportUsage(usageIssues, nameWord, argumentWords, context));
    this.#reporter.markFailures(firstIssue);

    // The commands that it runs aren't reported on the platforms where it's reported already
    follow(this.#checkWrapped(name, argumentWords, values, withCovered(context, covered), depth));
    return result;
  }

  #reportUsage(
    issues: readonly UsageIssue[],
    nameWord: Word,
    argumentWords: readonly Word[],
    context: Context,
  ) {
    return issues.flatMap(({argumentIndex, data, fix, messageId, platforms}) => {
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

  #checkWrapped(
    name: string,
    argumentWords: Word[],
    values: readonly (string | undefined)[],
    context: Context,
    depth: number,
  ) {
    // `.` is the package in the current directory for `npx` and the like, not a command
    const invoke = (index: number, nestedContext = context, isCrossSpawned = false) => {
      const word = argumentWords[index];
      return !word || values[index] === '.'
        ? undefined
        : this.checkInvocation(
            word,
            argumentWords.slice(index + 1),
            // The command starts it, not Yarn's shell, so the shell's builtins aren't available,
            // e.g. `sleep` in `cross-env A=1 sleep 1`
            nestedContext.portable ? {...nestedContext, portable: false} : nestedContext,
            depth + 1,
            isCrossSpawned,
          );
    };

    const nestedShellString = (
      index: number,
      {
        bashOptions,
        shell = 'native',
      }: Partial<Pick<NestedWordsOptions, 'bashOptions' | 'shell'>> = {},
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

    // Joins the arguments from an index on into a single script, e.g. in `cross-env-shell rm $DIR`
    const nestedShellLine = (index: number, isCrossEnv = false) => {
      if (index !== -1 && depth < MAX_DEPTH) {
        this.#analyzeNestedWords(argumentWords.slice(index), context, {
          crossEnv: isCrossEnv,
          shell: 'native',
        });
      }
    };

    // `-c`/`--call` of `npx` and `npm exec` (a shell string), which is only their option before the
    // command they run
    const callIndex = (start: number, valueOptions: readonly string[]) => {
      const commandIndex = findCommandIndex(values, start, [...valueOptions, ...CALL_OPTIONS]);
      const end = commandIndex === -1 ? values.length : commandIndex;
      const index = values.findIndex(
        (value, i) => i >= start && i < end && setHas(CALL_OPTIONS, value),
      );
      return index === -1 ? -1 : index + 1;
    };
    // `-c`/`--shell-mode` of pnpm and aube, after which the command and its arguments are a shell
    // line. pnpm also takes it before its subcommand and in clusters, e.g. in `pnpm -rc exec`
    const shellModeIndex = (
      optionsStart: number,
      start: number,
      valueOptions: readonly string[],
    ) => {
      const commandIndex = findCommandIndex(values, start, valueOptions);
      return values
        .slice(optionsStart, commandIndex === -1 ? values.length : commandIndex)
        .some(
          (value) =>
            setHas(SHELL_MODE_OPTIONS, value) ||
            (name === 'pnpm' && isShortOptionCluster(value, 'c')),
        )
        ? commandIndex
        : -1;
    };

    const valueOptions = WRAPPER_VALUE_OPTIONS.get(name);

    switch (name) {
      case 'bash':
      case 'ksh':
      case 'zsh': {
        nestedShellString(findCommandString(values), {
          // e.g. `bash -O globstar -c "..."`
          bashOptions: new Set(
            slidingWindow(values, 2).flatMap(([option, value]) =>
              option === '-O' && value ? [value] : [],
            ),
          ),
          shell: 'bash',
        });
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

        nestedShellLine(index, true);
        return undefined;
      }

      case 'dash':
      case 'sh': {
        nestedShellString(findCommandString(values), {shell: 'sh'});
        return undefined;
      }

      case 'timeout': {
        // GNU's `timeout [options] duration command`, unlike cmd.exe's `timeout /t 10`
        const duration = findCommandIndex(values, 0, TIMEOUT_VALUE_OPTIONS);
        return duration === -1 || values[duration]?.startsWith('/')
          ? undefined
          : invoke(duration + 1);
      }

      case 'aube':
      case 'bun':
      case 'npm':
      case 'pnpm':
      case 'upm':
      case 'yarn': {
        // e.g. `pnpm exec rm -rf dist`
        const subcommand = findCommandIndex(values, 0, PACKAGE_MANAGER_VALUE_OPTIONS);
        if (!arrayIncludes(EXEC_SUBCOMMANDS[name], values[subcommand])) {
          return undefined;
        }

        if (name === 'npm' || name === 'upm') {
          const call = callIndex(subcommand + 1, EXEC_VALUE_OPTIONS);
          if (call !== -1) {
            nestedShellString(call);
            return undefined;
          }
        } else if (name === 'aube' || name === 'pnpm') {
          const shellLine = shellModeIndex(
            name === 'pnpm' ? 0 : subcommand + 1,
            subcommand + 1,
            EXEC_VALUE_OPTIONS,
          );
          if (shellLine !== -1) {
            nestedShellLine(shellLine);
            return undefined;
          }
        }

        return invoke(findCommandIndex(values, subcommand + 1, EXEC_VALUE_OPTIONS));
      }

      case 'npx':
      case 'upx': {
        const call = callIndex(0, valueOptions || []);
        if (call !== -1) {
          nestedShellString(call);
          return undefined;
        }
        break;
      }

      case 'aubx':
      case 'pnpx': {
        const shellLine = shellModeIndex(0, 0, valueOptions || []);
        if (shellLine !== -1) {
          nestedShellLine(shellLine);
          return undefined;
        }
        break;
      }

      default: {
        break;
      }
    }

    if (!valueOptions) {
      return undefined;
    }

    const commandIndex = findCommandIndex(values, 0, valueOptions, name === 'env');
    // `command -v` looks a command up instead of running it
    return name === 'command' &&
      values.slice(0, commandIndex).some((value) => value === '-v' || value === '-V')
      ? undefined
      : invoke(commandIndex);
  }
}
