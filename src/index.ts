export {type AnalyzeScriptOptions, analyzeScript} from './analyze-script.ts';
export {applyFix} from './fixes.ts';
export {PLATFORMS, type Platform, formatPlatforms} from './platforms.ts';
export type {ScriptEdit, ScriptFix, ScriptIssue, ScriptIssueMessageId} from './reporter.ts';
export {
  RUNNERS,
  RUNNER_AGNOSTIC_SCRIPTS,
  type Runner,
  formatRunners,
  getRunner,
} from './runners.ts';
