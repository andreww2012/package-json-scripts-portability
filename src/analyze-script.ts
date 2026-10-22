// cspell:ignore wordlist
import {
  type AndOr,
  type Command,
  type CompoundList,
  type DoubleQuotedChild,
  type Pipeline,
  type PipelineNode,
  type Script,
  type Statement,
  type TestExpression,
  type Word,
  type WordPart,
  parse,
} from 'unbash';
import {CommandChecker, type NestedWordsOptions} from './command-checker.ts';
import {SHELLS, SHELL_STATE_COMMANDS} from './commands.ts';
import {
  type Context,
  type Range,
  type SyntaxKind,
  bashLabel,
  rangeInScript,
  withCovered,
} from './context.ts';
import {joinLinesFix, lineBreakFix, removal, semicolonFix} from './fixes.ts';
import {
  BASH_4_SUGGESTION,
  BASH_SUGGESTION,
  NODE_SCRIPT_SUGGESTION,
  describeReplacement,
  truncate,
} from './messages.ts';
import {PLATFORMS, POSIX_PLATFORMS, type Platform, WINDOWS_PLATFORMS} from './platforms.ts';
import {RedirectionChecker} from './redirection-checker.ts';
import {Reporter, type ScriptFix} from './reporter.ts';
import {WordChecker} from './word-checker.ts';
import {DOUBLE_QUOTED_SPECIAL_CHARACTERS, WHITESPACE} from './words.ts';

export interface AnalyzeScriptOptions {
  /** Names of the package's dependencies, e.g. to detect del-cli's `del` alias */
  dependencies?: readonly string[];

  /** Commands that shouldn't be reported */
  ignoreCommands?: readonly string[];

  /** Whether the script runs in Yarn's portable shell, which supports POSIX syntax everywhere */
  portableShell?: boolean;

  /**
   * Whether Yarn v1 runs the script.
   * Unlike npm and pnpm, it doesn't set `HOME`, and on Windows, it replaces `/` with `\` in the
   * script's command names
   */
  yarnClassic?: boolean;
}

const ONE_LINE_SUGGESTION = 'Put the command on one line instead.';

/** A script that only consists of a comment line, i.e. documentation rather than a script */
const COMMENT_LINE = /^\s*#[^\n]*$/;
/** A `#` comment after a word boundary */
const COMMENT = /(?:^|[\s&;|])(#.*)/;
/** A glob of script names that `concurrently` expands, e.g. `npm run watch:*(!css)` */
const SCRIPT_GLOB = /((?:bun|npm|pnpm|yarn) run|node --run|deno task) (\S*\*\S*)/;
/** `shopt -s globstar`, which makes `**` recursive in the following commands */
const SHOPT_GLOBSTAR = /\bshopt\s+-s\s+(?:\w+\s+)*globstar\b/;
/** The rest of a script that only closes subshells */ // cspell:disable-line
const CLOSING_PARENTHESES = /^[\s)]*$/;
const WINDOWS_BATCH_SYNTAX =
  /\bif\s+(?:\/i\s+)?(?:not\s+)?(?:defined|errorlevel|exist)\b|\bfor\s+(?:\/[a-z]\s+)*%%?[a-z]\b/gi;
const SINGLE_QUOTE = /'/;
const ANY_CHARACTER = /[\s\S]/;

const doesChangeDirectory = (node: AndOr | PipelineNode): boolean => {
  switch (node.type) {
    case 'AndOr':
    case 'Pipeline': {
      return node.commands.some(doesChangeDirectory);
    }
    case 'Command': {
      return node.name?.value === 'cd' || node.name?.value === 'pushd';
    }
    default: {
      return false;
    }
  }
};

/**
 * Checks whether commands change the shell's state, e.g. with `exit` or a variable assignment.
 * @param node Commands of a command group
 * @returns Whether they do, or might, e.g. in an `if` statement
 */
