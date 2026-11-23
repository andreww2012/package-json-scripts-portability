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
import {OS_COMMANDS, PATTERN_COMMANDS, SHELL_STATE_COMMANDS} from './commands.ts';
import {
  type Context,
  type Range,
  type SyntaxKind,
  bashLabel,
  originalText,
  withCovered,
} from './context.ts';
import {backslashPathFix, braceExpansionFix, quoting} from './fixes.ts';
import {
  BASH_SUGGESTION,
  CROSS_ENV_SUGGESTION,
  CROSS_ENV_VARIABLE_SUGGESTION,
  NODE_SCRIPT_SUGGESTION,
  VARIABLE_SUGGESTION,
  snippet,
  truncate,
} from './messages.ts';
import {
  MACOS_PLATFORMS,
  PLATFORMS,
  POSIX_PLATFORMS,
  type Platform,
  WINDOWS_PLATFORMS,
} from './platforms.ts';
import type {Reporter, ScriptFix} from './reporter.ts';
import type {TraitsReader} from './runners.ts';
import {setHas, substringAfterLast} from './utils.ts';
import {
  DOUBLE_QUOTED_SPECIAL_CHARACTERS,
  GLOB_PART_TYPES,
  POSIX_PATH,
  TILDE_EXPANSION,
  doesMentionVariables,
  isPlainAssignment,
  isPlainWord,
  staticValue,
} from './words.ts';

interface WordOptions {
  command?: string;
  commandName?: boolean;

  /**
   * Whether the word is the value of an assignment that a declaration command receives, e.g. in
   * `export A={a,b}`, where Bash expands braces in the whole assignment
   */
  declaredValue?: boolean;

  /**
   * Whether the word is analyzed as a nested script, e.g. in `sh -c "..."`, whose analysis checks
   * the text, e.g. for paths, so that it's not reported twice
   */
  nestedScript?: boolean;

  /**
   * Whether `echo` prints the word to the terminal, where the quotes that cmd.exe keeps are
   * harmless
   */
  printedToTerminal?: boolean;
  redirectTarget?: boolean;
  /** Whether the shell doesn't expand globs and braces in the word, e.g. in a pattern */
  skipGlobs?: boolean;
  /** Whether the word is text rather than an argument, e.g. a here-string, so it isn't a path */
  text?: boolean;
}

