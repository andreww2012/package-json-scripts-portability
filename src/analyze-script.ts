import {PLATFORMS, type Platform} from './platforms.ts';
import type {RunnerIssue, ScriptIssue} from './reporter.ts';
import {PACKAGE_MANAGER_RUNNERS, RUNNERS, type Runner, isRunnerAgnosticScript} from './runners.ts';
import {analyzeWithRunners} from './script-analyzer.ts';
import {type MaybeReadonlyArray, arrayIntersection, arrayify, isEqual} from './utils.ts';

export interface AnalyzeScriptOptions {
  /** Names of the package's dependencies, e.g. to detect `del-cli`'s `del` alias */
  dependencies?: readonly string[];

  /** Commands that shouldn't be reported */
  ignoreCommands?: readonly string[];

  /**
   * Platforms that the script needs to work on.
   * Issues are only reported on them, with the runners that have the issue on them.
   * Defaults to all platforms
   */
  platforms?: readonly Platform[];

  /**
   * What runs the script: a package manager, or `node` for `node --run`.
   * It decides e.g. which shell runs the script and which environment variables it gets.
   * Pass several runners to report what breaks with any of them.
   * Defaults to `npm`
   */
  runner?: MaybeReadonlyArray<Runner>;

  /**
   * Scripts that any package manager may run, which are checked with all of them instead of
   * `runner`.
   * `true` makes all scripts runner-agnostic, `false` none, and an object sets it for each script
   * on top of the defaults: `preinstall`, `install`, `postinstall` and `prepare`
   */
  runnerAgnosticScripts?: boolean | Readonly<Record<string, boolean>>;

  /** The script's name in `package.json`, e.g. `postinstall`, to tell if it's runner-agnostic */
  scriptName?: string;

  /** Whether pnpm's `shell-emulator` setting is on, so that it runs the script with Yarn's shell */
  shellEmulator?: boolean;
}

const DEFAULT_RUNNERS: readonly Runner[] = ['npm'];
const KNOWN_RUNNERS: ReadonlySet<Runner> = new Set(RUNNERS);

/** A script that only consists of comment lines, i.e. documentation rather than a script */
const COMMENT_LINES = /^\s*#[^\n]*(?:\n\s*#[^\n]*)*$/;

/**
 * Merges the issues found with each runner, e.g. `rm` with both npm and pnpm.
 * A merged issue is on the platforms where any of the runners has it, and keeps its fix only if
 * all of them suggest the same one.
 * @param issuesByRunner The issues found with each runner, by their keys
 * @param platforms The platforms to report the issues on
 * @returns The merged issues
 */
const mergeIssues = (
  issuesByRunner: ReadonlyMap<Runner, ReadonlyMap<string, RunnerIssue>>,
  platforms: readonly Platform[],
) => {
  const merged = new Map<string, ScriptIssue>();
  // Runners that run the script the same way share their issues, which are only merged once
  const mergedIssues = new Set<ReadonlyMap<string, RunnerIssue>>();

  issuesByRunner.forEach((issues, runner) => {
    const isMerged = mergedIssues.has(issues);
    mergedIssues.add(issues);

    issues.forEach((issue, key) => {
      // Not after merging, which would list runners that only have the issue on other platforms
      const issuePlatforms = arrayIntersection(issue.platforms, platforms);
      if (issuePlatforms.length === 0) {
        return;
      }

      const existing = merged.get(key);

      if (existing) {
        existing.runners.push(runner);
        if (!isMerged) {
          existing.platforms = arrayIntersection(PLATFORMS, [
            ...existing.platforms,
            ...issuePlatforms,
          ]);
          if (!isEqual(existing.fix, issue.fix)) {
            existing.fix = undefined;
          }
        }
      } else {
        merged.set(key, {...issue, platforms: issuePlatforms, runners: [runner]});
      }
    });
  });

  return [...merged.values()];
};

/**
 * Analyzes a `package.json` script for constructs that don't work (the same) on all platforms.
 * @param script The script's source
 * @param options Analysis options
 * @returns The issues found, with offsets relative to the script
 */
export const analyzeScript = (script: string, options?: AnalyzeScriptOptions) => {
  if (COMMENT_LINES.test(script.trimEnd())) {
    return [];
  }

  // `null` from JavaScript callers means the defaults too
  const analysisOptions = options || {};
  // Unknown runners are ignored, as the functions that format platforms and runners do
  const runners = isRunnerAgnosticScript(
    analysisOptions.scriptName,
    analysisOptions.runnerAgnosticScripts,
  )
    ? PACKAGE_MANAGER_RUNNERS
    : arrayify(analysisOptions.runner).filter((runner) => KNOWN_RUNNERS.has(runner));
  return mergeIssues(
    analyzeWithRunners(script, analysisOptions, runners.length > 0 ? runners : DEFAULT_RUNNERS),
    analysisOptions.platforms || PLATFORMS,
  );
};
