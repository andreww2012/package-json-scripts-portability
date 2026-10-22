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

/** A tilde expansion at the start of a word, e.g. `~/.npmrc` */
export const TILDE_EXPANSION = /^~[\w\-.]*(?:\/|$)/;

/** Characters that POSIX shells interpret in double quotes, e.g. `$` */
export const DOUBLE_QUOTED_SPECIAL_CHARACTERS = /["$\\`]/;

export const WHITESPACE = /\s/;

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
 * Gets the value of a word, if it doesn't depend on expansions.
 * @param word A word from the parsed script
 * @returns The value, or `undefined` if it's dynamic
 */
export const staticValue = (word: Word) =>
  word.parts == null || isStatic(word.parts) ? word.value : undefined;

/**
 * Checks whether a word is unquoted text without escapes or expansions, e.g. `dist/*.js`.
 * Double quotes don't change the value of such a word.
 * @param word A word from the parsed script
 * @param partTypes Types of parts that are allowed besides literal text, e.g. globs
 * @returns Whether the word is plain
 */
export const isPlainWord = (word: Word, partTypes: readonly WordPart['type'][] = []) =>
  !DOUBLE_QUOTED_SPECIAL_CHARACTERS.test(word.text) &&
  !TILDE_EXPANSION.test(word.text) &&
  (word.parts || []).every((part) => part.type === 'Literal' || partTypes.includes(part.type));

export const isPlainAssignment = (item: Assignment | Redirection | Word) =>
  item.type === 'Assignment' && item.value.type === 'Word' && item.index == null && !item.append;

/** Device files, which (unlike e.g. `/usr/...`) are rarely paths in containers or remote hosts */
export const POSIX_PATH = /(?:^|=)\/dev\//;
