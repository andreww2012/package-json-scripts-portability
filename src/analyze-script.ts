import {PLATFORMS} from './platforms.ts';
import {type RunnerIssue, type ScriptIssue, issueKey} from './reporter.ts';
import {PACKAGE_MANAGER_RUNNERS, type Runner, isRunnerAgnosticScript} from './runners.ts';
import {analyzeWithRunner} from './script-analyzer.ts';
import {type MaybeReadonlyArray, arrayIntersection, arrayify, isEqual} from './utils.ts';

export interface AnalyzeScriptOptions {
  /** Names of the package's dependencies, e.g. to detect del-cli's `del` alias */
  dependencies?: readonly string[];

  /** Commands that shouldn't be reported */
  ignoreCommands?: readonly string[];

  /**
   * What runs the script: a package manager, or `node` for `node --run`.
   * It decides e.g. which shell runs the script and which environment variables it gets.
   * Several runners report what breaks with any of them.
   * Defaults to `npm`
   */
  runner?: MaybeReadonlyArray<Runner>;

  /**
   * Scripts that any package manager may run, which are checked with all of them instead of
   * `runner`: `true` for all scripts, `false` for none, or whether each script is, by name, on
   * top of the defaults (`preinstall`, `install`, `postinstall` and `prepare`)
   */
  runnerAgnosticScripts?: boolean | Readonly<Record<string, boolean>>;

  /** The script's name in package.json, e.g. `postinstall`, to tell if it's runner-agnostic */
  scriptName?: string;

  /** Whether pnpm's `shell-emulator` setting is on, so that it runs the script with Yarn's shell */
  shellEmulator?: boolean;
}

const DEFAULT_RUNNERS: readonly Runner[] = ['npm'];

/** A script that only consists of a comment line, i.e. documentation rather than a script */
const COMMENT_LINE = /^\s*#[^\n]*$/;

/**
 * Merges the issues found with each runner, e.g. `rm` with both npm and pnpm.
 * A merged issue is on the platforms where any of the runners has it, and keeps its fix only if
 * all of them suggest the same one.
 * @param issuesByRunner The issues found with each runner
 * @returns The merged issues
 */
const mergeIssues = (issuesByRunner: ReadonlyMap<Runner, readonly RunnerIssue[]>) => {
  const merged = new Map<string, ScriptIssue>();

  issuesByRunner.forEach((issues, runner) => {
    issues.forEach((issue) => {
      const key = issueKey(issue);
      const existing = merged.get(key);

      if (existing) {
        existing.platforms = arrayIntersection(PLATFORMS, [
          ...existing.platforms,
          ...issue.platforms,
        ]);
        existing.runners.push(runner);
        if (!isEqual(existing.fix, issue.fix)) {
          existing.fix = undefined;
        }
      } else {
        merged.set(key, {...issue, runners: [runner]});
      }
    });
  });

  return [...merged.values()];
};

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

  const runners = isRunnerAgnosticScript(options.scriptName, options.runnerAgnosticScripts)
    ? PACKAGE_MANAGER_RUNNERS
    : arrayify(options.runner);
  return mergeIssues(
    new Map(
      (runners.length > 0 ? runners : DEFAULT_RUNNERS).map(
        (runner) => [runner, analyzeWithRunner(script, options, runner)] as const,
      ),
    ),
  );
};
