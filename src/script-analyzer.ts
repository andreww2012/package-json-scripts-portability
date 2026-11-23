// cspell:ignore wordlist
import {
  type AndOr,
  type BraceGroup,
  type Command,
  type CompoundList,
  type DoubleQuotedChild,
  type ParsedScript,
  type Pipeline,
  type PipelineNode,
  type Script,
  type Statement,
  type Subshell,
  type TestExpression,
  type Word,
  type WordPart,
  parse,
} from 'unbash';
import type {AnalyzeScriptOptions} from './analyze-script.ts';
import {
  CommandChecker,
  type CommandOptions,
  MAX_DEPTH,
  type NestedWordsOptions,
} from './command-checker.ts';
import {SHELLS, SHELL_STATE_COMMANDS} from './commands.ts';
import {
  type Context,
  type Range,
  type SyntaxKind,
  bashLabel,
  originalText,
  rangeInScript,
  withCovered,
} from './context.ts';
import {joinLinesFix, lineBreakFix, removal, semicolonFix} from './fixes.ts';
import {LineBreakChecker} from './line-break-checker.ts';
import {
  BASH_4_SUGGESTION,
  BASH_SUGGESTION,
  NODE_SCRIPT_SUGGESTION,
  describeReplacement,
  truncate,
} from './messages.ts';
import {PLATFORMS, POSIX_PLATFORMS, type Platform, WINDOWS_PLATFORMS} from './platforms.ts';
import {RedirectionChecker, doesRedirectOutput} from './redirection-checker.ts';
import {Reporter, type RunnerIssue} from './reporter.ts';
import {type Runner, TraitsReader, runnerTraits} from './runners.ts';
import {
  arrayIsSubset,
  mapGetOrInsert,
  mapGetOrInsertComputed,
  sortedArrayInsertionIndex,
  substringBefore,
} from './utils.ts';
import {CMD_STATEMENTS, WordChecker} from './word-checker.ts';
import {DOUBLE_QUOTED_SPECIAL_CHARACTERS, PLACEHOLDER, WHITESPACE, staticValue} from './words.ts';

/** `#` comments after a word boundary, which end at the line feed, not at a carriage return */
const COMMENTS = /(?:^|[\s&;|])(#[^\n]*)/g;
/** Globs of script names that `concurrently` expands, e.g. `npm run watch:*(!css)` */
const SCRIPT_GLOBS = /((?:bun|npm|pnpm|yarn) run|node --run|deno task) (\S*\*\S*)/g;
/** `shopt -s globstar`, which makes `**` recursive in the following commands */
const SHOPT_GLOBSTAR = /\bshopt\s+-s\s+(?:\w+\s+)*globstar\b/;
/** The rest of a script that only closes subshells */ // cspell:disable-line
const CLOSING_PARENTHESES = /^[\s)]*$/;
const ONE_LINE_SUGGESTION = 'Put the commands on one line instead.';
const WINDOWS_BATCH_SYNTAX =
  /\bif\s+(?:\/i\s+)?(?:not\s+)?(?:defined|errorlevel|exist)\b|\bfor\s+(?:\/[a-z]\s+)*%%?[a-z]\b/gi;
const SINGLE_QUOTE = /'/;
const ANY_CHARACTER = /[\s\S]/;
const NO_PLATFORMS: ReadonlySet<Platform> = new Set();

const doesChangeDirectory = (node: AndOr | PipelineNode) => {
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
 * @param shouldKeepExpansions Whether to keep the expansions' text instead, e.g. for reports
 * @returns The text
 */
const nestedSource = (
  parts: readonly (DoubleQuotedChild | WordPart)[],
  shouldKeepExpansions = false,
): string =>
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
          return nestedSource(part.parts, shouldKeepExpansions);
        }
        default: {
          return shouldKeepExpansions ? part.text : PLACEHOLDER.repeat(part.text.length);
        }
      }
    })
    .join('');

