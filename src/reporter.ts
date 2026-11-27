import {type Context, type Range, type Shell, type SyntaxKind, rangeInScript} from './context.ts';
import {
  MACOS_PLATFORMS,
  NOT_LINUX_OR_WINDOWS,
  PLATFORMS,
  type Platform,
  WINDOWS_PLATFORMS,
} from './platforms.ts';
import type {Runner} from './runners.ts';
import {type OmitStrict, type ReadonlyDeep, arrayIntersection, clamp} from './utils.ts';
import {PLACEHOLDER} from './words.ts';

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
const issueKey = (issue: OmitStrict<RunnerIssue, 'fix' | 'platforms'>) =>
  JSON.stringify([issue.messageId, issue.pos, issue.end, issue.data]);

/** Platforms on which each kind of syntax doesn't work, by the shell that runs it */
const SYNTAX_PLATFORMS: ReadonlyDeep<Record<SyntaxKind, Record<Shell, Platform[]>>> = {
  bash: {bash: [], native: NOT_LINUX_OR_WINDOWS, sh: NOT_LINUX_OR_WINDOWS},
  bash4: {bash: MACOS_PLATFORMS, native: PLATFORMS, sh: PLATFORMS},
  bashNonPosix: {bash: [], native: PLATFORMS, sh: PLATFORMS},
  posix: {bash: [], native: WINDOWS_PLATFORMS, sh: []},
};

export class Reporter {
  /** Reported issues, including duplicates */
  readonly issues: RunnerIssue[] = [];

  /**
   * Issues that make a command fail, e.g. `rm` on Windows, unlike ones in its arguments, with the
   * platforms where it fails, if only on some of the issue's platforms
   */
  readonly #failures = new WeakMap<RunnerIssue, readonly Platform[] | undefined>();

  /** Length of the analyzed script */
  readonly #length: number;

  constructor(length: number) {
    this.#length = length;
  }

  /** The issues without duplicates by their keys, each on the platforms of all of its duplicates */
  get uniqueIssues() {
    const unique = new Map<string, RunnerIssue>();
    // Duplicates are only merged here, as an issue may be dropped before that, e.g. in a platform
    // fallback, while its duplicate stays
    this.issues.forEach((issue) => {
      const key = issueKey(issue);
      const existing = unique.get(key);
      unique.set(
        key,
        existing
          ? {
              ...existing,
              platforms: arrayIntersection(PLATFORMS, [...existing.platforms, ...issue.platforms]),
            }
          : issue,
      );
    });
    return unique;
  }

  isFailure(issue: RunnerIssue) {
    return this.#failures.has(issue);
  }

  /**
   * Gets where an issue makes its command fail.
   * @param issue The issue
   * @returns The platforms, which are none if it doesn't make the command fail
   */
  failingPlatforms(issue: RunnerIssue) {
    if (!this.#failures.has(issue)) {
      return [];
    }
    const platforms = this.#failures.get(issue);
    return platforms
      ? issue.platforms.filter((platform) => platforms.includes(platform))
      : issue.platforms;
  }

  /**
   * Marks the issues reported since an index as ones that make a command fail, unless they are
   * marked already.
   * @param start Index of the first issue to mark
   * @param platforms Where they make the command fail, if only on some of their platforms, e.g.
   * where the issue is that it's not known what the command is meant for
   */
  markFailures(start: number, platforms?: readonly Platform[]) {
    this.issues.slice(start).forEach((issue) => {
      if (!this.#failures.has(issue)) {
        this.#failures.set(issue, platforms);
      }
    });
  }

  /**
   * Removes platforms from the issues reported since an index, and drops the issues that are left
   * without platforms.
   * @param start Index of the first issue to update
   * @param platformsOf Gets the platforms to remove from an issue
   */
  removePlatforms(
    start: number,
    platformsOf: (issue: RunnerIssue) => ReadonlySet<Platform> | undefined,
  ) {
    this.issues.splice(start).forEach((issue) => {
      const removed = platformsOf(issue);
      if (removed) {
        issue.platforms = issue.platforms.filter((platform) => !removed.has(platform));
      }
      if (issue.platforms.length > 0) {
        this.issues.push(issue);
      }
    });
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
    // A fix that copies a placeholder would insert it instead of the text that it replaces
    const isApplicable =
      !fix.description.includes(PLACEHOLDER) &&
      edits.every(
        ({end, pos, text}) =>
          pos >= 0 &&
          pos <= end &&
          end <= this.#length &&
          !text.includes(PLACEHOLDER) &&
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
      // The parser's positions can exceed the script's length, e.g. after a trailing `\`
      const pos = clamp(range.pos, 0, this.#length);
      this.issues.push({
        data,
        end: clamp(range.end, pos, this.#length),
        fix: this.#mapFix(context, fix),
        messageId,
        platforms: remaining,
        pos,
      });
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
