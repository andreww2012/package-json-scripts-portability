import type {Assignment, DoubleQuotedChild, Redirection, Word, WordPart} from 'unbash';

/** A `NAME=value` word, e.g. an argument of `cross-env` */
export const ASSIGNMENT = /^[a-z_]\w*=/i;

const SHORT_OPTION_CLUSTER = /^-[a-z]+$/i;

/**
 * Checks whether a word is a cluster of short options that includes a letter, e.g. `-rf` for `f`.
 * @param value Value of a word from the script
 * @param letter Letter of the short option to look for
 * @returns Whether the word includes the option
 */
export const isShortOptionCluster = (value: string | undefined, letter: string) =>
  value != null && SHORT_OPTION_CLUSTER.test(value) && value.includes(letter);

/**
 * A tilde expansion at the start of a word, e.g. `~/.npmrc`.
 * With a digit after `~`, it's a version range, e.g. `~1.2.3`, which shells keep as it is
 */
export const TILDE_EXPANSION = /^~(?!\d)[\w\-.]*(?:\/|$)/;

/** Characters that POSIX shells interpret in double quotes, e.g. `$` */
export const DOUBLE_QUOTED_SPECIAL_CHARACTERS = /["$\\`]/;

export const WHITESPACE = /\s/;

/**
 * Replaces each character of the outer shell's expansions in the scripts that commands run, e.g.
 * of `$OUT` in `sh -c "tsc > $OUT"`.
 * Their values aren't known, so words with it aren't static
 */
// Unicode reserves U+FFFF as a non-character, so scripts don't contain it
export const PLACEHOLDER = '\u{FFFF}';

export const GLOB_PART_TYPES: readonly WordPart['type'][] = [
  'BraceExpansion',
  'ExtendedGlob',
  'Glob',
];

const isStatic = (parts: readonly (DoubleQuotedChild | WordPart)[]): boolean =>
  parts.every(
    (part) =>
      part.type === 'Literal' ||
      part.type === 'SingleQuoted' ||
      part.type === 'AnsiCQuoted' ||
      part.type === 'Glob' ||
      (part.type === 'DoubleQuoted' && isStatic(part.parts)),
  );

/**
 * Gets the text that a command receives for a word, e.g. a script for `sh -c`.
 * The outer shell's expansions are replaced by placeholders of the same length.
 * @param parts The word's parts
 * @param shouldKeepExpansions Whether to keep the expansions' text instead, e.g. for reports
 * @returns The text
 */
export const nestedSource = (
  parts: readonly (DoubleQuotedChild | WordPart)[],
  shouldKeepExpansions = false,
): string =>
  parts
    .map((part) => {
      switch (part.type) {
        case 'AnsiCQuoted':
        case 'Glob':
        case 'Literal':
        case 'SingleQuoted': {
          return part.value;
        }
        case 'DoubleQuoted':
        case 'LocaleString': {
          return nestedSource(part.parts, shouldKeepExpansions);
        }
        default: {
          // The results of expansions aren't known, and they're reported for the outer script
          // already
          return shouldKeepExpansions ? part.text : PLACEHOLDER.repeat(part.text.length);
        }
      }
    })
    .join('');

/**
 * Gets the value of a word, if it doesn't depend on expansions.
 * @param word A word from the parsed script
 * @returns The value, or `undefined` if it's dynamic
 */
export const staticValue = (word: Word) =>
  (word.parts == null || isStatic(word.parts)) && !word.value.includes(PLACEHOLDER)
    ? word.value
    : undefined;

/**
 * Checks whether a word is unquoted text without escapes or expansions, e.g. `dist/*.js`.
 * Double quotes don't change the value of such a word.
 * @param word A word from the parsed script
 * @param partTypes Types of parts that are allowed besides literal text, e.g. globs
 * @returns Whether the word is plain
 */
export const isPlainWord = (word: Word, partTypes: readonly WordPart['type'][] = []) =>
  !DOUBLE_QUOTED_SPECIAL_CHARACTERS.test(word.text) &&
  !word.text.includes(PLACEHOLDER) &&
  !TILDE_EXPANSION.test(word.text) &&
  (word.parts || []).every((part) => part.type === 'Literal' || partTypes.includes(part.type));

export const isPlainAssignment = (
  item: Assignment | Redirection | Word,
): item is Assignment & {value: Word} =>
  item.type === 'Assignment' && item.value.type === 'Word' && item.index == null && !item.append;

/** A word of letters, digits and underscores, e.g. a variable name */
const IDENTIFIER = /\w+/g;

/**
 * Checks whether a piece of a script mentions any of some variables, e.g. `$PORT` for `PORT`.
 * @param text The piece of the script
 * @param names Names of the variables
 * @returns Whether it does, even if only as a word that the shell doesn't expand
 */
export const doesMentionVariables = (text: string, names: ReadonlySet<string>) =>
  (text.match(IDENTIFIER) || []).some((word) => names.has(word));

/** Device paths, e.g. `/dev/null` */
// Unlike other absolute paths, they are rarely meant for containers or remote hosts
export const POSIX_PATH = /(?:^|=)\/dev\//;
