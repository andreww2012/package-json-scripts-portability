import type {Statement, Word} from 'unbash';
import {type UsageIssue, checkCommandUsage} from './command-usage.ts';
import {
  CMD_BUILTINS,
  COMMANDS,
  EXACT_NAME_BUILTINS,
  EXEC_SUBCOMMANDS,
  EXEC_VALUE_OPTIONS,
  NON_PORTABLE_BUILTINS,
  NPM_EXEC_VALUE_OPTIONS,
  NPM_VALUE_OPTIONS,
  OS_COMMANDS,
  PACKAGE_MANAGER_VALUE_OPTIONS,
  PORTABLE_SHELL_BUILTINS,
  SHELL_STATE_COMMANDS,
  TIMEOUT_VALUE_OPTIONS,
  WRAPPER_VALUE_OPTIONS,
} from './commands.ts';
import {type Context, type Shell, withCovered} from './context.ts';
import {
  DEPENDENCY_BINARY,
  commandFix,
  crossEnvEdits,
  pathCommandFix,
  replacement,
} from './fixes.ts';
import {
  NODE_SCRIPT_SUGGESTION,
  SHELL_SCRIPT_SUGGESTION,
  describeReplacement,
  truncate,
} from './messages.ts';
import {
  LINUX_PLATFORMS,
  PLATFORMS,
  POSIX_PLATFORMS,
  type Platform,
  WINDOWS_PLATFORMS,
} from './platforms.ts';
import type {Reporter, ScriptFix} from './reporter.ts';
import type {TraitsReader} from './runners.ts';
import {
  arrayDifference,
  arrayIncludes,
  arrayIntersection,
  setHas,
  slidingWindow,
  substringBefore,
} from './utils.ts';
import {
  ASSIGNMENT,
  WHITESPACE,
  doesMentionVariables,
  isPlainAssignment,
  isShortOptionCluster,
  staticValue,
} from './words.ts';

interface CrossEnvInvocation {
  /** Where the command that it runs starts, after the variables that it sets */
  commandStart: number;
  /** Whether it's `cross-env-shell`, which runs the command with a shell */
  shell: boolean;
  /** Where its arguments start */
  start: number;
  /** Names of the variables that it sets */
  variables: ReadonlySet<string>;
}

