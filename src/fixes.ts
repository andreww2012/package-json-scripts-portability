import type {BraceExpansionPart, Statement, Word} from 'unbash';
import type {Range} from './context.ts';
import {describeReplacement, truncate} from './messages.ts';
import type {ScriptEdit, ScriptFix} from './reporter.ts';
import {ASSIGNMENT, GLOB_PART_TYPES, isPlainWord, staticValue} from './words.ts';

const LINE_WHITESPACE = /[\t ]/;
const LINE_BREAK = /^\r?\n/;
/** Options of `rm` that `rimraf` doesn't need, e.g. `-rf` */
const RM_OPTION = /^(?:-[Rfr]+|--force|--recursive)$/;
/** A binary of a dependency, which package managers add to `PATH` */
export const DEPENDENCY_BINARY = /^(?:\.\/)?node_modules\/\.bin\/([^/]+)$/;
const JAVASCRIPT_FILE = /\.[cm]?js$/;
/** A brace expansion of plain alternatives, e.g. `{a,b}` */
const SIMPLE_BRACE_EXPANSION = /^\{([\w+\-./@]*(?:,[\w+\-./@]*)+)\}$/;
const PLAIN_TEXT = /^[\w+\-./:=@]*$/;

/** Creates a fix that replaces a piece of the script */
export const replacement = (node: Range, original: string, text: string): ScriptFix => ({
  description: describeReplacement(original, text),
  edits: [{end: node.end, pos: node.pos, text}],
});

/** Creates a fix that wraps a word in double quotes */
export const quoting = (word: Range, description: string): ScriptFix => ({
  description,
  edits: [
    {end: word.pos, pos: word.pos, text: '"'},
    {end: word.end, pos: word.end, text: '"'},
  ],
});

/**
 * Creates an edit that removes a piece of a script, along with the whitespace that separates it.
 * @param source The script
 * @param pos Start offset of the piece
 * @param end End offset (exclusive) of the piece
 * @returns The edit
 */
export const removal = (source: string, pos: number, end: number): ScriptEdit => {
  let start = pos;
  let stop = end;

  while (start > 0 && LINE_WHITESPACE.test(source.charAt(start - 1))) {
    start--;
  }

  if (start === 0 || source[start - 1] === '\n') {
    // Remove the whitespace that follows instead, and the line if it becomes empty
    while (stop < source.length && LINE_WHITESPACE.test(source.charAt(stop))) {
      stop++;
    }

    const lineBreak = LINE_BREAK.exec(source.slice(stop))?.[0];
    if (lineBreak) {
      stop += lineBreak.length;
    } else if (stop === source.length && start > 0) {
      start -= source[start - 2] === '\r' ? 2 : 1;
    }
  }

  return {end: stop, pos: start, text: ''};
};

/**
 * Gets a fix for a command that isn't available on all platforms, e.g. `rimraf` for `rm -rf`.
 * @param name Name that the command was invoked with, e.g. `rm`
 * @param nameWord Word that the name comes from
 * @param argumentWords The words that follow it
 * @param source The source that node positions refer to
 * @returns The fix, if there's a replacement that works the same
 */
export const commandFix = (
  name: string,
  nameWord: Word,
  argumentWords: readonly Word[],
  source: string,
): ScriptFix | undefined => {
  const first = argumentWords.at(0);

  switch (name) {
    case 'env': {
      // Only without options, e.g. `env CI=1 jest`
      return first &&
        ASSIGNMENT.test(first.text) &&
        argumentWords.some((word) => !ASSIGNMENT.test(word.text))
        ? replacement(nameWord, nameWord.text, 'cross-env')
        : undefined;
    }

    case 'rm': {
      const optionCount = argumentWords.findIndex(
        (word) => !RM_OPTION.test(staticValue(word) || ''),
      );
      const paths = optionCount === -1 ? [] : argumentWords.slice(optionCount);
      const globs = paths.filter((word) =>
        word.parts?.some((part) => GLOB_PART_TYPES.includes(part.type)),
      );

      if (
        paths.length === 0 ||
        paths.some((word) => staticValue(word)?.startsWith('-') && word.text !== '--') ||
        globs.some((word) => !isPlainWord(word, GLOB_PART_TYPES))
      ) {
        return undefined;
      }

      // Without options, e.g. in `rm dist.zip`, it's the end of `rm` itself
      const end = argumentWords[optionCount - 1]?.end || nameWord.end;
      const original = source.slice(nameWord.pos, end);

      // `rimraf` only expands globs with `--glob`, and quoting them makes it do so everywhere
      return globs.length === 0
        ? replacement({end, pos: nameWord.pos}, original, 'rimraf')
        : {
            description: `Replace \`${truncate(original)}\` with \`rimraf --glob\`, and quote the globs.`,
            edits: [
              {end, pos: nameWord.pos, text: 'rimraf --glob'},
              ...globs.flatMap((word) => quoting(word, '').edits),
            ],
          };
    }

    case 'source': {
      const file = first && staticValue(first);
      if (!first || file == null) {
        return undefined;
      }

      // dash only looks for files without a slash in `PATH`
      const range = {end: first.end, pos: nameWord.pos};
      return replacement(
        range,
        source.slice(range.pos, range.end),
        `. ${file.includes('/') ? '' : './'}${first.text}`,
      );
    }

    default: {
      return undefined;
    }
  }
};

