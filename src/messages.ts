import {truncate as truncateText} from '@andreww2012/unutils';

// Suggestions that several reports share
export const BASH_4_SUGGESTION =
  "It needs Bash 4 or later, which macOS doesn't ship; use a Node.js script instead.";
export const BASH_SUGGESTION =
  "Scripts run with `sh` (which isn't Bash on e.g. Debian/Ubuntu) or cmd.exe (on Windows).";
export const CROSS_ENV_SUGGESTION = 'Use `cross-env` instead.';
export const CROSS_ENV_VARIABLE_SUGGESTION =
  '`cross-env` only replaces `$VAR` and `${VAR}` in all versions; use a Node.js script instead.';
export const DEFAULT_SUGGESTION = 'Use a cross-platform package or a Node.js script instead.';
export const NODE_SCRIPT_SUGGESTION = 'Use a Node.js script instead.';
export const QUOTE_GLOB_SUGGESTION =
  'Quote it with escaped double quotes (`\\"`) and let the tool expand it instead.';
export const RIMRAF_SUGGESTION = 'Use `rimraf` instead.';
export const SHELL_SCRIPT_SUGGESTION =
  'Shell scripts require a POSIX shell; use a Node.js script instead.';
export const VARIABLE_SUGGESTION = 'Use `cross-env` or a Node.js script instead.';

/** Maximum length of script text in a report message */
const MAX_SNIPPET_CHARACTERS = 40;
const WHITESPACE = /\s+/g;

/**
 * Shortens script text for a report message.
 * @param text Text from the script
 * @returns The text on a single line, cut off at the maximum length
 */
export const truncate = (text: string) =>
  truncateText(text.replaceAll(WHITESPACE, ' '), {length: MAX_SNIPPET_CHARACTERS});

/**
 * Describes a fix that replaces script text, e.g. "Replace `rm -rf` with `rimraf`.".
 * @param original The replaced text
 * @param replacement The text that replaces it
 * @returns The description
 */
export const describeReplacement = (original: string, replacement: string) =>
  `Replace \`${truncate(original)}\` with \`${truncate(replacement)}\`.`;
