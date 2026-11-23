import type {Command, RedirectOperator, Redirection, Word} from 'unbash';
import {type Context, bashLabel, originalText} from './context.ts';
import {removal, replacement} from './fixes.ts';
import {
  BASH_SUGGESTION,
  NODE_SCRIPT_SUGGESTION,
  describeReplacement,
  truncate,
} from './messages.ts';
import {POSIX_PLATFORMS} from './platforms.ts';
import type {Reporter, ScriptFix} from './reporter.ts';
import {mapGetOrInsert, setHas, sortedArrayInsertionIndex} from './utils.ts';
import type {WordChecker} from './word-checker.ts';
import {POSIX_PATH, WHITESPACE, staticValue} from './words.ts';

/** The target of a redirection that duplicates or closes a file descriptor, e.g. `1` or `-` */
const DESCRIPTOR = /^(?:\d+|-)$/;
/** Device names, which cmd.exe treats as the device in any directory */
const WINDOWS_DEVICES: ReadonlySet<string> = new Set(['aux', 'con', 'nul', 'prn']);
/** Redirection operators that write the standard output to a file, e.g. `>` */
const OUTPUT_OPERATORS: ReadonlySet<RedirectOperator> = new Set([
  '&>',
  '&>>',
  '>',
  '>&',
  '>>',
  '>|',
]);

/**
 * Checks whether a redirection writes the standard output to a file, e.g. `> out.log`, but not
 * `>&2`, `2> err.log` or `> /dev/null`.
 * @param redirection The redirection
 * @returns Whether it does
 */
export const doesRedirectOutput = (redirection: Redirection) => {
  if (redirection.type !== 'Redirect' || !OUTPUT_OPERATORS.has(redirection.operator)) {
    return false;
  }

  const {descriptor, operator, target} = redirection;
  const value = target && staticValue(target);
  return (
    (descriptor == null || (descriptor.type === 'FileDescriptor' && descriptor.value === 1)) &&
    // e.g. `>&2`, which duplicates a file descriptor instead
    !(operator === '>&' && value != null && DESCRIPTOR.test(value)) &&
    // Devices don't keep the output, e.g. `/dev/null`
    !POSIX_PATH.test(value || '') &&
    !setHas(WINDOWS_DEVICES, value?.toLowerCase())
  );
};

/** Checks redirections, e.g. for Bash-specific operators and device files */
export class RedirectionChecker {
  /** End offsets of here-documents in ascending order, by the source that they're in */
  readonly hereDocumentEnds = new Map<string, number[]>();
  readonly #reporter: Reporter;
  readonly #words: WordChecker;

  constructor(reporter: Reporter, words: WordChecker) {
    this.#reporter = reporter;
    this.#words = words;
  }

