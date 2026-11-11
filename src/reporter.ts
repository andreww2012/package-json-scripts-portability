import {type Context, type Range, type Shell, type SyntaxKind, rangeInScript} from './context.ts';
import {
  MACOS_PLATFORMS,
  NOT_LINUX_OR_WINDOWS,
  PLATFORMS,
  type Platform,
  WINDOWS_PLATFORMS,
} from './platforms.ts';
import type {Runner} from './runners.ts';
import {type OmitStrict, type ReadonlyDeep, clamp} from './utils.ts';

export type ScriptIssueMessageId =
  | 'inconsistentBehavior'
  | 'unsupportedCommand'
  | 'unsupportedSyntax'
  | 'unsupportedUsage';

export interface ScriptEdit {
  /** End offset (exclusive) of the replaced text in the script */
  end: number;
  /** Start offset of the replaced text in the script */
  pos: number;
  /** The replacement */
  text: string;
}

export interface ScriptFix {
  /** Describes the fix for people, e.g. "Prefix the command with `cross-env`." */
  description: string;
  /** Replacements that don't overlap */
  edits: ScriptEdit[];
}

export interface ScriptIssue {
  /** Message data, apart from `platforms` */
  data: Record<string, string>;
  /** End offset (exclusive) of the issue in the script */
  end: number;
  /** A fix for the issue, if it has an obvious one */
  fix?: ScriptFix;
  messageId: ScriptIssueMessageId;
  /** Platforms on which the script doesn't work as intended */
  platforms: Platform[];
  /** Start offset of the issue in the script */
  pos: number;
  /** Runners with which the script has the issue */
  runners: Runner[];
}

/** An issue that the script has with one runner */
export type RunnerIssue = OmitStrict<ScriptIssue, 'runners'>;

/**
 * Gets what identifies an issue, apart from the platforms and the runners that it's found for.
 * @param issue The issue
 * @returns A string that is the same for the same issues
 */
export const issueKey = (issue: OmitStrict<RunnerIssue, 'fix' | 'platforms'>) =>
  JSON.stringify([issue.messageId, issue.pos, issue.end, issue.data]);

/** Platforms on which each kind of syntax doesn't work, by the shell that runs it */
const SYNTAX_PLATFORMS: ReadonlyDeep<Record<SyntaxKind, Record<Shell, Platform[]>>> = {
  bash: {bash: [], native: NOT_LINUX_OR_WINDOWS, sh: NOT_LINUX_OR_WINDOWS},
  bash4: {bash: MACOS_PLATFORMS, native: PLATFORMS, sh: PLATFORMS},
  bashNonPosix: {bash: [], native: PLATFORMS, sh: PLATFORMS},
  posix: {bash: [], native: WINDOWS_PLATFORMS, sh: []},
};

export class Reporter {
  readonly issues: RunnerIssue[] = [];

  /**
   * Length of the analyzed script, which unbash's positions can exceed, e.g. after a trailing `\`
   */
  readonly #length: number;
  readonly #seen = new Set<string>();

  constructor(length: number) {
    this.#length = length;
  }

  /**
   * Maps a fix's positions to the analyzed script.
   * @param context Where the fix is
   * @param fix The fix, with positions relative to the context's source
   * @returns The mapped fix, or `undefined` if it can't be applied in the context
   */
  #mapFix(context: Context, fix: ScriptFix | undefined) {
    if (!fix || context.fixedRange) {
      return undefined;
    }

    const edits = fix.edits.map(({end, pos, text}) => ({
      end: context.offset + end,
      pos: context.offset + pos,
      text,
    }));
    const isApplicable = edits.every(
      ({end, pos, text}) =>
        pos >= 0 &&
        pos <= end &&
        end <= this.#length &&
        context.fixExclusions.every((exclusion) => !exclusion.test(text)),
    );

    return isApplicable ? {description: fix.description, edits} : undefined;
  }

  report(
    context: Context,
    node: Range,
    messageId: ScriptIssueMessageId,
    data: Record<string, string>,
    platforms: readonly Platform[],
    fix?: ScriptFix,
  ) {
    const remaining = platforms.filter((platform) => !context.covered.has(platform));

    if (remaining.length > 0) {
      const range = rangeInScript(context, node);
      const pos = clamp(range.pos, 0, this.#length);
      const end = clamp(range.end, pos, this.#length);
      const key = issueKey({data, end, messageId, pos});

      if (!this.#seen.has(key)) {
        this.#seen.add(key);
        this.issues.push({
          data,
          end,
          fix: this.#mapFix(context, fix),
          messageId,
          platforms: remaining,
          pos,
        });
      }
    }

    return remaining;
  }

  reportSyntax(
    context: Context,
    node: Range,
    kind: SyntaxKind,
    isPortableSupported: boolean,
    messageId: ScriptIssueMessageId,
    data: Record<string, string>,
    fix?: ScriptFix,
  ) {
    const platforms = context.portable
      ? isPortableSupported
        ? []
        : PLATFORMS
      : SYNTAX_PLATFORMS[kind][context.shell];

    return this.report(context, node, messageId, data, platforms, fix);
  }
}
