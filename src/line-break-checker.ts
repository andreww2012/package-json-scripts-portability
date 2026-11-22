import type {Command} from 'unbash';
import {type Context, type Range, rangeInScript} from './context.ts';
import {joinLinesFix} from './fixes.ts';
import type {Reporter, RunnerIssue, ScriptFix} from './reporter.ts';
import {slidingWindow} from './utils.ts';

const ONE_LINE_SUGGESTION = 'Put the command on one line instead.';

interface ReportedLineBreak {
  issue: RunnerIssue;
  /** Range of the line break in the analyzed script */
  range: Range;
  /** The source that the line break is in */
  source: string;
}

/** Checks line breaks, after which cmd.exe ignores the rest of the script */
export class LineBreakChecker {
  /**
   * Reported line breaks, to report one per source and to skip them in nested scripts.
   * Their issues may be dropped later, e.g. in a platform fallback
   */
  readonly #lineBreaks: ReportedLineBreak[] = [];
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
    for (const [command, next] of slidingWindow(commands, 2)) {
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
    const isReported = this.#lineBreaks.some(
      (reported) =>
        // Dropped issues are left without platforms
        reported.issue.platforms.length > 0 &&
        (reported.source === context.source ||
          // e.g. in `concurrently "a` + line break + `b"`, which is reported for the outer script
          (reported.range.pos < range.end && range.pos < reported.range.end)),
    );

    if (isReported) {
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

    // The issue that was just reported
    const issue = this.#reporter.issues.at(-1);
    // A line break in a piece that was reported already doesn't count, e.g. in an `if` statement
    if (issue && platforms.length > 0) {
      this.#lineBreaks.push({issue, range, source: context.source});
    }
  }
}