  /**
   * Reports a double-quoted string that `echo` writes to a file or a pipe.
   * @param node The `echo` command, whose output doesn't go to the terminal
   * @param context Where the command is
   */
  checkQuotedEcho(node: Command, context: Context) {
    const quoted = node.args.find(
      (argument) =>
        argument.type === 'Word' && argument.parts?.some((part) => part.type === 'DoubleQuoted'),
    );

    if (quoted) {
      this.#reporter.reportSyntax(context, quoted, 'posix', true, 'inconsistentBehavior', {
        reason: "cmd.exe's `echo` writes the quotes too",
        suggestion: NODE_SCRIPT_SUGGESTION,
        syntax: 'Writing a double-quoted string with `echo`',
      });
    }
  }

  /**
   * Checks a redirection and its target.
   * @param redirection Redirection to check, e.g. `> out.log`
   * @param context Where the redirection is
   * @param isWholeCommand Whether the redirection is the whole command, e.g. `>log` in `tsc | >log`
   */
  checkRedirection(redirection: Redirection, context: Context, isWholeCommand = false) {
    const text = originalText(context, redirection);

    switch (redirection.type) {
      case 'HereDoc': {
        this.#reporter.reportSyntax(context, redirection, 'posix', false, 'unsupportedSyntax', {
          suggestion: NODE_SCRIPT_SUGGESTION,
          syntax: `The here-document \`${redirection.operator}\``,
        });
        if (redirection.closing) {
          const ends = mapGetOrInsert(this.hereDocumentEnds, context.source, []);
          const {end} = redirection.closing;
          ends.splice(sortedArrayInsertionIndex(ends, end, {rightmost: true}), 0, end);
        }
        return;
      }

      case 'HereString': {
        this.#reporter.reportSyntax(context, redirection, 'bash', true, 'unsupportedSyntax', {
          suggestion: 'Pipe the value into the command instead.',
          syntax: 'The Bash-specific here-string `<<<`',
        });
        break;
      }

      case 'Redirect': {
        const {descriptor, operator} = redirection;

        if (descriptor?.type === 'FileDescriptorVariable') {
          this.#reporter.reportSyntax(context, descriptor, 'bash', false, 'unsupportedSyntax', {
            suggestion: BASH_SUGGESTION,
            syntax: `The Bash-specific file descriptor variable \`{${descriptor.name}}\``,
          });
        }

        // Keeps the word before it from becoming a descriptor, e.g. `2` in `a 2&>log`
        const separator =
          redirection.pos > 0 && !WHITESPACE.test(context.source.charAt(redirection.pos - 1))
            ? ' '
            : '';
        // Writes both outputs to the target, e.g. `> log 2>&1` for `&> log`. The target isn't
        // copied, as it may have placeholders
        const bothOutputsFix = (target: Word, fixedOperator: string): ScriptFix => ({
          description: describeReplacement(
            text,
            `${fixedOperator} ${originalText(context, target)} 2>&1`,
          ),
          edits: [
            {end: target.pos, pos: redirection.pos, text: `${separator}${fixedOperator} `},
            {end: redirection.end, pos: redirection.end, text: ' 2>&1'},
          ],
        });

        if (operator === '&>' || operator === '&>>') {
          const kind = operator === '&>' ? 'bash' : 'bash4';
          this.#reporter.reportSyntax(
            context,
            redirection,
            kind,
            false,
            'unsupportedSyntax',
            {
              suggestion: `Use \`${operator.slice(1)} file 2>&1\` instead.`,
              syntax: `The ${bashLabel(kind)} \`${operator}\` redirection`,
            },
            redirection.target && bothOutputsFix(redirection.target, operator.slice(1)),
          );
        } else if (operator === '>|' || operator === '<>') {
          const position = context.source.indexOf(operator, descriptor?.end || redirection.pos);
          this.#reporter.reportSyntax(
            context,
            redirection,
            'posix',
            false,
            'unsupportedSyntax',
            {
              suggestion: operator === '>|' ? 'Use `>` instead.' : NODE_SCRIPT_SUGGESTION,
              syntax: `The \`${operator}\` redirection`,
            },
            // `>|` only differs from `>` with the `noclobber` option
            operator === '>|'
              ? replacement({end: position + operator.length, pos: position}, operator, '>')
              : undefined,
          );
        }

        if (redirection.target && (operator === '>&' || operator === '<&')) {
          const target = staticValue(redirection.target);
          if (target != null && DESCRIPTOR.test(target)) {
            return;
          }
          // Bash's shorthand for `> file 2>&1`
          if (operator === '>&' && target != null) {
            this.#reporter.reportSyntax(
              context,
              redirection,
              'bash',
              false,
              'unsupportedSyntax',
              {
                suggestion: `Use \`> ${truncate(target)} 2>&1\` instead.`,
                syntax: 'The Bash-specific `>&` redirection to a file',
              },
              descriptor ? undefined : bothOutputsFix(redirection.target, '>'),
            );
          }
        }
        break;
      }
      // No default
    }

    if (!redirection.target) {
      return;
    }

    const target = staticValue(redirection.target);
    // A here-string is text rather than a file
    const isHereString = redirection.type === 'HereString';

    if (target != null && !isHereString && WINDOWS_DEVICES.has(target.toLowerCase())) {
      this.#reporter.report(
        context,
        redirection.target,
        'inconsistentBehavior',
        {
          reason: `POSIX shells create a file named \`${target}\` instead`,
          suggestion: 'Remove the redirection or use a Node.js script instead.',
          syntax: `The redirection to \`${target}\``,
        },
        POSIX_PLATFORMS,
      );
    }

    this.#words.checkWord(redirection.target, context, {
      redirectTarget: true,
      // Bash doesn't expand braces in a here-string
      skipGlobs: isHereString,
      text: isHereString,
    });

    // Yarn's shell supports `/dev/null` on all platforms
    if (target == null || isHereString || (target === '/dev/null' && context.portable)) {
      return;
    }

    // Without the redirection, the output appears in the terminal instead
    const doesDiscardOutput =
      !isWholeCommand &&
      (redirection.operator === '>' || redirection.operator === '>>') &&
      target === '/dev/null';

    this.#words.checkPosixPath(
      redirection.target,
      target,
      context,
      doesDiscardOutput
        ? {
            description: `Remove \`${truncate(text)}\`.`,
            edits: [removal(context.source, redirection.pos, redirection.end)],
          }
        : undefined,
    );
  }
}