const doesChangeShellState = (node: AndOr | PipelineNode): boolean => {
  switch (node.type) {
    case 'AndOr':
    case 'Pipeline': {
      return node.commands.some(doesChangeShellState);
    }
    case 'BraceGroup': {
      return node.body.commands.some((statement) => doesChangeShellState(statement.command));
    }
    case 'Command': {
      return node.name
        ? SHELL_STATE_COMMANDS.has(node.name.value)
        : node.prefix.some((item) => item.type === 'Assignment');
    }
    case 'Redirected': {
      return doesChangeShellState(node.command);
    }
    case 'Subshell': {
      return false;
    }
    default: {
      return true;
    }
  }
};

/**
 * Gets the text that a command receives for a word, e.g. a script for `sh -c`.
 * The outer shell's expansions are replaced by placeholders of the same length.
 * Their results aren't known, and they're reported for the outer script already.
 * @param parts The word's parts
 * @returns The text, with placeholders
 */
const nestedSource = (parts: readonly (DoubleQuotedChild | WordPart)[]): string =>
  parts
    .map((part) => {
      switch (part.type) {
        case 'AnsiCQuoted':
        case 'Glob':
        case 'Literal':
        case 'SingleQuoted': {
          return part.value;
        }
        case 'DoubleQuoted':
        case 'LocaleString': {
          return nestedSource(part.parts);
        }
        default: {
          return '_'.repeat(part.text.length);
        }
      }
    })
    .join('');

/**
 * Finds the end of a run of `||` alternatives that each break on some platform, but together work
 * on all platforms, e.g. `open x || xdg-open x || start x`.
 * @param node The list that the alternatives are in
 * @param platformsOf Gets the platforms on which a command of the list doesn't work
 * @param first Index of the run's first command
 * @returns Index of the run's last command, if there's such a run
 */
const findFallbackEnd = (
  node: AndOr,
  platformsOf: (index: number) => ReadonlySet<Platform>,
  first: number,
) => {
  let unsupported = platformsOf(first);

  for (
    let last = first + 1;
    unsupported.size > 0 && last < node.commands.length && node.operators[last - 1] === '||';
    last++
  ) {
    const platforms = platformsOf(last);
    // The alternative isn't platform-specific, e.g. `rm -rf dist || echo failed`
    if (platforms.size === 0) {
      return undefined;
    }

    unsupported = unsupported.intersection(platforms);
    if (unsupported.size === 0) {
      return last;
    }
  }

  return undefined;
};

class ScriptAnalyzer {
  readonly #commands: CommandChecker;
  /** Ranges of reported line breaks in the analyzed script, e.g. to skip them in nested scripts */
  readonly #lineBreaks: Range[] = [];
  readonly #multilineSources = new Set<string>();
  /** Commands whose output goes into a pipe */
  readonly #pipedCommands = new Set<PipelineNode>();
  readonly #redirections: RedirectionChecker;
  readonly #reporter: Reporter;
  readonly #words: WordChecker;

