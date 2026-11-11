import type {Command} from 'unbash';
import {type Context, type Range, rangeInScript} from './context.ts';
import {joinLinesFix} from './fixes.ts';
import type {Reporter, ScriptFix} from './reporter.ts';

const ONE_LINE_SUGGESTION = 'Put the command on one line instead.';

/** Checks line breaks, after which cmd.exe ignores the rest of the script */
export class LineBreakChecker {
  /** Ranges of reported line breaks in the analyzed script, e.g. to skip them in nested scripts */
  readonly #lineBreaks: Range[] = [];
  readonly #multilineSources = new Set<string>();
  readonly #reporter: Reporter;

  constructor(reporter: Reporter) {
    this.#reporter = reporter;
  }

  /**
   * Reports a line break in a command, e.g. after a `\` line continuation or in a quoted string.
   * @param node The command
   * @param context Where the command is
   */
  checkCommandLineBreak(node: Command, context: Context) {
    const newline = context.source.slice(node.pos, node.end).indexOf('\n');
    if (newline === -1) {
      return;
    }

    const position = node.pos + newline;
    // A line break in a word, e.g. in quotes, is part of its value in POSIX shells
    const isInWord = [node.name, ...node.prefix, ...node.suffix].some(
      (item) => item && item.pos <= position && position < item.end,
    );
    // Yarn's shell keeps a `\` line continuation as a line break, but supports one in quotes
    const isQuoted = isInWord && context.source[position - 1] !== '\\';

    this.reportLineBreak(
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
  checkOperatorLineBreaks(commands: readonly Range[], context: Context) {
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
        this.reportLineBreak(
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
  reportLineBreak(
    context: Context,
    position: number,
    suggestion: string,
    fix?: ScriptFix,
    isPortableSupported = false,
  ) {
    const lineBreak = {end: position + 1, pos: position};
    const range = rangeInScript(context, lineBreak);
    // e.g. in `concurrently "a` + line break + `b"`, which is reported for the outer script already
    const isReported = this.#lineBreaks.some(
      (reported) => reported.pos < range.end && range.pos < reported.end,
    );

    if (isReported || this.#multilineSources.has(context.source)) {
      return;
    }

    const platforms = this.#reporter.reportSyntax(
      context,
      lineBreak,
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
}
