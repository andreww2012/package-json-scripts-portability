import {mapGetOrInsert} from '@andreww2012/unutils';
import type {Command, Redirection} from 'unbash';
import {type Context, bashLabel} from './context.ts';
import {removal, replacement} from './fixes.ts';
import {
  BASH_SUGGESTION,
  NODE_SCRIPT_SUGGESTION,
  describeReplacement,
  truncate,
} from './messages.ts';
import {POSIX_PLATFORMS} from './platforms.ts';
import type {Reporter, ScriptFix} from './reporter.ts';
import type {WordChecker} from './word-checker.ts';
import {POSIX_PATH, WHITESPACE, staticValue} from './words.ts';

/** The target of a redirection that duplicates or closes a file descriptor, e.g. `1` or `-` */
const DESCRIPTOR = /^(?:\d+|-)$/;
/** Device names, which cmd.exe treats as the device in any directory */
const WINDOWS_DEVICES: ReadonlySet<string> = new Set(['aux', 'con', 'nul', 'prn']);

/** Checks redirections, e.g. for Bash-specific operators and device files */
export class RedirectionChecker {
  /** End offsets of here-documents, by the source that they're in */
  readonly hereDocumentEnds = new Map<string, number[]>();
  readonly #reporter: Reporter;
  readonly #words: WordChecker;

  constructor(reporter: Reporter, words: WordChecker) {
    this.#reporter = reporter;
    this.#words = words;
  }

  checkEchoToFile(node: Command, context: Context) {
    const isWritesFile = node.redirects.some(
      (redirect) =>
        redirect.type === 'Redirect' &&
        (redirect.operator === '>' || redirect.operator === '>>') &&
        redirect.descriptor == null &&
        !POSIX_PATH.test(redirect.target?.value || '') &&
        !WINDOWS_DEVICES.has(redirect.target?.value.toLowerCase() || ''),
    );
    const quoted = node.args.find(
      (argument) =>
        argument.type === 'Word' && argument.parts?.some((part) => part.type === 'DoubleQuoted'),
    );

    if (isWritesFile && quoted) {
      this.#reporter.reportSyntax(context, quoted, 'posix', true, 'inconsistentBehavior', {
        reason: "cmd.exe's `echo` writes the quotes into the file",
        suggestion: NODE_SCRIPT_SUGGESTION,
        syntax: 'Writing a double-quoted string with `echo`',
      });
    }
  }

  /**
   * Checks a redirection and its target.
   * @param redirection Redirection to check, e.g. `> out.log`
   * @param context Where the redirection is
   * @param isWholeCommand Whether it's all that its command consists of, e.g. in `tsc | >log`
   */
  checkRedirection(redirection: Redirection, context: Context, isWholeCommand = false) {
    const text = context.source.slice(redirection.pos, redirection.end);

    switch (redirection.type) {
      case 'HereDoc': {
        this.#reporter.reportSyntax(context, redirection, 'posix', false, 'unsupportedSyntax', {
          suggestion: NODE_SCRIPT_SUGGESTION,
          syntax: `The here-document \`${redirection.operator}\``,
        });
        if (redirection.closing) {
          mapGetOrInsert(this.hereDocumentEnds, context.source, []).push(redirection.closing.end);
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

        // e.g. in `a 2&>log`, where `2` would otherwise become the descriptor of `2>&1`
        const separator =
          redirection.pos > 0 && !WHITESPACE.test(context.source.charAt(redirection.pos - 1))
            ? ' '
            : '';
        const redirectionFix = (fixed: string): ScriptFix => ({
          description: describeReplacement(text, fixed),
          edits: [{end: redirection.end, pos: redirection.pos, text: `${separator}${fixed}`}],
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
            redirection.target &&
              redirectionFix(`${operator.slice(1)} ${redirection.target.text} 2>&1`),
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
              descriptor ? undefined : redirectionFix(`> ${redirection.target.text} 2>&1`),
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

    if (target != null && WINDOWS_DEVICES.has(target.toLowerCase())) {
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

    this.#words.checkWord(redirection.target, context, {redirectTarget: true});

    // Yarn's shell supports `/dev/null` on all platforms
    if (target == null || (target === '/dev/null' && context.portable)) {
      return;
    }

    // Without the redirection, the output appears in the terminal instead
    const isDiscardsOutput =
      !isWholeCommand &&
      redirection.type === 'Redirect' &&
      (redirection.operator === '>' || redirection.operator === '>>') &&
      target === '/dev/null';

    this.#words.checkPosixPath(
      redirection.target,
      target,
      context,
      isDiscardsOutput
        ? {
            description: `Remove \`${truncate(text)}\`.`,
            edits: [removal(context.source, redirection.pos, redirection.end)],
          }
        : undefined,
    );
  }
}