interface WordState {
  braceExpansions: BraceExpansionPart[];
  command: string | undefined;
  printedToTerminal: boolean;
  /** Position of the word's first unquoted `*` glob */
  globPosition: number | undefined;
  hasSingleQuotes: boolean;
  skipGlobs: boolean;
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
 * Some runners, like npm, set `HOME` on all platforms
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

/** Variables that package managers set, e.g. `npm_package_version` */
const PACKAGE_MANAGER_VARIABLE = /^(?:npm_\w+|INIT_CWD)$/;

/** cmd.exe statements, which POSIX shells parse as commands, e.g. `IF` in `IF EXIST dist ...` */
export const CMD_STATEMENTS: ReadonlySet<string> = new Set(['for', 'if']);

/** Characters that cmd.exe splits words at or interprets */
const CMD_SPECIAL_CHARACTERS = /[\s"%&<>^|]/;
/** Operators that cmd.exe runs even in a string that `echo` prints, e.g. `>` in `echo '-> done'` */
const CMD_OPERATORS = /[&<>|]/;
/** Backslash escapes that POSIX shells remove, but cmd.exe passes on, e.g. `\$` or `\ ` */
const UNQUOTED_ESCAPE = /\\[\t !#$&'()*;<>?[\]`{|}~]/g;
/** The same, in double quotes */
const QUOTED_ESCAPE = /\\[$`]/g;
/** `cross-env` removes the backslashes of these escapes itself */
const CROSS_ENV_ESCAPE = /^\\[$']$/;
/** A named variable, e.g. `$HOME` rather than `$?` */
const NAMED_VARIABLE = /^\$\w+$/;
/** A `**` path segment, which `sh` doesn't expand recursively */
const RECURSIVE_GLOB = /(?:^|[/=])\*\*\//;

/**
 * A cmd.exe variable, e.g. `%PORT%`. One-letter names are left out: they're mostly parts of
 * format strings, e.g. `%s%` in `--pretty=%s%n`
 */
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
/** Backslashes that only escape dots are likely a regex, e.g. `logging\.spec\.ts` */
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
 * Checks whether a command is likely a tool, e.g. `eslint`, and not an OS utility or a cmd.exe
 * command.
 * Tools usually expand globs themselves and accept `/` as a path separator.
 * @param command Name of the command that receives the arguments
 * @returns Whether the command is likely a tool
 */
const isTool = (command: string | undefined) => {
  const name = command?.toLowerCase();
  return name != null && !OS_COMMANDS.has(name) && !CMD_STATEMENTS.has(name);
};

/** Whether `cross-env` can prefix each command, which all assignments of the command check */
const crossEnvCommands = new WeakMap<Command, boolean>();

/**
 * Checks whether `cross-env` can prefix a command and take over its assignments.
 * It needs a command with only plain assignments before it, and can't run shell builtins, e.g. `cd`
 * in `A=1 cd x`.
 * Bash would expand braces in the arguments of `cross-env`, e.g. in `A={a,b}`, unlike in
 * assignments.
 * dash applies assignments one by one, e.g. `$A` in `A=1 B=$A cmd` is `1`, while the shell expands
 * the arguments of `cross-env` before it sets any of them.
 * @param command The command
 * @returns Whether it can
 */
const canPrefixWithCrossEnv = (command: Command) => {
  const cached = crossEnvCommands.get(command);
  if (cached != null) {
    return cached;
  }

  const names = new Set<string>();
  const canPrefix =
    command.name != null &&
    command.prefix.every((item) => {
      if (
        !isPlainAssignment(item) ||
        item.value.parts?.some((part) => part.type === 'BraceExpansion') ||
        doesMentionVariables(item.value.text, names)
      ) {
        return false;
      }
      names.add(item.name);
      return true;
    }) &&
    !SHELL_STATE_COMMANDS.has(staticValue(command.name) || '');
  crossEnvCommands.set(command, canPrefix);
  return canPrefix;
};

/** Walks a script that a word contains, e.g. in `$(...)` */
type NestedScriptWalker = (script: Script, part: Range, context: Context) => void;

/** Checks words, e.g. for quotes, expansions and paths */
export class WordChecker {
  readonly #reporter: Reporter;
  readonly #runnerTraits: TraitsReader;
  readonly #walkNestedScript: NestedScriptWalker;

  constructor(
    reporter: Reporter,
    walkNestedScript: NestedScriptWalker,
    runnerTraits: TraitsReader,
  ) {
    this.#reporter = reporter;
    this.#walkNestedScript = walkNestedScript;
    this.#runnerTraits = runnerTraits;
  }

  /**
   * Checks a variable assignment.
   * @param assignment Assignment to check, e.g. `CI=1`
   * @param context Where the assignment is
   * @param command The command that the assignment prefixes, e.g. `jest` in `CI=1 jest`
   */
  checkAssignment(assignment: Assignment, context: Context, command: Command | undefined) {
    const {value} = assignment;
    const isBashSpecific = this.#checkBashAssignment(assignment, context);
    const doesPrefixCommand = command != null;

    if (!isBashSpecific) {
      this.#reporter.reportSyntax(
        context,
        assignment,
        'posix',
        true,
        'unsupportedSyntax',
        {
          suggestion: CROSS_ENV_SUGGESTION,
          syntax: doesPrefixCommand
            ? `The inline environment variable assignment \`${snippet(context, assignment)}\``
            : `The shell variable assignment \`${snippet(context, assignment)}\``,
        },
        command && canPrefixWithCrossEnv(command)
          ? {
              description: 'Prefix the command with `cross-env`.',
              edits: [{end: command.pos, pos: command.pos, text: 'cross-env '}],
            }
          : undefined,
      );
    }

