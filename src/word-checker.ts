import {toForwardSlashes} from '@andreww2012/unutils';
import type {
  ArithmeticExpression,
  Assignment,
  BraceExpansionPart,
  Command,
  DoubleQuotedChild,
  ParameterExpansionPart,
  ParameterOperation,
  Script,
  SimpleExpansionPart,
  Word,
  WordPart,
} from 'unbash';
import {OS_COMMANDS, PATTERN_COMMANDS} from './commands.ts';
import {type Context, type Range, type SyntaxKind, bashLabel, withCovered} from './context.ts';
import {braceExpansionFix, quoting, replacement} from './fixes.ts';
import {
  BASH_SUGGESTION,
  CROSS_ENV_SUGGESTION,
  CROSS_ENV_VARIABLE_SUGGESTION,
  NODE_SCRIPT_SUGGESTION,
  QUOTE_GLOB_SUGGESTION,
  VARIABLE_SUGGESTION,
  truncate,
} from './messages.ts';
import {PLATFORMS, POSIX_PLATFORMS, type Platform, WINDOWS_PLATFORMS} from './platforms.ts';
import type {Reporter, ScriptFix} from './reporter.ts';
import {
  DOUBLE_QUOTED_SPECIAL_CHARACTERS,
  GLOB_PART_TYPES,
  POSIX_PATH,
  TILDE_EXPANSION,
  isPlainAssignment,
  isPlainWord,
  staticValue,
} from './words.ts';

interface WordOptions {
  command?: string;
  commandName?: boolean;

  /**
   * Whether `echo` prints the word to the terminal, where the quotes that cmd.exe keeps are
   * harmless
   */
  printedToTerminal?: boolean;
  redirectTarget?: boolean;
  skipGlobs?: boolean;
}

interface WordState {
  braceExpansions: BraceExpansionPart[];
  command: string | undefined;
  printedToTerminal: boolean;
  /** Position of the word's first unquoted `*` glob */
  globPosition: number | undefined;
  hasSingleQuotes: boolean;
}

/** Variables that Bash sets, but dash doesn't, by the kind of syntax they are */
const BASH_VARIABLES: ReadonlyMap<string, SyntaxKind> = new Map([
  ['BASH_SOURCE', 'bash'],
  ['BASH_VERSION', 'bash'],
  ['EPOCHREALTIME', 'bash4'],
  ['EPOCHSECONDS', 'bash4'],
  ['EUID', 'bash'],
  ['HOSTNAME', 'bash'],
  ['OSTYPE', 'bash'],
  ['PIPESTATUS', 'bash'],
  ['RANDOM', 'bash'],
  ['SECONDS', 'bash'],
  ['SRANDOM', 'bash4'],
  ['UID', 'bash'],
]);

/**
 * Variables that POSIX shells and systems set, but Windows doesn't, e.g. `PWD`.
 * cmd.exe computes its own dynamic variables, like `%CD%`, so they aren't in the environment
 * either.
 * npm and pnpm set `HOME` on all platforms
 */
const POSIX_ONLY_VARIABLES: ReadonlySet<string> = new Set([
  ...BASH_VARIABLES.keys(),
  'LOGNAME', // cspell:disable-line
  'OLDPWD',
  'PPID',
  'PWD',
  'SHELL',
  'TMPDIR',
  'USER',
]);

/** cmd.exe statements, which POSIX shells parse as commands, e.g. `IF` in `IF EXIST dist ...` */
const CMD_STATEMENTS: ReadonlySet<string> = new Set(['for', 'if']);