/**
 * Gets a fix for running a command by its path, e.g. `node ./build.js` for `./build.js`.
 * @param name Path that the command was invoked with
 * @param nameWord Word that the path comes from
 * @returns The fix, if the path is a dependency's binary or a JavaScript file
 */
export const pathCommandFix = (name: string, nameWord: Word): ScriptFix | undefined => {
  const binary = DEPENDENCY_BINARY.exec(name)?.[1];
  if (binary) {
    return replacement(nameWord, nameWord.text, binary);
  }

  return JAVASCRIPT_FILE.test(name)
    ? {
        description: 'Run the file with `node`.',
        edits: [{end: nameWord.pos, pos: nameWord.pos, text: 'node '}],
      }
    : undefined;
};

/**
 * Gets a fix that expands a brace expansion, e.g. `dist/a dist/b` for `dist/{a,b}`.
 * @param word The word that contains the brace expansion
 * @param part Brace expansion in the word, e.g. `{a,b}`
 * @returns The fix, if the word only consists of plain text and the brace expansion
 */
export const braceExpansionFix = (word: Word, part: BraceExpansionPart) => {
  const alternatives = SIMPLE_BRACE_EXPANSION.exec(part.text)?.[1]?.split(',');
  const isPlain = (word.parts || []).every(
    (other) => other === part || (other.type === 'Literal' && PLAIN_TEXT.test(other.text)),
  );

  if (!alternatives || !isPlain) {
    return undefined;
  }

  const prefix = word.text.slice(0, part.pos - word.pos);
  const suffix = word.text.slice(part.end - word.pos);
  return replacement(
    word,
    word.text,
    alternatives.map((alternative) => `${prefix}${alternative}${suffix}`).join(' '),
  );
};

/**
 * Checks whether making a statement part of an AND list with the previous one only stops it after
 * a failure.
 * @param next The statement that follows
 * @returns Whether the rest of the logic stays the same, e.g. not for `a; b || c`, which would run
 * `c` when `a` fails
 */
const canChain = (next: Statement) =>
  !next.background && !(next.command.type === 'AndOr' && next.command.operators.includes('||'));

/**
 * Gets a fix for a line break that separates commands.
 * @param gapStart Where the text between the commands starts
 * @param gap The text between the commands, including the line break
 * @param next The statement that follows it
 * @returns The fix, if the text is only whitespace and the rest of the logic stays the same
 */
export const lineBreakFix = (
  gapStart: number,
  gap: string,
  next: Statement,
): ScriptFix | undefined =>
  gap.trim().length === 0 && canChain(next)
    ? {
        description: 'Replace the line break with `&&`, which stops at the first failing command.',
        edits: [{end: next.pos, pos: gapStart, text: ' && '}],
      }
    : undefined;

/**
 * Gets a fix that joins the lines of a command, e.g. after `||` or a `\` line continuation.
 * @param source The source that the command is in
 * @param position Where the line break is
 * @param end Where the whitespace after the line break ends
 * @returns The fix, which keeps the command the same in POSIX shells
 */
export const joinLinesFix = (source: string, position: number, end: number): ScriptFix => {
  // `\` and the line break are removed in POSIX shells, without adding a space
  const isContinuation = source[position - 1] === '\\';
  return {
    description: 'Join the lines.',
    edits: [
      isContinuation
        ? {end: position + 1, pos: position - 1, text: ''}
        : {end, pos: position, text: ' '},
    ],
  };
};

/**
 * Gets a fix for a `;` that separates commands.
 * @param range Where the `;` is
 * @param gap The text between the commands, including the `;`
 * @param next The statement that follows it, if any
 * @returns The fix, unless the statement that follows has alternatives (`||`) or runs in the
 * background
 */
export const semicolonFix = (
  range: Range,
  gap: string,
  next: Statement | undefined,
): ScriptFix | undefined => {
  if (!next) {
    return {description: 'Remove the `;`.', edits: [{...range, text: ''}]};
  }

  return gap.trim() === ';' && canChain(next)
    ? {
        description: 'Replace `;` with `&&`, which stops at the first failing command.',
        edits: [{end: next.pos, pos: range.pos - gap.indexOf(';'), text: ' && '}],
      }
    : undefined;
};

/**
 * Applies a fix to the script that it was found in.
 * @param script Text of the script to change
 * @param fix A fix from `analyzeScript`
 * @returns The fixed script
 */
export const applyFix = (script: string, fix: ScriptFix) =>
  fix.edits
    .toSorted((left, right) => right.pos - left.pos)
    .reduce((result, {end, pos, text}) => result.slice(0, pos) + text + result.slice(end), script);