/**
 * Gets the original text of a script nested in a piece with placeholders, when it has a source of
 * its own, e.g. in backticks, which is the piece's text without some backslashes.
 * @param source The nested script's source
 * @param text The piece's text, with placeholders
 * @param original The piece's original text
 * @returns The nested script's source with the original text instead of placeholders
 */
const originalNestedSource = (source: string, text: string, original: string) => {
  let result = '';
  let index = 0;

  // The source is the text without some characters, so each of its characters is the next one
  // in the text that is the same
  for (let textIndex = 0; textIndex < text.length && index < source.length; textIndex++) {
    if (text[textIndex] !== source[index]) {
      continue;
    }
    result += original[textIndex];
    index++;
  }

  return result + source.slice(index);
};

/** Gets what identifies the message of an issue, e.g. to find the same issue elsewhere */
const issueDataKey = (issue: RunnerIssue) => JSON.stringify([issue.messageId, issue.data]);

/**
 * Looks for a run of `||` alternatives that each break on some platform, but together work on all
 * platforms, e.g. `open x || xdg-open x || start x`.
 * @param node The list that the alternatives are in
 * @param platformsOf Gets the platforms on which a command of the list fails
 * @param first Index of the run's first command
 * @returns Index of the last command that was looked at, and whether the commands up to it are
 * such a run
 */
const findFallbackEnd = (
  node: AndOr,
  platformsOf: (index: number) => ReadonlySet<Platform>,
  first: number,
) => {
  let unsupported = platformsOf(first);
  let last = first;

  while (unsupported.size > 0 && last + 1 < node.commands.length && node.operators[last] === '||') {
    last++;
    const platforms = platformsOf(last);
    // The alternative isn't platform-specific, e.g. `rm -rf dist || echo failed`
    if (platforms.size === 0) {
      break;
    }

    unsupported = unsupported.intersection(platforms);
    if (unsupported.size === 0) {
      return {isFallback: true, last};
    }
  }

  return {isFallback: false, last};
};

class ScriptAnalyzer {
  readonly #commands: CommandChecker;
  /** How many scripts the analyzed source is nested in, e.g. 1 in `sh -c "..."` */
  #depth = 0;
  readonly #lineBreaks: LineBreakChecker;
  /** Words analyzed as nested scripts, e.g. in `sh -c "..."`, whose text that analysis checks */
  #nestedScriptWords: WeakSet<Word> | undefined;

  /**
   * Issues of the scripts joined from several words of the command being walked, e.g. in
   * `cross-env-shell ls ~/x`, which are reported on all of the words
   */
  #joinedScriptIssues: RunnerIssue[] | undefined;
  /** Parsed sources of the script and of the scripts nested in it, e.g. in `sh -c "..."` */
  readonly #parsedScripts: Map<string, ParsedScript>;
  readonly #redirections: RedirectionChecker;
  readonly #reporter: Reporter;
  readonly #words: WordChecker;