/** Characters that cmd.exe splits words at or interprets */
const CMD_SPECIAL_CHARACTERS = /[\s"%&<>^|]/;
/** Backslash escapes that POSIX shells remove, but cmd.exe passes on, e.g. `\$` or `\ ` */
const UNQUOTED_ESCAPE = /\\[\t !#$&'()*;<>?[\]`{|}~]/;
/** The same, in double quotes */
const QUOTED_ESCAPE = /\\[$`]/;
/** `cross-env` removes the backslashes of these escapes itself */
const CROSS_ENV_ESCAPE = /^\\[$']$/;
/** A named variable, e.g. `$HOME` rather than `$?` */
const NAMED_VARIABLE = /^\$\w+$/;
/** A `**` path segment, which `sh` doesn't expand recursively */
const RECURSIVE_GLOB = /(?:^|[/=])\*\*\//;
const WINDOWS_VARIABLE = /%[a-z_]\w+%/i;
const WINDOWS_VARIABLES = new RegExp(WINDOWS_VARIABLE, 'gi');

/**
 * A Windows path: a drive, relative prefix or first segment, then `\`-separated segments.
 * The segments may be globs, e.g. `lib\**\*.js`
 */
const BACKSLASH_PATH =
  /^(?:[a-z]:|[\w\-.]+|\*\*?(?:\.[\w-]+)*)(?:\\(?:[\w\-.]+|\*\*?(?:\.[\w-]+)*))+\\?$/i;
/** A Windows path's drive or relative prefix, e.g. `C:\` or `.\` */
const WINDOWS_PATH_PREFIX = /^(?:[a-z]:|\.{1,2})\\/i;
const FILE_EXTENSION = /\.\w+$/;
const MULTIPLE_BACKSLASHES = /\\.*\\/;
/** Backslashes that only escape dots are rather a regex, e.g. `logging\.spec\.ts` */
const NON_DOT_ESCAPE = /\\[^.]/;

const hasBashArithmetic = (expression: ArithmeticExpression | undefined): boolean => {
  switch (expression?.type) {
    case 'ArithmeticBinary': {
      return (
        expression.operator.startsWith('**') ||
        hasBashArithmetic(expression.left) ||
        hasBashArithmetic(expression.right)
      );
    }
    case 'ArithmeticGroup': {
      return hasBashArithmetic(expression.expression);
    }
    case 'ArithmeticTernary': {
      return [expression.test, expression.consequent, expression.alternate].some(hasBashArithmetic);
    }
    case 'ArithmeticUnary': {
      return (
        expression.operator === '++' ||
        expression.operator === '--' ||
        hasBashArithmetic(expression.operand)
      );
    }
    default: {
      return false;
    }
  }
};

const parameterOperands = (operation: ParameterOperation) => {
  switch (operation.type) {
    case 'CaseModification':
    case 'Default':
    case 'Remove':
    case 'Transform': {
      return [operation.operand];
    }
    case 'Replace': {
      return [operation.pattern, operation.replacement];
    }
    case 'Slice': {
      return [operation.offset, operation.length];
    }
    default: {
      return [];
    }
  }
};

/**
 * Checks whether a command is rather a tool than an OS utility or a cmd.exe command, e.g. `eslint`.
 * Tools usually expand globs themselves and accept `/` as a path separator.
 * @param command Name of the command that receives the arguments
 * @returns Whether the command is likely a tool
 */
const isTool = (command: string | undefined) => {
  const name = command?.toLowerCase();
  return name != null && !OS_COMMANDS.has(name) && !CMD_STATEMENTS.has(name);
};

/** Walks a script that a word contains, e.g. in `$(...)` */
type NestedScriptWalker = (script: Script, part: Range, context: Context) => void;

/** Checks words, e.g. for quotes, expansions and paths */
export class WordChecker {
  /** Whether the package manager doesn't set `HOME`, like Yarn v1 */
  readonly #isHomeUnset: boolean;
  readonly #reporter: Reporter;
  readonly #walkNestedScript: NestedScriptWalker;

  constructor(reporter: Reporter, walkNestedScript: NestedScriptWalker, isHomeUnset: boolean) {
    this.#reporter = reporter;
    this.#walkNestedScript = walkNestedScript;
    this.#isHomeUnset = isHomeUnset;
  }

  /**
   * Checks a variable assignment.
   * @param assignment Assignment to check, e.g. `CI=1`
   * @param context Where the assignment is
   * @param command The command that the assignment prefixes, e.g. `jest` in `CI=1 jest`
   */
  checkAssignment(assignment: Assignment, context: Context, command: Command | undefined) {
    const {append, index, value} = assignment;
    const isBashSpecific = value.type === 'ArrayValue' || index != null || append;
    const isPrefixesCommand = command != null;

    if (isBashSpecific) {
      this.#reporter.reportSyntax(context, assignment, 'bash', false, 'unsupportedSyntax', {
        suggestion: BASH_SUGGESTION,
        syntax: `The Bash-specific ${index || value.type === 'ArrayValue' ? 'array' : 'appending'} assignment \`${truncate(assignment.text)}\``,
      });
    } else {
      this.#reporter.reportSyntax(
        context,
        assignment,
        'posix',
        true,
        'unsupportedSyntax',
        {
          suggestion: CROSS_ENV_SUGGESTION,
          syntax: isPrefixesCommand
            ? `The inline environment variable assignment \`${truncate(assignment.text)}\``
            : `The shell variable assignment \`${truncate(assignment.text)}\``,
        },
        command?.prefix.every(isPlainAssignment)
          ? {
              description: 'Prefix the command with `cross-env`.',
              edits: [{end: command.pos, pos: command.pos, text: 'cross-env '}],
            }
          : undefined,
      );
    }

    // The suggested fix moves the value to `cross-env`, so only report what breaks there too
    const valueContext =
      isPrefixesCommand && !isBashSpecific ? {...context, crossEnv: true} : context;
    (value.type === 'ArrayValue' ? value.elements : [value]).forEach((word) => {
      this.checkWord(word, valueContext);
    });
  }

  #checkBashVariable(name: string, node: Range, context: Context) {
    const kind = BASH_VARIABLES.get(name);

    if (kind) {
      this.#reporter.reportSyntax(context, node, kind, true, 'inconsistentBehavior', {
        reason:
          kind === 'bash'
            ? "dash, the `sh` of Debian/Ubuntu, doesn't set it"
            : 'only Bash 5 sets it, and macOS ships Bash 3.2',
        suggestion: NODE_SCRIPT_SUGGESTION,
        syntax: `The Bash variable \`$${name}\``,
      });
    }
  }

  /**
   * Reports a variable that `cross-env` replaces with an empty string on Windows, e.g. `$PWD`.
   * @param name Name of the variable
   * @param node The variable expansion
   * @param context Where the expansion is
   * @returns The platforms that the report covers
   */
  #checkCrossEnvVariable(
    name: string,
    node: ParameterExpansionPart | SimpleExpansionPart,
    context: Context,
  ) {
    // Yarn's shell expands variables itself
    if (context.portable || !this.#isUnsetOnWindows(name)) {
      return [];
    }

    return this.#reporter.report(
      context,
      node,
      'inconsistentBehavior',
      {
        reason: "Windows doesn't set it, so `cross-env` replaces it with an empty string",
        suggestion: this.#variableSuggestion(name),
        syntax: `The variable \`${node.text}\``,
      },
      WINDOWS_PLATFORMS,
    );
  }

  /**
   * Reports an unquoted carriage return, e.g. of a CRLF line break, which POSIX shells keep.
   * @param word Word to check, e.g. `tsc` and a carriage return before a line break
   * @param context Where the word is
   */
  #checkCarriageReturn(word: Word, context: Context) {
    const literal = word.parts
      ? word.parts.find((part) => part.type === 'Literal' && part.text.includes('\r'))
      : word;

    if (!literal?.text.includes('\r') || context.portable) {
      return;
    }

    const position = literal.pos + literal.text.indexOf('\r');
    this.#reporter.report(
      context,
      {end: position + 1, pos: position},
      'inconsistentBehavior',
      {
        reason: "POSIX shells treat it as part of the word, e.g. of a command's name",
        suggestion: 'Use line feeds (`\\n`) for line breaks instead.',
        syntax: 'The carriage return (`\\r`)',
      },
      POSIX_PLATFORMS,
      {
        description: 'Remove the carriage return.',
        edits: [{end: position + 1, pos: position, text: ''}],
      },
    );
  }

  #checkEscapes(word: Word, context: Context) {
    const literals = word.parts
      ? word.parts.flatMap((part) => {
          if (part.type === 'Literal') {
            return {escape: UNQUOTED_ESCAPE, text: part.text};
          }
          return part.type === 'DoubleQuoted'
            ? part.parts.flatMap((child) =>
                child.type === 'Literal' ? {escape: QUOTED_ESCAPE, text: child.text} : [],
              )
            : [];
        })
      : [{escape: UNQUOTED_ESCAPE, text: word.text}];

    const escape = literals
      .map(({escape: pattern, text}) => pattern.exec(text)?.[0])
      .find((match) => match != null && !(context.crossEnv && CROSS_ENV_ESCAPE.test(match)));

    if (escape != null) {
      this.#reporter.reportSyntax(context, word, 'posix', true, 'inconsistentBehavior', {
        reason: "cmd.exe doesn't treat backslashes as escape characters, so it passes them on",
        suggestion: 'Use escaped double quotes (`\\"`) instead.',
        syntax: `The backslash escape \`${escape}\``,
      });
    }

    // cmd.exe's own escape character, e.g. in `npm install mobx@^5`
    if (
      literals.some(({escape: pattern, text}) => pattern === UNQUOTED_ESCAPE && text.includes('^'))
    ) {
      this.#reporter.reportSyntax(
        context,
        word,
        'posix',
        true,
        'inconsistentBehavior',
        {
          reason: 'cmd.exe treats `^` as an escape character and removes it',
          suggestion: 'Quote it with double quotes instead.',
          syntax: `The caret in \`${truncate(word.text)}\``,
        },
        isPlainWord(word) ? quoting(word, 'Quote it with escaped double quotes.') : undefined,
      );
    }
  }

  #checkParameterExpansion(part: ParameterExpansionPart, context: Context) {
    const {index, operation, prefix} = part;
    const isBashSpecific =
      index != null ||
      prefix === '!' ||
      (operation != null && operation.type !== 'Default' && operation.type !== 'Remove');
    // e.g. `${name^^}` and `${name@Q}`
    const bashKind =
      operation?.type === 'CaseModification' || operation?.type === 'Transform' ? 'bash4' : 'bash';

    let covered: Platform[];

    if (isBashSpecific) {
      covered = this.#reporter.reportSyntax(context, part, bashKind, false, 'unsupportedSyntax', {
        suggestion: NODE_SCRIPT_SUGGESTION,
        syntax: `The ${bashLabel(bashKind)} parameter expansion \`${truncate(part.text)}\``,
      });
    } else if (operation == null && prefix == null && context.crossEnv) {
      covered = this.#checkCrossEnvVariable(part.parameter, part, context);
    } else {
      const isPortableSupported =
        prefix == null &&
        (operation == null ||
          (operation.type === 'Default' &&
            (operation.operator === ':-' || operation.operator === ':+')));

      covered = this.#reporter.reportSyntax(
        context,
        part,
        'posix',
        isPortableSupported,
        'unsupportedSyntax',
        {
          suggestion: context.crossEnv
            ? CROSS_ENV_VARIABLE_SUGGESTION
            : this.#variableSuggestion(part.parameter),
          syntax: `The variable expansion \`${truncate(part.text)}\``,
        },
      );
    }

    // Operands can contain further expansions, e.g. `${A:-$(cmd)}`
    const nestedContext = withCovered(context, covered);
    this.#checkBashVariable(part.parameter, part, nestedContext);
    const operands = [index, ...(operation ? parameterOperands(operation) : [])];
    operands.forEach((operand) => {
      if (operand) {
        this.checkWord(operand, nestedContext, {skipGlobs: true});
      }
    });
  }

  #checkParts(
    parts: readonly (DoubleQuotedChild | WordPart)[],
    context: Context,
    state: WordState,
  ) {
    parts.forEach((part) => {
      this.#checkPart(part, context, state);
    });
  }

  /**
   * Checks a part of a word, e.g. a quoted string or an expansion.
   * @param part Part to check, e.g. `$HOME` in `$HOME/.npmrc`
   * @param context Where the word is
   * @param state What the word contains, collected while checking its parts
   */
  #checkPart(part: DoubleQuotedChild | WordPart, context: Context, state: WordState) {
    switch (part.type) {
      case 'AnsiCQuoted': {
        this.#reporter.reportSyntax(context, part, 'bash', true, 'unsupportedSyntax', {
          suggestion: BASH_SUGGESTION,
          syntax: `The Bash-specific ANSI-C quoted string \`${truncate(part.text)}\``,
        });
        break;
      }

      case 'ArithmeticExpansion': {
        const covered = this.#reporter.reportSyntax(
          context,
          part,
          'posix',
          true,
          'unsupportedSyntax',
          {
            suggestion: NODE_SCRIPT_SUGGESTION,
            syntax: `The arithmetic expansion \`${truncate(part.text)}\``,
          },
        );

        // e.g. `**` and `++`, which aren't part of POSIX
        if (hasBashArithmetic(part.expression)) {
          this.#reporter.reportSyntax(
            withCovered(context, covered),
            part,
            'bash',
            true,
            'unsupportedSyntax',
            {
              suggestion: NODE_SCRIPT_SUGGESTION,
              syntax: `The Bash-specific arithmetic in \`${truncate(part.text)}\``,
            },
          );
        }
        break;
      }

      case 'BraceExpansion': {
        state.braceExpansions.push(part);
        break;
      }

      case 'CommandExpansion': {
        const covered = this.#reporter.reportSyntax(
          context,
          part,
          'posix',
          !part.text.startsWith('`'),
          'unsupportedSyntax',
          {
            suggestion: NODE_SCRIPT_SUGGESTION,
            syntax: `The command substitution \`${truncate(part.text)}\``,
          },
        );

        if (part.script && !part.script.errors?.length) {
          this.#walkNestedScript(part.script, part, withCovered(context, covered));
        }
        break;
      }

      case 'DoubleQuoted': {
        this.#checkParts(part.parts, context, state);
        break;
      }

      case 'ExtendedGlob': {
        if (context.bashOptions?.has('extglob')) {
          break;
        }
        this.#reporter.report(
          context,
          part,
          'unsupportedSyntax',
          {
            suggestion:
              "It requires Bash's `extglob` option; quote the pattern and let the tool expand it instead.",
            syntax: `The extended glob \`${truncate(part.text)}\``,
          },
          PLATFORMS,
        );
        break;
      }

      case 'Glob': {
        if (part.kind === 'star') {
          state.globPosition ??= part.pos;
        }
        break;
      }

      case 'LocaleString': {
        this.#reporter.reportSyntax(context, part, 'bash', false, 'unsupportedSyntax', {
          suggestion: BASH_SUGGESTION,
          syntax: `The Bash-specific locale string \`${truncate(part.text)}\``,
        });
        this.#checkParts(part.parts, context, state);
        break;
      }

      case 'ParameterExpansion': {
        this.#checkParameterExpansion(part, context);
        break;
      }

      case 'ProcessSubstitution': {
        const covered = this.#reporter.reportSyntax(
          context,
          part,
          'bashNonPosix',
          false,
          'unsupportedSyntax',
          {
            suggestion: 'Use a temporary file or a Node.js script instead.',
            syntax: `The Bash-specific process substitution \`${truncate(part.text)}\``,
          },
        );

        if (part.script && !part.script.errors?.length) {
          this.#walkNestedScript(part.script, part, withCovered(context, covered));
        }
        break;
      }

      case 'SimpleExpansion': {
        const name = part.text.slice(1);
        // `cross-env` only replaces named variables, e.g. not `$?`
        const covered =
          context.crossEnv && NAMED_VARIABLE.test(part.text)
            ? this.#checkCrossEnvVariable(name, part, context)
            : this.#reporter.reportSyntax(context, part, 'posix', true, 'unsupportedSyntax', {
                suggestion: context.crossEnv
                  ? CROSS_ENV_VARIABLE_SUGGESTION
                  : this.#variableSuggestion(name),
                syntax: `The variable expansion \`${part.text}\``,
              });
        this.#checkBashVariable(name, part, withCovered(context, covered));
        break;
      }

      case 'SingleQuoted': {
        state.hasSingleQuotes = true;
        // cmd.exe still splits the string at whitespace and interprets its special characters
        if (
          state.printedToTerminal ||
          (context.crossEnv && !CMD_SPECIAL_CHARACTERS.test(part.value))
        ) {
          break;
        }
        this.#reporter.reportSyntax(
          context,
          part,
          'posix',
          true,
          'inconsistentBehavior',
          {
            reason: context.crossEnv
              ? "cmd.exe doesn't treat single quotes as quotes, so it splits the string before `cross-env` removes them"
              : "cmd.exe doesn't treat single quotes as quotes, so they're passed on literally",
            suggestion: 'Use escaped double quotes (`\\"`) instead.',
            syntax: `The single-quoted string \`${truncate(part.text)}\``,
          },
          // cmd.exe's `echo` prints double quotes too
          state.command === 'echo' || DOUBLE_QUOTED_SPECIAL_CHARACTERS.test(part.value)
            ? undefined
            : {
                description: 'Use escaped double quotes instead.',
                edits: [{end: part.end, pos: part.pos, text: `"${part.value}"`}],
              },
        );
        break;
      }

      default: {
        break;
      }
    }
  }

  /**
   * Reports device paths like `/dev/null`, which don't exist on Windows.
   * @param word Word that contains the path
   * @param value Static value of the word
   * @param context Where the word is
   * @param fix A fix for the report, e.g. one that removes the redirection to the path
   */
  checkPosixPath(word: Word, value: string, context: Context, fix?: ScriptFix) {
    if (POSIX_PATH.test(value)) {
      this.#reporter.report(
        context,
        word,
        'unsupportedSyntax',
        {
          suggestion: value.includes('/dev/')
            ? 'Remove it or use a Node.js script instead.'
            : 'Use a path relative to the package or a Node.js script instead.',
          syntax: `The POSIX path \`${truncate(value)}\``,
        },
        WINDOWS_PLATFORMS,
        fix,
      );
    }
  }

  checkWord(word: Word, context: Context, options: WordOptions = {}) {
    const {text} = word;

    this.#checkCarriageReturn(word, context);

    if (TILDE_EXPANSION.test(text)) {
      this.#reporter.reportSyntax(context, word, 'posix', false, 'unsupportedSyntax', {
        suggestion: 'Use a path relative to the package or a Node.js script instead.',
        syntax: `The tilde expansion \`${truncate(text)}\``,
      });
    }

    const state: WordState = {
      braceExpansions: [],
      command: options.command,
      globPosition: undefined,
      hasSingleQuotes: false,
      printedToTerminal: options.printedToTerminal || false,
    };
    this.#checkParts(word.parts || [], context, state);

    const hasGlob = state.globPosition != null;
    const globPrefix = hasGlob ? text.slice(0, (state.globPosition || 0) - word.pos) : '';

    // A pattern in an option or assignment value (e.g. `--include=src/*`) can't match a file, so
    // every shell passes it on literally
    const isLiteralPattern = globPrefix.startsWith('-') || globPrefix.includes('=');

    // Other unquoted globs aren't reported, as many tools expand globs themselves when the shell
    // doesn't (e.g. cmd.exe). But a trailing `**` matches the same top-level entries as `*` (and
    // `a**` is just `a*`), so only a `**/` segment is affected
    if (
      hasGlob &&
      !isLiteralPattern &&
      RECURSIVE_GLOB.test(text) &&
      !context.portable &&
      !context.bashOptions?.has('globstar') &&
      !options.commandName &&
      !options.redirectTarget &&
      !options.skipGlobs
    ) {
      this.#reporter.report(
        context,
        word,
        'inconsistentBehavior',
        {
          reason:
            "`sh` doesn't support recursive `**` globs, and cmd.exe doesn't expand globs at all",
          suggestion: QUOTE_GLOB_SUGGESTION,
          syntax: `The unquoted glob \`${truncate(text)}\``,
        },
        PLATFORMS,
        // OS utilities don't expand globs themselves
        isTool(options.command) && isPlainWord(word, GLOB_PART_TYPES)
          ? quoting(word, 'Quote it with escaped double quotes.')
          : undefined,
      );
    }

    // When a shell doesn't expand braces, many tools do (as part of their glob syntax), so only
    // report them for OS utilities
    if (!hasGlob && (options.command == null || OS_COMMANDS.has(options.command))) {
      state.braceExpansions.forEach((part) => {
        this.#reporter.reportSyntax(
          context,
          part,
          'bash',
          true,
          'unsupportedSyntax',
          {
            suggestion: 'List the alternatives explicitly instead.',
            syntax: `The Bash-specific brace expansion \`${truncate(part.text)}\``,
          },
          braceExpansionFix(word, part),
        );
      });
    }

    const isPattern = options.command != null && PATTERN_COMMANDS.has(options.command);
    const unquoted = text.replaceAll('"', '');
    const path = unquoted.slice(unquoted.lastIndexOf('=') + 1);

    // Require a hint that it's a path (relative prefix, extension, or multiple separators), as
    // backslashes are also used for escapes
    if (
      !isPattern &&
      !state.hasSingleQuotes &&
      BACKSLASH_PATH.test(path) &&
      (WINDOWS_PATH_PREFIX.test(path) ||
        FILE_EXTENSION.test(path) ||
        MULTIPLE_BACKSLASHES.test(path)) &&
      NON_DOT_ESCAPE.test(path)
    ) {
      this.#reporter.report(
        context,
        word,
        'inconsistentBehavior',
        {
          reason: 'POSIX shells treat backslashes as escape characters',
          suggestion: 'Use forward slashes instead.',
          syntax: `The backslash path separator in \`${truncate(path)}\``,
        },
        // Yarn's shell keeps the backslashes in double quotes, so they work on Windows
        context.portable && !text.startsWith('"') ? PLATFORMS : POSIX_PLATFORMS,
        // cmd.exe treats `/` as an option prefix in command names and its own commands
        options.commandName || options.redirectTarget || !isTool(options.command)
          ? undefined
          : replacement(
              word,
              text,
              `${text.slice(0, text.lastIndexOf('=') + 1)}${toForwardSlashes(text.slice(text.lastIndexOf('=') + 1))}`,
            ),
      );
    }

    // e.g. `dist\*` in `del /q dist\*` and `.\node_modules\ ` in `rd .\node_modules\ -r`
    if (!BACKSLASH_PATH.test(path) && !WINDOWS_PATH_PREFIX.test(path)) {
      this.#checkEscapes(word, context);
    }

    // In single quotes, it's rather a placeholder of the tool, e.g. in
    // `--bundle-structure '%LANG_ISO%.json'`
    if (!state.hasSingleQuotes && options.command !== 'date' && options.command !== 'printf') {
      const match = WINDOWS_VARIABLE.exec(text);
      // Other `%` signs indicate a format string, e.g. `--pretty=format:%C(bold)%ad%C(reset)`
      if (match && !text.replaceAll(WINDOWS_VARIABLES, '').includes('%')) {
        this.#reporter.report(
          context,
          word,
          'unsupportedSyntax',
          {
            suggestion: VARIABLE_SUGGESTION,
            syntax: `The Windows variable reference \`${match[0]}\``,
          },
          context.portable ? PLATFORMS : POSIX_PLATFORMS,
        );
      }
    }

    const value = staticValue(word);

    // Redirection targets are checked with their redirection
    if (value != null && !options.commandName && !options.redirectTarget) {
      this.checkPosixPath(word, value, context);
    }
  }

  /** Checks whether Windows doesn't set a variable, so `cross-env` replaces it with nothing */
  #isUnsetOnWindows(name: string) {
    return POSIX_ONLY_VARIABLES.has(name) || (name === 'HOME' && this.#isHomeUnset);
  }

  /** Gets what to use instead of a variable on Windows, where `cross-env` can't help for some */
  #variableSuggestion(name: string) {
    if (name === 'PWD') {
      return 'Use a relative path or a Node.js script instead.';
    }
    return this.#isUnsetOnWindows(name) ? NODE_SCRIPT_SUGGESTION : VARIABLE_SUGGESTION;
  }
}