    // The suggested fix moves the value to `cross-env`, so only report what breaks there too
    const valueContext =
      doesPrefixCommand && !isBashSpecific ? {...context, crossEnv: true} : context;
    if (value.type === 'ArrayValue') {
      value.elements.forEach((word) => {
        this.checkWord(word, valueContext);
      });
    } else {
      // Shells don't expand globs and braces in the value
      this.checkWord(value, valueContext, {skipGlobs: true});
    }
  }

  /**
   * Checks an assignment that a declaration command receives, e.g. `A=1` in `export A=1`.
   * @param assignment Assignment to check
   * @param context Where the assignment is
   */
  checkDeclaredAssignment(assignment: Assignment, context: Context) {
    this.#checkBashAssignment(assignment, context);

    const {value} = assignment;
    (value.type === 'ArrayValue' ? value.elements : [value]).forEach((word) => {
      this.checkWord(word, context, {declaredValue: value.type === 'Word'});
    });
  }

  /**
   * Reports an assignment that only Bash supports, e.g. `A+=1` or `A=(1 2)`.
   * @param assignment Assignment to check
   * @param context Where the assignment is
   * @returns Whether it's Bash-specific
   */
  #checkBashAssignment(assignment: Assignment, context: Context) {
    const {append, index, value} = assignment;
    const isBashSpecific = value.type === 'ArrayValue' || index != null || append;

    if (isBashSpecific) {
      this.#reporter.reportSyntax(context, assignment, 'bash', false, 'unsupportedSyntax', {
        suggestion: BASH_SUGGESTION,
        syntax: `The Bash-specific ${index || value.type === 'ArrayValue' ? 'array' : 'appending'} assignment \`${snippet(context, assignment)}\``,
      });
    }

    return isBashSpecific;
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
   * Reports a variable that package managers set, but the runner doesn't, e.g. `node --run`.
   * @param name Name of the variable, e.g. `npm_package_version`
   * @param node The node to report
   * @param context Where the variable is
   * @param text How the script refers to the variable, e.g. `%npm_package_version%`
   */
  #checkPackageManagerVariable(name: string, node: Range, context: Context, text = `$${name}`) {
    if (this.#isMissingPackageManagerVariable(name)) {
      this.#reporter.report(
        context,
        node,
        'inconsistentBehavior',
        {
          reason: `${this.#runnerTraits.get('label')} doesn't set it`,
          suggestion: NODE_SCRIPT_SUGGESTION,
          syntax: `The variable \`${text}\``,
        },
        PLATFORMS,
      );
    }
  }

  /**
   * Reports a variable that `cross-env` replaces on Windows with a different value than POSIX
   * shells use, e.g. `$PWD`, or `$A` in `cross-env A=1 node $A`.
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
    if (context.portable) {
      return [];
    }

    if (context.crossEnvVariables?.has(name)) {
      return this.#reporter.report(
        context,
        node,
        'inconsistentBehavior',
        {
          reason:
            "POSIX shells expand it before `cross-env` sets it, so the command doesn't get the new value",
          suggestion: 'Use the value itself or a Node.js script instead.',
          syntax: `The variable \`${node.text}\``,
        },
        POSIX_PLATFORMS,
      );
    }

    if (!this.#isUnsetOnWindows(name)) {
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
    if (context.portable || !word.text.includes('\r')) {
      return;
    }

    const literal = word.parts
      ? word.parts.find((part) => part.type === 'Literal' && part.text.includes('\r'))
      : word;
    if (!literal) {
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

  /**
   * Reports escapes that cmd.exe doesn't remove, e.g. `\$`, and its own escape character `^`.
   * @param word Word to check
   * @param context Where the word is
   * @param shouldCheckCaret Whether to check for `^`, which a nested script checks itself
   */
  #checkEscapes(word: Word, context: Context, shouldCheckCaret: boolean) {
    const literals = word.parts
      ? word.parts.flatMap((part) => {
          if (part.type === 'Literal') {
            return {pattern: UNQUOTED_ESCAPE, text: part.text};
          }
          return part.type === 'DoubleQuoted'
            ? part.parts.flatMap((child) =>
                child.type === 'Literal' ? {pattern: QUOTED_ESCAPE, text: child.text} : [],
              )
            : [];
        })
      : [{pattern: UNQUOTED_ESCAPE, text: word.text}];

    const escape = literals
      .flatMap(({pattern, text}) => text.match(pattern) || [])
      .find((match) => !(context.crossEnv && CROSS_ENV_ESCAPE.test(match)));

    if (escape != null) {
      this.#reporter.reportSyntax(context, word, 'posix', true, 'inconsistentBehavior', {
        reason: "cmd.exe doesn't treat backslashes as escape characters, so it passes them on",
        suggestion: 'Use escaped double quotes (`\\"`) instead.',
        syntax: `The backslash escape \`${escape}\``,
      });
    }

    // cmd.exe's own escape character, e.g. in `npm install mobx@^5`
    if (
      shouldCheckCaret &&
      literals.some(({pattern, text}) => pattern === UNQUOTED_ESCAPE && text.includes('^'))
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
          syntax: `The caret in \`${snippet(context, word)}\``,
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
        syntax: `The ${bashLabel(bashKind)} parameter expansion \`${snippet(context, part)}\``,
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
          syntax: `The variable expansion \`${snippet(context, part)}\``,
        },
      );
    }

    // Operands can contain further expansions, e.g. `${A:-$(cmd)}`
    const nestedContext = withCovered(context, covered);
    this.#checkBashVariable(part.parameter, part, nestedContext);
    this.#checkPackageManagerVariable(part.parameter, part, nestedContext);
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
          syntax: `The Bash-specific ANSI-C quoted string \`${snippet(context, part)}\``,
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
            syntax: `The arithmetic expansion \`${snippet(context, part)}\``,
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
              syntax: `The Bash-specific arithmetic in \`${snippet(context, part)}\``,
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
            syntax: `The command substitution \`${snippet(context, part)}\``,
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
            // Quoting a pattern that the shell matches, e.g. in `case`, makes it a plain string
            suggestion: state.skipGlobs
              ? "It requires Bash's `extglob` option; use a Node.js script instead."
              : "It requires Bash's `extglob` option; quote the pattern and let the tool expand it instead.",
            syntax: `The extended glob \`${snippet(context, part)}\``,
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
          syntax: `The Bash-specific locale string \`${snippet(context, part)}\``,
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
            syntax: `The Bash-specific process substitution \`${snippet(context, part)}\``,
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
        const nestedContext = withCovered(context, covered);
        this.#checkBashVariable(name, part, nestedContext);
        this.#checkPackageManagerVariable(name, part, nestedContext);
        break;
      }

      case 'SingleQuoted': {
        state.hasSingleQuotes = true;
        // cmd.exe still splits the string at whitespace and interprets its special characters
        if (
          (state.printedToTerminal && !CMD_OPERATORS.test(part.value)) ||
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
            reason: state.printedToTerminal
              ? "cmd.exe doesn't treat single quotes as quotes, so it runs the operators in the string"
              : context.crossEnv
                ? "cmd.exe doesn't treat single quotes as quotes, so it splits the string before `cross-env` removes them"
                : "cmd.exe doesn't treat single quotes as quotes, so they're passed on literally",
            suggestion: 'Use escaped double quotes (`\\"`) instead.',
            syntax: `The single-quoted string \`${snippet(context, part)}\``,
          },
          // cmd.exe's `echo` prints double quotes too, and in double quotes a placeholder like
          // `%LANG%` is reported as a Windows variable
          state.command === 'echo' ||
            DOUBLE_QUOTED_SPECIAL_CHARACTERS.test(part.value) ||
            WINDOWS_VARIABLE.test(part.value)
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
   * Reports a brace expansion in the target of a redirection, e.g. in `> out.{log,txt}`.
   * Bash expands it into several words and fails, while other shells keep the braces.
   * @param part The brace expansion
   * @param context Where the redirection is
   */
  #checkRedirectionBraces(part: BraceExpansionPart, context: Context) {
    // It's not known what Yarn's shell does
    if (!context.portable) {
      this.#reporter.report(
        context,
        part,
        'inconsistentBehavior',
        {
          reason: 'Bash (the `sh` of macOS) expands it into several file names, which is an error',
          suggestion: 'Use a single file name instead.',
          syntax: `The brace expansion \`${snippet(context, part)}\` in a redirection`,
        },
        context.shell === 'bash' ? PLATFORMS : MACOS_PLATFORMS,
      );
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
          suggestion: 'Remove it or use a Node.js script instead.',
          syntax: `The POSIX path \`${truncate(value)}\``,
        },
        WINDOWS_PLATFORMS,
        fix,
      );
    }
  }

  checkWord(word: Word, context: Context, options: WordOptions = {}) {
    const {text} = word;
    // Its expansions and quotes are still checked, as the outer shell handles them
    const shouldCheckText = !options.nestedScript;

    if (shouldCheckText) {
      this.#checkCarriageReturn(word, context);
    }

    if (shouldCheckText && TILDE_EXPANSION.test(text)) {
      this.#reporter.reportSyntax(context, word, 'posix', false, 'unsupportedSyntax', {
        suggestion: 'Use a path relative to the package or a Node.js script instead.',
        syntax: `The tilde expansion \`${snippet(context, word)}\``,
      });
    }

    const state: WordState = {
      braceExpansions: [],
      command: options.command,
      globPosition: undefined,
      hasSingleQuotes: false,
      printedToTerminal: options.printedToTerminal || false,
      skipGlobs: options.skipGlobs || false,
    };
    if (word.parts) {
      this.#checkParts(word.parts, context, state);
    }

    const {globPosition} = state;
    const hasGlob = globPosition != null;
    const globPrefix = hasGlob ? text.slice(0, globPosition - word.pos) : '';

    // A pattern in an option or assignment value (e.g. `--include=src/*`) can't match a file, so
    // every shell passes it on literally
    const isLiteralPattern = globPrefix.startsWith('-') || globPrefix.includes('=');

    // Other unquoted globs aren't reported, as many tools expand globs themselves when the shell
    // doesn't (e.g. cmd.exe). But a trailing `**` matches the same top-level entries as `*` (and
    // `a**` is just `a*`), so only a `**/` segment is affected
    if (
      shouldCheckText &&
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
          suggestion:
            'Quote it with escaped double quotes (`\\"`) and let the tool expand it instead.',
          syntax: `The unquoted glob \`${snippet(context, word)}\``,
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
    if (
      !hasGlob &&
      !options.skipGlobs &&
      (options.command == null || OS_COMMANDS.has(options.command))
    ) {
      state.braceExpansions.forEach((part) => {
        if (options.redirectTarget) {
          this.#checkRedirectionBraces(part, context);
          return;
        }

        this.#reporter.reportSyntax(
          context,
          part,
          'bash',
          true,
          'unsupportedSyntax',
          {
            suggestion: 'List the alternatives explicitly instead.',
            syntax: `The Bash-specific brace expansion \`${snippet(context, part)}\``,
          },
          options.declaredValue ? undefined : braceExpansionFix(word, part),
        );
      });
    }

    // Most words have no backslashes, so they need none of the path checks
    const hasBackslash = text.includes('\\');
    const path = hasBackslash ? substringAfterLast(text.replaceAll('"', ''), '=') : '';
    const isBackslashPath = hasBackslash && BACKSLASH_PATH.test(path);

    // Require a hint that it's a path (relative prefix, extension, or multiple separators), as
    // backslashes are also used for escapes
    if (
      isBackslashPath &&
      shouldCheckText &&
      !options.text &&
      !setHas(PATTERN_COMMANDS, options.command) &&
      !state.hasSingleQuotes &&
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
          : backslashPathFix(word, originalText(context, word)),
      );
    }

    // e.g. `dist\*` in `del /q dist\*` and `.\node_modules\ ` in `rd .\node_modules\ -r`
    const isWindowsPath = isBackslashPath || (hasBackslash && WINDOWS_PATH_PREFIX.test(path));
    // Without backslashes, there are no escapes, so only a caret can be reported
    if (!isWindowsPath && (hasBackslash || text.includes('^'))) {
      this.#checkEscapes(word, context, shouldCheckText);
    }

    // In single quotes, it's likely the tool's own placeholder, e.g. in
    // `--bundle-structure '%LANG_ISO%.json'`. Anywhere else, such a placeholder can't be told from
    // a variable, so it's reported too: a known limit
    if (
      shouldCheckText &&
      !state.hasSingleQuotes &&
      options.command !== 'date' &&
      options.command !== 'printf'
    ) {
      const match = WINDOWS_VARIABLE.exec(text);
      // Other `%` signs indicate a format string, e.g. `--pretty=format:%C(bold)%ad%C(reset)`
      if (match && !text.replaceAll(WINDOWS_VARIABLES, '').includes('%')) {
        const covered = this.#reporter.report(
          context,
          word,
          'unsupportedSyntax',
          {
            suggestion: VARIABLE_SUGGESTION,
            syntax: `The Windows variable reference \`${match[0]}\``,
          },
          context.portable ? PLATFORMS : POSIX_PLATFORMS,
        );
        const nestedContext = withCovered(context, covered);
        text.matchAll(WINDOWS_VARIABLES).forEach(([reference]) => {
          this.#checkPackageManagerVariable(reference.slice(1, -1), word, nestedContext, reference);
        });
      }
    }

    const value = staticValue(word);

    // Redirection targets are checked with their redirection
    if (shouldCheckText && value != null && !options.commandName && !options.redirectTarget) {
      this.checkPosixPath(word, value, context);
    }
  }

  /** Checks whether Windows doesn't set a variable, so `cross-env` replaces it with nothing */
  #isUnsetOnWindows(name: string) {
    return (
      POSIX_ONLY_VARIABLES.has(name) || (name === 'HOME' && !this.#runnerTraits.get('setsHome'))
    );
  }

  /** Checks whether a variable is one that package managers set, but the runner doesn't */
  #isMissingPackageManagerVariable(name: string) {
    // Checked first, so that the trait is only read for these variables
    if (!PACKAGE_MANAGER_VARIABLE.test(name)) {
      return false;
    }

    const variables = this.#runnerTraits.get('packageManagerVariables');
    return variables != null && !variables.has(name);
  }

  /** Gets what to use instead of a variable on Windows, where `cross-env` can't help for some */
  #variableSuggestion(name: string) {
    if (name === 'PWD') {
      return 'Use a relative path or a Node.js script instead.';
    }
    return this.#isUnsetOnWindows(name) || this.#isMissingPackageManagerVariable(name)
      ? NODE_SCRIPT_SUGGESTION
      : VARIABLE_SUGGESTION;
  }
}