  constructor(
    length: number,
    commandOptions: CommandOptions,
    traits: TraitsReader,
    parsedScripts: Map<string, ParsedScript>,
  ) {
    this.#parsedScripts = parsedScripts;
    this.#reporter = new Reporter(length);
    this.#words = new WordChecker(
      this.#reporter,
      (script, part, context) => {
        this.#walkNestedScript(script, part, context);
      },
      traits,
    );
    this.#lineBreaks = new LineBreakChecker(this.#reporter);
    this.#redirections = new RedirectionChecker(this.#reporter, this.#words);
    this.#commands = new CommandChecker(
      this.#reporter,
      commandOptions,
      (words, context, nested) => {
        this.#analyzeNestedWords(words, context, nested);
      },
      traits,
    );
  }

  get issues() {
    return this.#reporter.uniqueIssues;
  }

  /**
   * Analyzes a script or a piece of it that is a script of its own, e.g. in `sh -c "..."`.
   * @param context The piece
   * @returns Whether it was parsed and analyzed, unlike one that isn't a valid POSIX script
   */
  analyzeSource(context: Context) {
    const script = mapGetOrInsertComputed(this.#parsedScripts, context.source, parse);

    if (script.errors?.length) {
      // The script is probably not meant for a POSIX shell, so only look for cmd.exe syntax
      this.#checkWindowsBatchSyntax(context);
      return false;
    }

    this.#commands.addPositionalFixes(script.commands, context.source);

    const doesEnableGlobstar = context.shell === 'bash' && SHOPT_GLOBSTAR.test(context.source);
    const scriptContext = doesEnableGlobstar
      ? {...context, bashOptions: new Set([...(context.bashOptions || []), 'globstar'])}
      : context;

    this.#walkStatements(
      script.commands,
      {end: context.source.length, pos: 0},
      scriptContext,
      'script',
    );
    return true;
  }

  #analyzeNestedWords(
    words: readonly Word[],
    context: Context,
    {bashOptions, crossEnv, maskScriptGlobs = false, shell}: NestedWordsOptions,
  ) {
    // Real scripts aren't nested deeper, and analyzing such nesting is slow and can overflow the
    // stack
    if (this.#depth >= MAX_DEPTH) {
      return;
    }

    const sources = words.map((word) => {
      const source = word.parts ? nestedSource(word.parts) : word.value;
      return maskScriptGlobs
        ? source.replaceAll(
            SCRIPT_GLOBS,
            (_, command: string, glob: string) => `${command} ${PLACEHOLDER.repeat(glob.length)}`,
          )
        : source;
    });
    const source = sources.join(' ');
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
      // With escapes, quotes or joined words, positions in the nested script can't be mapped to
      // the analyzed script
      fixedRange ||= rangeInScript(context, {
        end: words.at(-1)?.end || word.end,
        pos: word.pos,
      });
    }

    const firstIssue = this.#reporter.issues.length;
    this.#depth++;
    const isAnalyzed = this.analyzeSource({
      bashOptions,
      covered: context.covered,
      crossEnv,
      fixExclusions: [...context.fixExclusions, exclusion],
      fixedRange,
      offset,
      originalSource: source.includes(PLACEHOLDER)
        ? words
            .map((nested) => (nested.parts ? nestedSource(nested.parts, true) : nested.value))
            .join(' ')
        : source,
      portable: false,
      runnerScript: false,
      shell,
      source,
    });
    this.#depth--;

    // Joined words are reported as a whole, so each of them is still checked, e.g. for its exact
    // position and fixes
    if (isAnalyzed && words.length === 1) {
      (this.#nestedScriptWords ||= new WeakSet()).add(word);
    } else if (words.length > 1 && this.#reporter.issues.length > firstIssue) {
      (this.#joinedScriptIssues ||= []).push(...this.#reporter.issues.slice(firstIssue));
    }
  }

  /**
   * Sets the issues collected for the command being walked.
   * @param issues The issues to collect into from now on
   * @returns The issues collected so far
   */
  #swapJoinedScriptIssues(issues: RunnerIssue[] | undefined) {
    const collected = this.#joinedScriptIssues;
    this.#joinedScriptIssues = issues;
    return collected;
  }

  /**
   * Removes the platforms of the issues of a script joined from several words on which a word
   * itself has the same issue, which is reported at its exact position, e.g. `~/x` in
   * `cross-env-shell ls ~/x`.
   * @param joinedIssues Issues of the joined script
   * @param wordIssues Issues of the words, among others
   * @param start Index of the first issue that may be updated
   */
  #dropJoinedDuplicates(
    joinedIssues: readonly RunnerIssue[],
    wordIssues: readonly RunnerIssue[],
    start: number,
  ) {
    const wordIssuesByKey = new Map<string, RunnerIssue[]>();
    wordIssues.forEach((issue) => {
      mapGetOrInsert(wordIssuesByKey, issueDataKey(issue), []).push(issue);
    });

    // Issues of the same script share their range, so each kind of them is matched once
    const platformsByKey = new Map<string, ReadonlySet<Platform>>();
    const removedPlatforms = new Map<RunnerIssue, ReadonlySet<Platform>>();
    joinedIssues.forEach((joined) => {
      const key = issueDataKey(joined);
      const platforms = mapGetOrInsertComputed(
        platformsByKey,
        `${key} ${joined.pos} ${joined.end}`,
        () =>
          new Set(
            (wordIssuesByKey.get(key) || [])
              .filter((issue) => joined.pos <= issue.pos && issue.end <= joined.end)
              .flatMap((issue) => issue.platforms),
          ),
      );
      if (platforms.size > 0) {
        removedPlatforms.set(joined, platforms);
      }
    });

    if (removedPlatforms.size > 0) {
      this.#reporter.removePlatforms(start, (issue) => removedPlatforms.get(issue));
    }
  }

  /**
   * Reports the comments in text between statements, which `unbash` skips.
   * @param gap The text
   * @param position Where the text starts in the source
   * @param context Where the text is
   * @returns Where the first comment starts in the text, or -1 if there is none
   */
  #checkComments(gap: string, position: number, context: Context) {
    // Most gaps have no comments, and `matchAll` is much slower than this check
    if (!gap.includes('#')) {
      return -1;
    }

    let first = -1;
    gap.matchAll(COMMENTS).forEach((match) => {
      const [text, comment = ''] = match;
      const start = match.index + text.length - comment.length;
      const commentEnd = position + start + comment.length;
      if (first === -1) {
        first = start;
      }

      this.#reporter.reportSyntax(
        context,
        {end: commentEnd, pos: position + start},
        'posix',
        false,
        'unsupportedSyntax',
        {suggestion: 'Remove it instead.', syntax: 'The `#` comment'},
        {
          description: 'Remove the comment.',
          edits: [removal(context.source, position + start, commentEnd)],
        },
      );
    });
    return first;
  }

  /**
   * Gets where the text after a statement starts, after the bodies of its here-documents.
   * @param statement A statement of the source
   * @param nextStart Where the next statement starts, or where the source ends
   * @param source The source that the statement is in
   * @returns The offset in the source
   */
  #statementEnd(statement: Statement, nextStart: number, source: string) {
    const hereDocumentEnds = this.#redirections.hereDocumentEnds.get(source);
    if (!hereDocumentEnds) {
      return statement.end;
    }

    // How many here-documents end before the next statement: the last of them ends the latest
    const count = sortedArrayInsertionIndex(hereDocumentEnds, nextStart, {rightmost: true});
    return Math.max(statement.end, hereDocumentEnds[count - 1] || 0);
  }

  /**
   * Reports cmd.exe syntax, e.g. `if exist`.
   * @param context Where to look for it
   * @param pos Where to start looking in the source
   * @param end Where to stop looking in the source
   * @returns Whether it was found
   */
  #checkWindowsBatchSyntax(context: Context, pos = 0, end = context.source.length) {
    const firstIssue = this.#reporter.issues.length;
    const matches = [...context.source.slice(pos, end).matchAll(WINDOWS_BATCH_SYNTAX)];

    matches.forEach((match) => {
      const start = pos + match.index;
      this.#reporter.report(
        context,
        {end: start + match[0].length, pos: start},
        'unsupportedSyntax',
        {
          suggestion: NODE_SCRIPT_SUGGESTION,
          syntax: `The Windows batch syntax \`${truncate(match[0])}\``,
        },
        context.portable ? PLATFORMS : POSIX_PLATFORMS,
      );
    });
    // POSIX shells fail to run it, e.g. in `rm -rf dist || IF EXIST dist rd /s /q dist`
    this.#reporter.markFailures(firstIssue);

    return matches.length > 0;
  }

  /**
   * Drops the issues of alternatives for different platforms, e.g. `rm -rf a || rmdir /s /q a`.
   * @param node The list of commands joined by `||` (and other operators)
   * @param starts Index of the first issue of each command in the list, and of the end of its
   * issues
   */
  #dropPlatformFallbacks(node: AndOr, starts: readonly number[]) {
    if (!node.operators.includes('||')) {
      return;
    }

    const issuesOf = (index: number) =>
      this.#reporter.issues.slice(starts[index], starts[index + 1]);
    // Where each alternative fails, e.g. as its command isn't available, unlike where only its
    // arguments have issues, like `$OUT` in `tsc --outDir $OUT || rd /s /q out`
    const failingPlatforms = node.commands.map(
      (_, index) =>
        new Set(
          issuesOf(index)
            .filter((issue) => this.#reporter.isFailure(issue))
            .flatMap((issue) => issue.platforms),
        ),
    );
    const platformsOf = (index: number) => failingPlatforms[index] || NO_PLATFORMS;
    const runs: [first: number, last: number][] = [];

    let first = 0;
    while (first < node.commands.length) {
      const {isFallback, last} = findFallbackEnd(node, platformsOf, first);
      if (isFallback) {
        runs.push([first, last]);
      }
      // Later alternatives are still reported, e.g. `true` in `rm ... || rmdir /s ... || true`.
      // And where no run starts at a command, none starts at the ones that were looked at after
      // it: they fail on the same platforms or more, and end at the same command
      first = last + 1;
    }

    // Where an alternative fails, the next one runs, but its issues still apply elsewhere, e.g.
    // `**/` in `rm -rf **/x || rd /s /q x` on macOS and Linux
    const removedPlatforms = new Map<RunnerIssue, ReadonlySet<Platform>>();
    runs.forEach(([runStart, runEnd]) => {
      for (let index = runStart; index <= runEnd; index++) {
        const platforms = platformsOf(index);
        issuesOf(index).forEach((issue) => {
          removedPlatforms.set(issue, platforms);
        });
      }
    });

    const [start] = starts;
    if (start != null && removedPlatforms.size > 0) {
      this.#reporter.removePlatforms(start, (issue) => removedPlatforms.get(issue));
    }
  }

  /**
   * Walks a command and the commands in it.
   * @param node The command
   * @param context Where the command is
   * @param commandEnd Where the command ends along with its redirections, e.g. `> log` after
   * `( ... )`
   */
  #walkCommand(node: AndOr | PipelineNode, context: Context, commandEnd = node.end) {
    switch (node.type) {
      case 'AndOr': {
        const starts: number[] = [];
        node.commands.forEach((command) => {
          starts.push(this.#reporter.issues.length);
          this.#walkCommand(command, context);
        });
        starts.push(this.#reporter.issues.length);
        this.#dropPlatformFallbacks(node, starts);
        this.#lineBreaks.checkOperatorLineBreaks(node.commands, context);
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
        this.#walkGroup(node, withCovered(context, covered));
        break;
      }

      case 'Case': {
        const nestedContext = this.#reportStatement(context, node, 'case', 'posix');
        // The word and the patterns aren't expanded like arguments, and a pattern like `*.js` isn't
        // a file glob
        this.#words.checkWord(node.word, nestedContext, {skipGlobs: true});
        node.items.forEach(({body, end, pattern, terminator}) => {
          pattern.forEach((word) => {
            this.#words.checkWord(word, nestedContext, {skipGlobs: true});
          });
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
        // e.g. `function a { ... }`, but not `function_a() { ... }`
        const hasFunctionKeyword = node.name.pos > node.pos;
        const covered = this.#reporter.reportSyntax(
          context,
          {end: node.name.end, pos: node.pos},
          hasFunctionKeyword ? 'bash' : 'posix',
          false,
          'unsupportedSyntax',
          hasFunctionKeyword
            ? {
                suggestion: 'Use `name() { ... }` or a Node.js script instead.',
                syntax: 'The Bash-specific `function` keyword',
              }
            : {
                suggestion: NODE_SCRIPT_SUGGESTION,
                syntax: `The shell function definition \`${originalText(context, node.name)}()\``,
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
        const redirectedContext = node.redirects.some(doesRedirectOutput)
          ? {...context, outputRedirected: true}
          : context;
        this.#walkCommand(node.command, redirectedContext, commandEnd);
        node.redirects.forEach((redirection) => {
          this.#redirections.checkRedirection(redirection, redirectedContext);
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
          !CLOSING_PARENTHESES.test(context.source.slice(commandEnd))
        ) {
          this.#reporter.reportSyntax(context, node, 'posix', true, 'inconsistentBehavior', {
            reason:
              'cmd.exe only groups the commands, so `cd` also changes the directory of the commands that follow',
            suggestion: 'Use `npm --prefix <directory>` or workspaces instead.',
            syntax: 'The subshell `( ... )`',
          });
        }
        this.#walkGroup(node, context);
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
    this.#walkStatements(list.commands, list, context);
  }

  /**
   * Walks the commands of a group, i.e. `( ... )` or `{ ... }`.
   * @param node The group
   * @param context Where the group is
   */
  #walkGroup(node: BraceGroup | Subshell, context: Context) {
    this.#walkStatements(
      node.body.commands,
      // Between the parentheses or braces
      {end: Math.max(node.body.end, node.end - 1), pos: node.pos + 1},
      context,
      'group',
    );
  }

  #walkNestedScript(script: Script, part: Range, context: Context) {
    const nestedContext =
      script.source == null
        ? context
        : {
            ...context,
            fixedRange: rangeInScript(context, part),
            originalSource:
              context.originalSource === context.source
                ? script.source
                : originalNestedSource(
                    script.source,
                    context.source.slice(part.pos, part.end),
                    originalText(context, part),
                  ),
            source: script.source,
          };

    this.#walkStatements(script.commands, script, nestedContext);
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

    const pipedContext = {...context, outputRedirected: true};
    node.commands.forEach((command, index) => {
      this.#walkCommand(command, index < node.commands.length - 1 ? pipedContext : context);
    });
    this.#lineBreaks.checkOperatorLineBreaks(node.commands, context);
  }

  #walkSimpleCommand(node: Command, context: Context) {
    // POSIX shells parse cmd.exe statements with uppercase keywords as commands, e.g. `IF` in
    // `IF EXIST dist rd /s /q dist`, so they're checked like unparsable scripts
    const name = node.name && staticValue(node.name);
    if (
      name != null &&
      CMD_STATEMENTS.has(name.toLowerCase()) &&
      this.#checkWindowsBatchSyntax(context, node.pos, node.end)
    ) {
      return;
    }

    const isRedirection = node.name == null && node.prefix.length + node.suffix.length === 1;
    const isOutputUsed = context.outputRedirected || node.redirects.some(doesRedirectOutput);
    // e.g. for `> /dev/null` in `tsc > out.log > /dev/null`
    const redirectionContext =
      isOutputUsed && !context.outputRedirected ? {...context, outputRedirected: true} : context;

    node.prefix.forEach((item) => {
      if (item.type === 'Assignment') {
        this.#words.checkAssignment(item, context, node.name ? node : undefined);
      } else {
        this.#redirections.checkRedirection(item, redirectionContext, isRedirection);
      }
    });

    // Commands in the scripts that this command runs are walked on their own
    const enclosingJoinedIssues = this.#swapJoinedScriptIssues(undefined);
    const invocationStart = this.#reporter.issues.length;
    const invocation =
      node.name &&
      this.#commands.checkInvocation(
        node.name,
        node.suffix.filter((item) => item.type === 'Word'),
        context,
        0,
      );
    const joinedIssues = this.#swapJoinedScriptIssues(enclosingJoinedIssues);
    // Shells and `find` have to be replaced on Windows anyway (e.g. with a Node.js script), so how
    // their arguments are quoted doesn't matter there
    const argumentContext =
      invocation?.name != null && (SHELLS.includes(invocation.name) || invocation.name === 'find')
        ? withCovered(context, WINDOWS_PLATFORMS)
        : context;
    const crossEnv = invocation?.crossEnv && {
      ...invocation.crossEnv,
      // The words of the command that it runs, which the shell expands before it sets its variables
      commandContext: {
        ...argumentContext,
        crossEnv: true,
        crossEnvVariables: invocation.crossEnv.variables,
      },
      context: {...argumentContext, crossEnv: true},
    };
    // `cross-env` only gets the words after it, e.g. not `$A` in `npx -p $A cross-env B=1 jest`
    const contextOf = (item: Range) => {
      if (!crossEnv || item.pos < crossEnv.start) {
        return argumentContext;
      }
      return item.pos < crossEnv.commandStart ? crossEnv.context : crossEnv.commandContext;
    };

    if (node.name) {
      this.#words.checkWord(node.name, context, {commandName: true});

      if (isOutputUsed && !context.portable && invocation?.name === 'echo') {
        this.#redirections.checkQuotedEcho(node, context);
      }
    }

    this.#lineBreaks.checkCommandLineBreak(node, argumentContext);

    const isPrintedToTerminal = invocation?.target === 'echo' && !isOutputUsed;
    const wordsStart = this.#reporter.issues.length;

    node.suffix.forEach((item) => {
      if (item.type === 'Assignment') {
        // e.g. `A=1` in `export A=1`
        this.#words.checkDeclaredAssignment(item, contextOf(item));
      } else if (item.type === 'Word') {
        this.#words.checkWord(item, contextOf(item), {
          command: invocation?.target,
          nestedScript: this.#nestedScriptWords?.has(item),
          printedToTerminal: isPrintedToTerminal,
        });
      } else {
        // Redirections are handled by the shell, not the command
        this.#redirections.checkRedirection(item, redirectionContext);
      }
    });

    if (joinedIssues) {
      this.#dropJoinedDuplicates(
        joinedIssues,
        this.#reporter.issues.slice(wordsStart),
        invocationStart,
      );
    }
  }

  #reportStatement(context: Context, node: Range, keyword: string, kind: SyntaxKind) {
    // e.g. `for` in `for (( ... ))`
    const firstWord = substringBefore(keyword, ' ');
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

  /**
   * Walks a list of statements and checks the text around them, e.g. `;` and comments.
   * @param statements The statements
   * @param listRange Where the list is, including the text before the first statement and after
   * the last one, e.g. up to the closing parenthesis of `( ... )`
   * @param context Where the list is
   * @param kind What the list is: a whole script, the body of `( ... )` or `{ ... }` (a group), or
   * another list, e.g. the body of `if`.
   * cmd.exe ignores the rest of the script after a line break, which is only harmless after the
   * last statement of a script
   */
  #walkStatements(
    statements: readonly Statement[],
    listRange: Range,
    context: Context,
    kind: 'group' | 'list' | 'script' = 'list',
  ) {
    const firstIssue = this.#reporter.issues.length;
    const backgroundOperators: Range[] = [];
    const {source} = context;
    const [first] = statements;

    const leadingGap = source.slice(listRange.pos, first?.pos ?? listRange.end);
    const leadingComment = this.#checkComments(leadingGap, listRange.pos, context);
    const leadingLineBreak = leadingGap.indexOf('\n');
    // e.g. in `\ntsc`, where cmd.exe has nothing to run, but not after a comment, which is
    // reported itself
    if (
      first &&
      kind !== 'list' &&
      leadingLineBreak !== -1 &&
      (leadingComment === -1 || leadingComment > leadingLineBreak)
    ) {
      const position = listRange.pos + leadingLineBreak;
      this.#lineBreaks.reportLineBreak(
        context,
        position,
        ONE_LINE_SUGGESTION,
        joinLinesFix(source, position, first.pos),
      );
    }

    statements.forEach((statement, index) => {
      this.#walkCommand(statement.command, context);

      if (statement.background) {
        const position = source.lastIndexOf('&', statement.end - 1);
        backgroundOperators.push({end: position + 1, pos: position});
      }

      const next = statements.at(index + 1);
      const gapEnd = next?.pos || listRange.end;
      const gapStart = this.#statementEnd(statement, gapEnd, source);
      const gap = source.slice(gapStart, gapEnd);
      // A `;` can't follow a comment, which ends at the end of the line
      const comment = this.#checkComments(gap, gapStart, context);
      const semicolon = gap.slice(0, comment === -1 ? undefined : comment).indexOf(';');

      if (semicolon !== -1) {
        const range = {end: gapStart + semicolon + 1, pos: gapStart + semicolon};
        const platforms = this.#reporter.reportSyntax(
          context,
          range,
          'posix',
          true,
          'unsupportedSyntax',
          {suggestion: 'Use `&&` instead.', syntax: 'The `;` command separator'},
          semicolonFix(range, gap, next),
        );
        // Where `;` is supported, a line break after it may still not be, e.g. in Yarn's shell
        if (platforms.length > 0) {
          return;
        }
      }

      // e.g. before the closing parenthesis of `( ... )`
      if ((next || kind === 'group') && gap.includes('\n')) {
        this.#lineBreaks.reportLineBreak(
          context,
          gapStart + gap.indexOf('\n'),
          next && !statement.background
            ? 'Join the commands with `&&` instead.'
            : ONE_LINE_SUGGESTION,
          semicolon === -1 && next ? lineBreakFix(gapStart, gap, statement, next) : undefined,
        );
      }
    });

    if (backgroundOperators.length === 0) {
      return;
    }

    // Commands that only exist on Windows mean that `&` is meant for cmd.exe, e.g. in
    // `rd /s /q dist & npm run build`
    const isForWindows = this.#reporter.issues
      .slice(firstIssue)
      .some(
        ({platforms}) =>
          platforms.length === POSIX_PLATFORMS.length && arrayIsSubset(platforms, POSIX_PLATFORMS),
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
 * Analyzes a script as each of the runners runs it.
 * @param script The script's source
 * @param options Analysis options
 * @param runners What runs the script
 * @returns The issues found with each runner, by their keys
 */
export const analyzeWithRunners = (
  script: string,
  options: AnalyzeScriptOptions,
  runners: readonly Runner[],
) => {
  // Parsing doesn't depend on the runner, so each source is parsed once for all of them
  const parsedScripts = new Map<string, ParsedScript>();
  const commandOptions: CommandOptions = {
    dependencies: options.dependencies || [],
    ignoredCommands: new Set(options.ignoreCommands),
  };
  const analyses: {issues: ReadonlyMap<string, RunnerIssue>; traits: TraitsReader}[] = [];

  return new Map(
    runners.map((runner) => {
      const traits = runnerTraits(runner, options.shellEmulator || false);
      // Runners that only differ in traits that an analysis didn't read have the same issues, e.g.
      // npm and pnpm for a script without `$HOME`
      const reused = analyses.find((analysis) => analysis.traits.matches(traits));
      if (reused) {
        return [runner, reused.issues];
      }

      const reader = new TraitsReader(traits);
      const analyzer = new ScriptAnalyzer(script.length, commandOptions, reader, parsedScripts);
      analyzer.analyzeSource({
        covered: new Set(),
        crossEnv: false,
        fixExclusions: [],
        fixedRange: undefined,
        offset: 0,
        originalSource: script,
        portable: reader.get('portableShell') || false,
        runnerScript: true,
        shell: 'native',
        source: script,
      });

      const {issues} = analyzer;
      analyses.push({issues, traits: reader});
      return [runner, issues];
    }),
  );
};