interface InvocationResult {
  /**
   * The `cross-env` that runs the command, if any, also behind another command, e.g. in
   * `npx cross-env A=1 jest`
   */
  crossEnv: CrossEnvInvocation | undefined;
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
 * Linux finds commands by their exact name, unlike cmd.exe and macOS (with its default file system),
 * where only some shell builtins need it, e.g. `exit` on macOS
 * @param name Name that the command was invoked with
 * @returns Whether only its lower case is a known OS command
 */
const isWrongCase = (name: string) => {
  const lowerCaseName = name.toLowerCase();
  return name !== lowerCaseName && !COMMANDS.has(name) && OS_COMMANDS.has(lowerCaseName);
};

/**
 * Gets the platforms where a command in the wrong case is missing.
 * @param lowerCaseName The command's name in lower case
 * @param platforms Where the command in lower case is missing
 * @param context Where the command is
 * @returns The platforms
 */
const wrongCasePlatforms = (
  lowerCaseName: string,
  platforms: readonly Platform[],
  context: Context,
) =>
  PLATFORMS.filter(
    (platform) =>
      platform === 'linux' ||
      platforms.includes(platform) ||
      (platform === 'darwin' && EXACT_NAME_BUILTINS.has(lowerCaseName)) ||
      // Yarn's shell only knows its builtins by their exact names, and Windows has no executables
      // for them, e.g. for `cd`
      (platform === 'win32' && context.portable && PORTABLE_SHELL_BUILTINS.has(lowerCaseName)),
  );

/**
 * Gets the text of a `cross-env` argument to tell whether it sets a variable, e.g. `B=$A`.
 * @param word The argument
 * @param value Its static value
 * @returns The value, or the text if the value isn't static
 */
const crossEnvArgumentText = (word: Word, value: string | undefined) => value ?? word.text;

/**
 * Finds the command that `cross-env` runs, after the variables that it sets.
 * @param argumentWords Its arguments
 * @param values Their static values
 * @returns Index of the command's name, or -1 if there is none
 */
const crossEnvCommandIndex = (
  argumentWords: readonly Word[],
  values: readonly (string | undefined)[],
) =>
  argumentWords.findIndex(
    (word, index) => !ASSIGNMENT.test(crossEnvArgumentText(word, values[index])),
  );

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

/** Commands that change the directory of the commands that follow */
const DIRECTORY_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd']);

/** Options of `npx` and `npm exec` that take a shell string */
const CALL_OPTIONS: ReadonlySet<string> = new Set(['--call', '-c']);

/** Options of pnpm and aube that make the command and its arguments a shell line */
const SHELL_MODE_OPTIONS: ReadonlySet<string> = new Set(['--shell-mode', '-c']);

const SHELL_OPTION = /^[+-]./;
/** A shell option that takes a value, also at the end of a cluster, e.g. `-o` in `-euo pipefail` */
const SHELL_VALUE_OPTION = /^(?:[+-][a-z]*o|--init-file|--rcfile)$/i;

/**
 * Finds the script of a shell's `-c` option, e.g. in `sh -c "..."` or `sh -c -e "..."`.
 * The shell's options end at the script file, whose arguments are its own, e.g. `-c` in
 * `sh build.sh -c x`.
 * @param values The static values of the shell's arguments
 * @returns Index of the script, or -1 if there is none
 */
const findCommandString = (values: readonly (string | undefined)[]) => {
  let index = 0;
  let hasCommandOption = false;

  while (index < values.length) {
    const value = values[index];
    if (value == null || !SHELL_OPTION.test(value)) {
      return hasCommandOption ? index : -1;
    }

    hasCommandOption ||= isShortOptionCluster(value, 'c');
    index += SHELL_VALUE_OPTION.test(value) ? 2 : 1;
  }

  return -1;
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
  crossEnv: Context['crossEnv'];
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
  /** Sources in which a command changed the directory, e.g. with `cd`, by the walk so far */
  readonly #directoryChangeSources = new Set<string>();
  /** Whether a script that the walked one is nested in changed the directory before it */
  #isEnclosingDirectoryChanged = false;
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
        const text = `exit ${status}`;
        this.#positionalFixes.set(final.name, {
          // Package managers append extra arguments to the script, e.g. `--fix` in
          // `npm run x -- --fix`. `true` ignores them, and `exit 1` fails either way
          description:
            status === '0'
              ? `Replace \`${truncate(final.name.text)}\` with \`${text}\`, which Bash rejects if the script gets extra arguments.`
              : describeReplacement(final.name.text, text),
          edits: [{end: final.name.end, pos: final.name.pos, text}],
        });
      }
    }

    // In `export A=1 && jest`, only `jest` uses the variables
    const [exporting, command] = commands;
    // eslint-disable-next-line unicorn/prefer-early-return -- The condition is too long to negate
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
      !doesMentionVariables(
        source.slice(command.pos, command.end),
        new Set(exporting.suffix.filter(isPlainAssignment).map(({name}) => name)),
      )
    ) {
      const edits = crossEnvEdits(
        [...exporting.suffix, ...command.prefix.filter((item) => item.type === 'Assignment')],
        [command.name, ...command.suffix.filter((item) => item.type === 'Word')],
      );
      if (edits) {
        this.#positionalFixes.set(exporting.name, {
          description: 'Replace `export ... &&` with `cross-env`.',
          edits: [
            {end: exporting.name.end, pos: exporting.name.pos, text: 'cross-env'},
            {end: command.pos, pos: exporting.end, text: ' '},
            ...edits,
          ],
        });
      }
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
    const lowerCaseName = name.toLowerCase();

    if (lowerCaseName === 'del' && this.#options.dependencies.includes('del-cli')) {
      const suggestion = 'Use `del-cli` instead.';
      const fix = replacement(nameWord, nameWord.text, 'del-cli');
      return [
        // Yarn's shell can't run cmd.exe's builtins, so it runs del-cli's binary everywhere
        ...(context.portable
          ? []
          : this.#reporter.report(
              context,
              nameWord,
              'inconsistentBehavior',
              {
                reason: "cmd.exe's builtin `del` takes precedence over del-cli's `del` binary",
                suggestion,
                syntax: '`del`',
              },
              WINDOWS_PLATFORMS,
              fix,
            )),
        // Only Linux finds the binary by its exact name
        ...(name === lowerCaseName
          ? []
          : this.#reporter.report(
              context,
              nameWord,
              'unsupportedCommand',
              {command: name, suggestion},
              LINUX_PLATFORMS,
              fix,
            )),
      ];
    }

    // It's not known which of them a script for the runner's shell means, unlike in `sh -c "..."`
    if (lowerCaseName === 'type' && context.shell === 'native' && !context.portable) {
      return this.#reporter.report(
        context,
        nameWord,
        'inconsistentBehavior',
        {
          reason:
            "cmd.exe's `type` prints a file, and the `type` of POSIX shells tells what a command is",
          suggestion: NODE_SCRIPT_SUGGESTION,
          syntax: '`type`',
        },
        PLATFORMS,
      );
    }

    if (context.portable && PORTABLE_SHELL_BUILTINS.has(name)) {
      return [];
    }

    if (context.portable && NON_PORTABLE_BUILTINS.has(name)) {
      const info = COMMANDS.get(name);
      return this.#reporter.report(
        context,
        nameWord,
        'unsupportedCommand',
        {
          command: name,
          // Suggestions for Bash builtins are about `sh` and cmd.exe
          suggestion: (!info?.bashBuiltin && info?.suggestion) || NODE_SCRIPT_SUGGESTION,
        },
        PLATFORMS,
        // e.g. `cross-env` for `export`, but not `.` for `source`, which Yarn's shell lacks too
        this.#positionalFixes.get(nameWord),
      );
    }

    const isNameWrongCase = isWrongCase(name);
    const info = COMMANDS.get(isNameWrongCase ? lowerCaseName : name);

    if (!info && !isNameWrongCase) {
      return [];
    }

    let platforms = info?.platforms || [];

    if (isNameWrongCase) {
      platforms = wrongCasePlatforms(lowerCaseName, platforms, context).filter(
        // The usage report tells more, e.g. that `/T` in `TIMEOUT /T 5` is an option of cmd.exe
        (platform) => usageIssues.every((issue) => !issue.platforms.includes(platform)),
      );
    } else if (info?.bashBuiltin && context.shell === 'bash') {
      platforms = arrayDifference(platforms, LINUX_PLATFORMS);
    }

    if (context.portable && CMD_BUILTINS.has(lowerCaseName)) {
      platforms = arrayIntersection(PLATFORMS, [...platforms, ...WINDOWS_PLATFORMS]);
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
    const result: InvocationResult = {crossEnv: undefined, name, target: name};

    if (name == null || depth > MAX_DEPTH) {
      return result;
    }

    if (DIRECTORY_COMMANDS.has(name.toLowerCase())) {
      this.#directoryChangeSources.add(context.source);
    }

    const values = argumentWords.map(staticValue);
    if (name === 'cross-env' || name === 'cross-env-shell') {
      const commandIndex = crossEnvCommandIndex(argumentWords, values);
      result.crossEnv = {
        commandStart: argumentWords[commandIndex]?.pos ?? Number.POSITIVE_INFINITY,
        shell: name === 'cross-env-shell',
        start: nameWord.end,
        variables: new Set(
          argumentWords
            .slice(0, commandIndex === -1 ? undefined : commandIndex)
            .map((word, index) => substringBefore(crossEnvArgumentText(word, values[index]), '=')),
        ),
      };
    }

    const follow = (wrapped: InvocationResult | undefined) => {
      // Not `||`: the target of a command named `""` is empty
      result.target = wrapped?.target ?? name;
      result.crossEnv ||= wrapped?.crossEnv;
    };

    // An ignored command isn't reported, but the commands it runs are
    if (this.#options.ignoredCommands.has(name)) {
      follow(this.#checkWrapped(name, argumentWords, values, context, depth));
      return result;
    }

    // It's ignored in lower case, which some platforms need, e.g. `rm` for `RM`
    const lowerCaseName = name.toLowerCase();
    if (this.#options.ignoredCommands.has(lowerCaseName) && isWrongCase(name)) {
      const firstIssue = this.#reporter.issues.length;
      const covered = this.#reporter.report(
        context,
        nameWord,
        'unsupportedCommand',
        {command: name, suggestion: `Use \`${lowerCaseName}\` in lower case instead.`},
        wrongCasePlatforms(lowerCaseName, [], context),
        // `echo` is a builtin of `sh`, but an executable on macOS
        lowerCaseName === 'echo' ? undefined : replacement(nameWord, nameWord.text, lowerCaseName),
      );
      this.#reporter.markFailures(firstIssue);
      follow(this.#checkWrapped(name, argumentWords, values, withCovered(context, covered), depth));
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
            pathCommandFix(
              name,
              nameWord,
              this.#isEnclosingDirectoryChanged || this.#directoryChangeSources.has(context.source),
            ),
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

  /**
   * Analyzes words that a command runs as a script, e.g. in `sh -c "..."`.
   * @param words The words
   * @param context Where the command is
   * @param options How the script runs
   */
  #analyzeNested(words: readonly Word[], context: Context, options: NestedWordsOptions) {
    const wasDirectoryChanged = this.#isEnclosingDirectoryChanged;
    // The script runs in the directory that the enclosing one changed to, e.g. after `cd a &&`
    this.#isEnclosingDirectoryChanged ||= this.#directoryChangeSources.has(context.source);
    this.#analyzeNestedWords(words, context, options);
    this.#isEnclosingDirectoryChanged = wasDirectoryChanged;
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
        this.#analyzeNested([word], context, {
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
        this.#analyzeNested(argumentWords.slice(index), context, {
          crossEnv: isCrossEnv && 'script',
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
        const index = crossEnvCommandIndex(argumentWords, values);

        if (name === 'cross-env') {
          return invoke(index, {...context, crossEnv: 'command'}, true);
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
        const subcommand = findCommandIndex(
          values,
          0,
          name === 'npm' ? NPM_VALUE_OPTIONS : PACKAGE_MANAGER_VALUE_OPTIONS,
        );
        if (!arrayIncludes(EXEC_SUBCOMMANDS[name], values[subcommand])) {
          return undefined;
        }

        const execValueOptions = name === 'npm' ? NPM_EXEC_VALUE_OPTIONS : EXEC_VALUE_OPTIONS;
        if (name === 'npm' || name === 'upm') {
          const call = callIndex(subcommand + 1, execValueOptions);
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

        return invoke(findCommandIndex(values, subcommand + 1, execValueOptions));
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