  constructor(length: number, options: AnalyzeScriptOptions) {
    this.#reporter = new Reporter(length);
    this.#words = new WordChecker(
      this.#reporter,
      (script, part, context) => {
        this.#walkNestedScript(script, part, context);
      },
      options.yarnClassic || false,
    );
    this.#redirections = new RedirectionChecker(this.#reporter, this.#words);
    this.#commands = new CommandChecker(this.#reporter, options, (words, context, nested) => {
      this.#analyzeNestedWords(words, context, nested);
    });
  }

  get issues() {
    return this.#reporter.issues;
  }

  analyzeSource(context: Context) {
    const script = parse(context.source);

    if (script.errors?.length) {
      // The script is probably not meant for a POSIX shell, so only look for cmd.exe syntax
      this.#checkWindowsBatchSyntax(context);
      return;
    }

    this.#commands.addPositionalFixes(script.commands);

    const isEnablesGlobstar = context.shell === 'bash' && SHOPT_GLOBSTAR.test(context.source);
    const scriptContext = isEnablesGlobstar
      ? {...context, bashOptions: new Set([...(context.bashOptions || []), 'globstar'])}
      : context;

    this.#walkStatements(script.commands, script.end, scriptContext);
    this.#checkComments(script.commands, scriptContext);
  }

  #analyzeNestedWords(
    words: readonly Word[],
    context: Context,
    {bashOptions, crossEnv, maskScriptGlobs = false, shell}: NestedWordsOptions,
  ) {
    const sources = words.map((word) => {
      const source = word.parts ? nestedSource(word.parts) : word.value;
      return maskScriptGlobs
        ? source.replace(
            SCRIPT_GLOB,
            (_, command: string, glob: string) => `${command} ${'_'.repeat(glob.length)}`,
          )
        : source;
    });
    const [word] = words;
    if (!word) {
      return;
    }

    const parts = word.parts || [];
    const [part] = parts;
    let {fixedRange} = context;
    let offset = context.offset + word.pos;
    // An unquoted word, e.g. in `sh -c true`, ends at whitespace and shell syntax
    let exclusion = ANY_CHARACTER;

    if (
      words.length === 1 &&
      parts.length === 1 &&
      (part?.type === 'SingleQuoted' ||
        (part?.type === 'DoubleQuoted' &&
          part.parts.every((child) => child.type !== 'Literal' || child.value === child.text)))
    ) {
      // A quoted string without escapes: its content maps 1:1 to the script
      offset = context.offset + part.pos + 1;
      exclusion = part.type === 'SingleQuoted' ? SINGLE_QUOTE : DOUBLE_QUOTED_SPECIAL_CHARACTERS;
    } else if (words.length > 1 || parts.length > 0 || word.text !== sources[0]) {
      // Escapes, quotes or joined words make positions in the nested script unmappable
      fixedRange ||= rangeInScript(context, {
        end: words.at(-1)?.end || word.end,
        pos: word.pos,
      });
    }

    this.analyzeSource({
      bashOptions,
      convertsSlashes: false,
      covered: context.covered,
      crossEnv,
      fixExclusions: [...context.fixExclusions, exclusion],
      fixedRange,
      offset,
      portable: false,
      shell,
      source: sources.join(' '),
    });
  }

  #checkComments(statements: readonly Statement[], context: Context) {
    // unbash skips comments, so look for a `#` at a word boundary outside of all statements
    let position = 0;

    [...statements, undefined].forEach((statement, index) => {
      // Not `||`: the first statement can start at 0
      const end = statement?.pos ?? context.source.length;
      const match = COMMENT.exec(context.source.slice(position, end));
      const comment = match?.[1];

      if (match && comment != null) {
        const start = position + match.index + match[0].length - comment.length;
        const commentEnd = start + comment.length;
        this.#reporter.reportSyntax(
          context,
          {end: commentEnd, pos: start},
          'posix',
          false,
          'unsupportedSyntax',
          {suggestion: 'Remove it instead.', syntax: 'The `#` comment'},
          {
            description: 'Remove the comment.',
            edits: [removal(context.source, start, commentEnd)],
          },
        );
      }

      position = statement
        ? this.#statementEnd(
            statement,
            statements.at(index + 1)?.pos || context.source.length,
            context.source,
          )
        : end;
    });
  }

  /**
   * Gets where the text after a statement starts, after the bodies of its here-documents.
   * @param statement A statement of the source
   * @param nextStart Where the next statement starts, or where the source ends
   * @param source The source that the statement is in
   * @returns The offset in the source
   */
  #statementEnd(statement: Statement, nextStart: number, source: string) {
    const hereDocumentEnds = (this.#redirections.hereDocumentEnds.get(source) || []).filter(
      (end) => end <= nextStart,
    );
    return Math.max(statement.end, ...hereDocumentEnds);
  }

  #checkWindowsBatchSyntax(context: Context) {
    context.source.matchAll(WINDOWS_BATCH_SYNTAX).forEach((match) => {
      this.#reporter.report(
        context,
        {end: match.index + match[0].length, pos: match.index},
        'unsupportedSyntax',
        {
          suggestion: NODE_SCRIPT_SUGGESTION,
          syntax: `The Windows batch syntax \`${truncate(match[0])}\``,
        },
        context.portable ? PLATFORMS : POSIX_PLATFORMS,
      );
    });
  }

  /**
   * Drops the issues of alternatives for different platforms, e.g. `rm -rf a || rmdir /s /q a`.
   * @param node The list of commands joined by `||` (and other operators)
   * @param starts Index of the first issue of each command in the list, and of the end of its
   * issues
   */
  #dropPlatformFallbacks(node: AndOr, starts: readonly number[]) {
    const platformsOf = (index: number) =>
      new Set(
        this.#reporter.issues
          .slice(starts[index], starts[index + 1])
          .flatMap((issue) => issue.platforms),
      );
    const dropped: [start: number, end: number][] = [];

    let first = 0;
    while (first < node.commands.length) {
      const last = findFallbackEnd(node, platformsOf, first);
      if (last == null) {
        first++;
      } else {
        // Later alternatives are still reported, e.g. `true` in `rm ... || rmdir /s ... || true`
        dropped.push([first, last]);
        first = last + 1;
      }
    }

    dropped.toReversed().forEach(([runStart, runEnd]) => {
      const start = starts[runStart];
      const end = starts[runEnd + 1];
      if (start != null && end != null) {
        this.#reporter.issues.splice(start, end - start);
      }
    });
  }

  #walkCommand(node: AndOr | PipelineNode, context: Context) {
    switch (node.type) {
      case 'AndOr': {
        const starts: number[] = [];
        node.commands.forEach((command) => {
          starts.push(this.#reporter.issues.length);
          this.#walkCommand(command, context);
        });
        starts.push(this.#reporter.issues.length);
        this.#dropPlatformFallbacks(node, starts);
        this.#checkOperatorLineBreaks(node.commands, context);
        break;
      }

      case 'ArithmeticCommand': {
        this.#reporter.reportSyntax(context, node, 'bash', false, 'unsupportedSyntax', {
          suggestion: BASH_SUGGESTION,
          syntax: 'The Bash-specific `(( ... ))` arithmetic command',
        });
        break;
      }

      case 'ArithmeticFor': {
        this.#walkList(node.body, this.#reportStatement(context, node, 'for (( ... ))', 'bash'));
        break;
      }

      case 'BraceGroup': {
        // A subshell keeps e.g. `cd` and `exit` from affecting the commands that follow
        const isSubshellSafe =
          context.source[node.end - 1] === '}' &&
          node.body.commands.every((statement) => !doesChangeShellState(statement.command));
        const covered = this.#reporter.reportSyntax(
          context,
          {end: node.pos + 1, pos: node.pos},
          'posix',
          true,
          'unsupportedSyntax',
          {
            suggestion: 'Use `( ... )` instead.',
            syntax: 'The command group `{ ... }`',
          },
          isSubshellSafe
            ? {
                description: 'Replace `{ ... }` with `( ... )`.',
                edits: [
                  {end: node.pos + 1, pos: node.pos, text: '('},
                  {end: node.end, pos: node.end - 1, text: ')'},
                ],
              }
            : undefined,
        );
        this.#walkList(node.body, withCovered(context, covered));
        break;
      }

      case 'Case': {
        const nestedContext = this.#reportStatement(context, node, 'case', 'posix');
        this.#words.checkWord(node.word, nestedContext);
        node.items.forEach(({body, end, terminator}) => {
          this.#walkList(body, nestedContext);
          if (terminator === ';&' || terminator === ';;&') {
            this.#reporter.reportSyntax(
              nestedContext,
              {end, pos: end - terminator.length},
              'bash4',
              false,
              'unsupportedSyntax',
              {
                suggestion: BASH_4_SUGGESTION,
                syntax: `The Bash 4 \`${terminator}\` case terminator`,
              },
            );
          }
        });
        break;
      }

      case 'Command': {
        this.#walkSimpleCommand(node, context);
        break;
      }

      case 'Coproc': {
        const nestedContext = this.#reportStatement(context, node, 'coproc', 'bash4');
        if (node.body.type === 'CompoundList') {
          this.#walkList(node.body, nestedContext);
        } else {
          this.#walkCommand(node.body, nestedContext);
        }
        break;
      }

      case 'For': {
        const nestedContext = this.#reportStatement(context, node, 'for', 'posix');
        node.wordlist?.forEach((word) => {
          this.#words.checkWord(word, nestedContext);
        });
        this.#walkList(node.body, nestedContext);
        break;
      }

      case 'Function': {
        const isUsesKeyword = context.source.startsWith('function', node.pos);
        const covered = this.#reporter.reportSyntax(
          context,
          {end: node.name.end, pos: node.pos},
          isUsesKeyword ? 'bash' : 'posix',
          false,
          'unsupportedSyntax',
          isUsesKeyword
            ? {
                suggestion: 'Use `name() { ... }` or a Node.js script instead.',
                syntax: 'The Bash-specific `function` keyword',
              }
            : {
                suggestion: NODE_SCRIPT_SUGGESTION,
                syntax: `The shell function definition \`${node.name.text}()\``,
              },
        );

        const nestedContext = withCovered(context, covered);
        if (node.body.type === 'CompoundList') {
          this.#walkList(node.body, nestedContext);
        } else {
          this.#walkCommand(node.body, nestedContext);
        }
        break;
      }

      case 'If': {
        const nestedContext = this.#reportStatement(context, node, 'if', 'posix');
        this.#walkList(node.clause, nestedContext);
        this.#walkList(node.then, nestedContext);
        node.elif.forEach((elif) => {
          this.#walkList(elif.clause, nestedContext);
          this.#walkList(elif.then, nestedContext);
        });
        if (node.else) {
          this.#walkList(node.else, nestedContext);
        }
        break;
      }

      case 'Pipeline': {
        this.#walkPipeline(node, context);
        break;
      }

      case 'Redirected': {
        this.#walkCommand(node.command, context);
        node.redirects.forEach((redirection) => {
          this.#redirections.checkRedirection(redirection, context);
        });
        break;
      }

      case 'Select': {
        const nestedContext = this.#reportStatement(context, node, 'select', 'bash');
        node.wordlist?.forEach((word) => {
          this.#words.checkWord(word, nestedContext);
        });
        this.#walkList(node.body, nestedContext);
        break;
      }

      case 'Subshell': {
        if (
          !context.portable &&
          node.body.commands.some((statement) => doesChangeDirectory(statement.command)) &&
          !CLOSING_PARENTHESES.test(context.source.slice(node.end))
        ) {
          this.#reporter.reportSyntax(context, node, 'posix', true, 'inconsistentBehavior', {
            reason:
              'cmd.exe only groups the commands, so `cd` also changes the directory of the commands that follow',
            suggestion: 'Use `npm --prefix <directory>` or workspaces instead.',
            syntax: 'The subshell `( ... )`',
          });
        }
        this.#walkList(node.body, context);
        break;
      }

      case 'TestCommand': {
        const covered = this.#reporter.reportSyntax(
          context,
          node,
          'bash',
          false,
          'unsupportedSyntax',
          {
            suggestion: 'Use `test` or a Node.js script instead.',
            syntax: 'The Bash-specific `[[ ... ]]` test',
          },
        );
        this.#walkTestExpression(node.expression, withCovered(context, covered));
        break;
      }

      case 'While': {
        const nestedContext = this.#reportStatement(context, node, node.kind, 'posix');
        this.#walkList(node.clause, nestedContext);
        this.#walkList(node.body, nestedContext);
        break;
      }
      // No default
    }
  }

  #walkList(list: CompoundList, context: Context) {
    this.#walkStatements(list.commands, list.end, context);
  }

  #walkNestedScript(script: Script, part: Range, context: Context) {
    const nestedContext =
      script.source == null
        ? context
        : {...context, fixedRange: rangeInScript(context, part), source: script.source};

    this.#walkStatements(script.commands, script.end, nestedContext);
  }

  #walkPipeline(node: Pipeline, context: Context) {
    node.prefixes.forEach((prefix) => {
      this.#reporter.reportSyntax(
        context,
        prefix,
        'posix',
        false,
        'unsupportedSyntax',
        prefix.type === 'Negation'
          ? {suggestion: NODE_SCRIPT_SUGGESTION, syntax: 'The pipeline negation `!`'}
          : {
              suggestion: "cmd.exe's `time` sets the system time; use a Node.js script instead.",
              syntax: 'The `time` keyword',
            },
      );
    });

    node.operators.forEach((operator, index) => {
      if (operator !== '|&') {
        return;
      }

      const position = context.source.indexOf('|&', node.commands[index]?.end);
      const range = {end: position + 2, pos: position};
      // e.g. `a|&b`, where `2>&1` would otherwise become part of the command's name
      const separator = WHITESPACE.test(context.source[position - 1] || '') ? '' : ' ';
      this.#reporter.reportSyntax(
        context,
        range,
        'bash4',
        true,
        'unsupportedSyntax',
        {suggestion: 'Use `2>&1 |` instead.', syntax: 'The Bash 4 `|&` operator'},
        {
          description: describeReplacement('|&', '2>&1 |'),
          edits: [{...range, text: `${separator}2>&1 |`}],
        },
      );
    });

    node.commands.slice(0, -1).forEach((command) => {
      this.#pipedCommands.add(command);
    });
    node.commands.forEach((command) => {
      this.#walkCommand(command, context);
    });
    this.#checkOperatorLineBreaks(node.commands, context);
  }

  #walkSimpleCommand(node: Command, context: Context) {
    const isRedirection = node.name == null && node.prefix.length + node.suffix.length === 1;

    node.prefix.forEach((item) => {
      if (item.type === 'Assignment') {
        this.#words.checkAssignment(item, context, node.name ? node : undefined);
      } else {
        this.#redirections.checkRedirection(item, context, isRedirection);
      }
    });

    const invocation =
      node.name &&
      this.#commands.checkInvocation(
        node.name,
        node.suffix.filter((item) => item.type === 'Word'),
        context,
        0,
      );
    let argumentContext = invocation?.crossEnv ? {...context, crossEnv: true} : context;
    // Shells and `find` have to be replaced on Windows anyway (e.g. with a Node.js script), so how
    // their arguments are quoted doesn't matter there
    if (
      invocation?.name != null &&
      (SHELLS.includes(invocation.name) || invocation.name === 'find')
    ) {
      argumentContext = withCovered(argumentContext, WINDOWS_PLATFORMS);
    }

    if (node.name) {
      this.#words.checkWord(node.name, context, {commandName: true});

      if (invocation?.name === 'echo' && !context.portable) {
        this.#redirections.checkEchoToFile(node, context);
      }
    }

    this.#checkCommandLineBreak(node, argumentContext);

    const isPrintedToTerminal =
      invocation?.target === 'echo' &&
      node.redirects.length === 0 &&
      !this.#pipedCommands.has(node);

    node.suffix.forEach((item) => {
      if (item.type === 'Assignment') {
        (item.value.type === 'Word' ? [item.value] : item.value.elements).forEach((word) => {
          this.#words.checkWord(word, argumentContext);
        });
      } else if (item.type === 'Word') {
        this.#words.checkWord(item, argumentContext, {
          command: invocation?.target,
          printedToTerminal: isPrintedToTerminal,
        });
      } else {
        // Redirections are handled by the shell, not the command
        this.#redirections.checkRedirection(item, context);
      }
    });
  }

  /**
   * Reports a line break in a command, e.g. after a `\\` line continuation or in a quoted string.
   * @param node The command
   * @param context Where the command is
   */
  #checkCommandLineBreak(node: Command, context: Context) {
    const newline = context.source.slice(node.pos, node.end).indexOf('\n');
    if (newline === -1) {
      return;
    }

    const position = node.pos + newline;
    // A line break in a word, e.g. in quotes, is part of its value in POSIX shells
    const isInWord = [node.name, ...node.prefix, ...node.suffix].some(
      (item) => item && item.pos <= position && position < item.end,
    );
    // Yarn's shell keeps a `\\` line continuation as a line break, but supports one in quotes
    const isQuoted = isInWord && context.source[position - 1] !== '\\';

    this.#reportLineBreak(
      context,
      position,
      ONE_LINE_SUGGESTION,
      isInWord ? undefined : joinLinesFix(context.source, position, position + 1),
      isQuoted,
    );
  }

  /**
   * Reports a line break after an operator of a list or pipeline, e.g. after `||`.
   * @param commands The commands that the operators join
   * @param context Where the commands are
   */
  #checkOperatorLineBreaks(commands: readonly Range[], context: Context) {
    for (const [index, next] of commands.entries()) {
      const command = commands[index - 1];
      if (!command) {
        continue;
      }

      const between = context.source.slice(command.end, next.pos);
      const newline = between.indexOf('\n');

      if (newline !== -1) {
        const position = command.end + newline;
        // A comment ends at the line break, so joining the lines would comment the rest out
        this.#reportLineBreak(
          context,
          position,
          ONE_LINE_SUGGESTION,
          between.includes('#') ? undefined : joinLinesFix(context.source, position, next.pos),
        );
        return;
      }
    }
  }

  /**
   * Reports a line break, after which cmd.exe ignores the rest of the script, once per source.
   * @param context Where the line break is
   * @param position Where the line break is in the source
   * @param suggestion What to do instead
   * @param fix A fix for the report
   * @param isPortableSupported Whether Yarn's shell supports it, e.g. in quotes
   */
  #reportLineBreak(
    context: Context,
    position: number,
    suggestion: string,
    fix?: ScriptFix,
    isPortableSupported = false,
  ) {
    const range = rangeInScript(context, {end: position + 1, pos: position});
    // e.g. in `concurrently "a` + line break + `b"`, which is reported for the outer script already
    const isReported = this.#lineBreaks.some(
      (reported) => reported.pos < range.end && range.pos < reported.end,
    );

    if (isReported || this.#multilineSources.has(context.source)) {
      return;
    }

    const platforms = this.#reporter.reportSyntax(
      context,
      {end: position + 1, pos: position},
      'posix',
      isPortableSupported,
      'unsupportedSyntax',
      {suggestion, syntax: 'A multi-line script'},
      fix,
    );

    // A line break in a piece that was reported already doesn't count, e.g. in an `if` statement
    if (platforms.length === 0) {
      return;
    }

    this.#multilineSources.add(context.source);
    this.#lineBreaks.push(range);
  }

  #reportStatement(context: Context, node: Range, keyword: string, kind: SyntaxKind) {
    // e.g. `for` in `for (( ... ))`
    const [firstWord = keyword] = keyword.split(' ', 1);
    const covered = this.#reporter.reportSyntax(
      context,
      {end: node.pos + firstWord.length, pos: node.pos},
      kind,
      false,
      'unsupportedSyntax',
      kind === 'posix'
        ? {suggestion: NODE_SCRIPT_SUGGESTION, syntax: `The shell \`${keyword}\` statement`}
        : {
            suggestion: kind === 'bash4' ? BASH_4_SUGGESTION : BASH_SUGGESTION,
            syntax: `The ${bashLabel(kind)} \`${keyword}\` statement`,
          },
    );

    return withCovered(context, covered);
  }

  #walkStatements(statements: readonly Statement[], end: number, context: Context) {
    const firstIssue = this.#reporter.issues.length;
    const backgroundOperators: Range[] = [];

    statements.forEach((statement, index) => {
      this.#walkCommand(statement.command, context);

      if (statement.background) {
        const position = context.source.lastIndexOf('&', statement.end - 1);
        backgroundOperators.push({end: position + 1, pos: position});
        return;
      }

      const next = statements.at(index + 1);
      const gapEnd = next?.pos || end;
      const gapStart = this.#statementEnd(statement, gapEnd, context.source);
      const gap = context.source.slice(gapStart, gapEnd);
      // A `;` can't follow a comment, which ends at the end of the line
      const comment = COMMENT.exec(gap);
      const commentText = comment?.[1];
      const commentStart =
        comment && commentText != null
          ? comment.index + comment[0].length - commentText.length
          : undefined;
      const semicolon = gap.slice(0, commentStart).indexOf(';');

      if (semicolon !== -1) {
        const range = {end: gapStart + semicolon + 1, pos: gapStart + semicolon};
        this.#reporter.reportSyntax(
          context,
          range,
          'posix',
          true,
          'unsupportedSyntax',
          {suggestion: 'Use `&&` instead.', syntax: 'The `;` command separator'},
          semicolonFix(range, gap, next),
        );
      } else if (next && gap.includes('\n')) {
        this.#reportLineBreak(
          context,
          gapStart + gap.indexOf('\n'),
          'Join the commands with `&&` instead.',
          lineBreakFix(gapStart, gap, next),
        );
      }
    });

    // Commands that only exist on Windows mean that `&` is meant for cmd.exe, e.g. in
    // `rd /s /q dist & npm run build`
    const isForWindows = this.#reporter.issues
      .slice(firstIssue)
      .some(
        ({platforms}) =>
          platforms.length === POSIX_PLATFORMS.length &&
          POSIX_PLATFORMS.every((platform) => platforms.includes(platform)),
      );
    if (!isForWindows) {
      backgroundOperators.forEach((range) => {
        this.#reporter.reportSyntax(context, range, 'posix', true, 'inconsistentBehavior', {
          reason: 'cmd.exe runs the commands sequentially instead of in the background',
          suggestion: 'Use `concurrently` instead.',
          syntax: 'The `&` operator',
        });
      });
    }
  }

  #walkTestExpression(expression: TestExpression, context: Context) {
    switch (expression.type) {
      case 'TestBinary': {
        this.#words.checkWord(expression.left, context, {skipGlobs: true});
        this.#words.checkWord(expression.right, context, {skipGlobs: true});
        break;
      }
      case 'TestGroup': {
        this.#walkTestExpression(expression.expression, context);
        break;
      }
      case 'TestLogical': {
        expression.operands.forEach((operand) => {
          this.#walkTestExpression(operand, context);
        });
        break;
      }
      case 'TestNot': {
        this.#walkTestExpression(expression.operand, context);
        break;
      }
      case 'TestUnary': {
        this.#words.checkWord(expression.operand, context, {skipGlobs: true});
        break;
      }
      // No default
    }
  }
}

/**
 * Analyzes a package.json script for constructs that don't work (the same) on all platforms.
 * @param script The script's source
 * @param options Analysis options
 * @returns The issues found, with offsets relative to the script
 */
export const analyzeScript = (script: string, options: AnalyzeScriptOptions = {}) => {
  if (COMMENT_LINE.test(script)) {
    return [];
  }

  const analyzer = new ScriptAnalyzer(script.length, options);

  analyzer.analyzeSource({
    convertsSlashes: options.yarnClassic || false,
    covered: new Set(),
    crossEnv: false,
    fixExclusions: [],
    fixedRange: undefined,
    offset: 0,
    portable: options.portableShell || false,
    shell: 'native',
    source: script,
  });

  return analyzer.issues;
};
