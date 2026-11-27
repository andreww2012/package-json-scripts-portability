import type {Command} from 'unbash';
import {type Context, type Range, rangeInScript} from './context.ts';
import {joinLinesFix} from './fixes.ts';
import type {Reporter, RunnerIssue, ScriptFix} from './reporter.ts';
import {slidingWindow, sortedArrayInsertionIndexWith} from './utils.ts';

const ONE_LINE_SUGGESTION = 'Put the command on one line instead.';

interface ReportedLineBreak {
  issue: RunnerIssue;
  /** Range of the line break in the analyzed script */
  range: Range;
}

/** Checks whether an issue was dropped, e.g. in a platform fallback, which leaves no platforms */
const isDropped = (issue: RunnerIssue) => issue.platforms.length === 0;

/** Checks line breaks, after which cmd.exe ignores the rest of the script */
export class LineBreakChecker {
  /**
   * The issue of the last line break reported in each script, by where the script is and its
   * source
   */
  readonly #lastIssues = new Map<string, RunnerIssue>();

  /** Reported line breaks sorted by where they start in the analyzed script */
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
    const scriptKey = `${context.offset} ${context.fixedRange?.pos ?? ''} ${context.source}`;
    const lastIssue = this.#lastIssues.get(scriptKey);
    // Only one is reported per script, e.g. per script of `concurrently` even if they're the same.
    // The ones reported before the last one were dropped, or it wouldn't be reported
    if ((lastIssue && !isDropped(lastIssue)) || this.#isOverlapReported(range)) {
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
    if (!issue || platforms.length === 0) {
      return;
    }

    this.#lastIssues.set(scriptKey, issue);
    this.#lineBreaks.splice(
      sortedArrayInsertionIndexWith(this.#lineBreaks, (reported) => reported.range.pos < range.pos),
      0,
      {issue, range},
    );
  }

  /**
   * Checks whether a reported line break overlaps a range, e.g. in `concurrently "a` + line break +
   * `b"`, which is reported for the outer script.
   * Dropped line breaks are removed on the way.
   * @param range The range in the analyzed script
   * @returns Whether one does
   */
  #isOverlapReported(range: Range) {
    const lineBreaks = this.#lineBreaks;
    const end = sortedArrayInsertionIndexWith(
      lineBreaks,
      (reported) => reported.range.pos < range.end,
    );

    // Line breaks that weren't dropped don't overlap each other, as an overlapping one isn't
    // reported, so the ones before the last one that starts before the range ends also end before
    // that one starts. If that one isn't empty and doesn't overlap the range, neither do they
    for (let index = end - 1; index >= 0; index--) {
      const reported = lineBreaks[index];
      if (!reported) {
        break;
      }

      if (isDropped(reported.issue)) {
        lineBreaks.splice(index, 1);
      } else if (range.pos < reported.range.end) {
        return true;
      } else if (reported.range.pos < reported.range.end) {
        return false;
      }
    }

    return false;
  }
}
