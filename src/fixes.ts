import type {
  AndOr,
  Assignment,
  BraceExpansionPart,
  PipelineNode,
  Redirection,
  Statement,
  Word,
  WordPart,
} from 'unbash';
import {CMD_BUILTINS, OS_COMMANDS, SHELL_STATE_COMMANDS} from './commands.ts';
import type {Range} from './context.ts';
import {describeReplacement, truncate} from './messages.ts';
import type {ScriptEdit, ScriptFix} from './reporter.ts';
import {substringAfter, toForwardSlashes} from './utils.ts';
import {
  ASSIGNMENT,
  GLOB_PART_TYPES,
  isPlainAssignment,
  isPlainWord,
  nestedSource,
  staticValue,
} from './words.ts';

const LINE_WHITESPACE = /[\t ]/;
const LINE_BREAK = /^\r?\n/;
const BACKSLASH_CODE_POINT = 92;
/** Options of `rm` that `rimraf` doesn't need, e.g. `-rf` */
const RM_OPTION = /^(?:-[Rfr]+|--force|--recursive)$/;
/** A binary of a dependency, which package managers add to `PATH` */
export const DEPENDENCY_BINARY = /^(?:\.\/)?node_modules\/\.bin\/([^/]+)$/;
/** Commands that run instead of a dependency's binary with the same name, e.g. cmd.exe's `del` */
const SHADOWING_COMMANDS: ReadonlySet<string> =
  OS_COMMANDS.union(CMD_BUILTINS).union(SHELL_STATE_COMMANDS);
const JAVASCRIPT_FILE = /\.[cm]?js$/;
/** Characters that `rimraf --glob` treats as glob syntax, e.g. `[` */
const GLOB_SYNTAX = /[(*?[\\\]{}]|^!/;
/** A brace expansion of plain alternatives, e.g. `{a,b}` */
const SIMPLE_BRACE_EXPANSION = /^\{([\w+\-./@]*(?:,[\w+\-./@]*)+)\}$/;
const PLAIN_TEXT = /^[\w+\-./:=@]*$/;
const JOIN_LINES_DESCRIPTION = 'Join the lines.';

/**
 * Text that `cross-env` changes in the words of its command: it removes `'`, and `\` before `$`,
 * `"`, `\` or `'`
 */
const CROSS_ENV_CHANGED_TEXT = /'|\\["$'\\]/;

/**
 * Values that `cross-env` changes, e.g. by removing their quotes or replacing variables, or only
 * reads up to a line break, or with `~` at the start or after `:`, which shells expand in
 * assignments, but not in arguments
 */
const CROSS_ENV_CHANGED_VALUE = /[\n\r$\\]|:~|^["'~]/;
/** Parts of a value that shells don't split or expand as globs in an argument either */
const UNSPLIT_PART_TYPES: ReadonlySet<WordPart['type']> = new Set([
  'DoubleQuoted',
  'Literal',
  'SingleQuoted',
]);
const QUOTES_OR_BACKSLASH = /["'\\]/;

/**
 * Checks whether a file that `.` runs is a dotfile without a slash, e.g. `.env`, which shells look
 * for in `PATH`, but where it's unlikely to be, unlike e.g. conda's `activate`
 */
export const isDotfileName = (file: string) => file.startsWith('.') && !file.includes('/');

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

/** Gets the value of a word, with placeholders for its expansions */
const maskedValue = (word: Word) => (word.parts ? nestedSource(word.parts) : word.value);

/**
 * Gets the edits that keep the value of an assignment the same in an argument of `cross-env`.
 * @param value The value
 * @returns The edits, e.g. ones that quote `./bin:$PATH`, which shells split in arguments, or
 * `undefined` if no edits can keep it
 */
const crossEnvValueEdits = (value: Word) => {
  const parts = value.parts || [];
  if (
    CROSS_ENV_CHANGED_VALUE.test(maskedValue(value)) ||
    parts.some((part) => part.type === 'BraceExpansion')
  ) {
    return undefined;
  }

  if (parts.every((part) => UNSPLIT_PART_TYPES.has(part.type))) {
    return [];
  }
  return QUOTES_OR_BACKSLASH.test(value.text) ? undefined : quoting(value, '').edits;
};

/**
 * Checks whether `cross-env` runs a command with the same words as the shell, e.g. not with
 * `console.log('a')`, whose quotes it removes, or with `""`, which it drops.
 * @param words The command's name and arguments
 * @returns Whether it does
 */
const isCrossEnvCommandSafe = (words: readonly Word[]) =>
  words.every((word) => {
    const value = maskedValue(word);
    return value.length > 0 && !CROSS_ENV_CHANGED_TEXT.test(value);
  });

/**
 * Gets the edits that keep a command the same when `cross-env` sets its variables.
 * @param assignments The items that become the arguments of `cross-env` before the command
 * @param commandWords The command's name and arguments
 * @returns The edits, or `undefined` if `cross-env` would run something else
 */
export const crossEnvEdits = (
  assignments: readonly (Assignment | Redirection | Word)[],
  commandWords: readonly Word[],
) => {
  const edits: ScriptEdit[] = [];
  const isSafe =
    isCrossEnvCommandSafe(commandWords) &&
    assignments.every((item) => {
      const valueEdits = isPlainAssignment(item) ? crossEnvValueEdits(item.value) : undefined;
      edits.push(...(valueEdits || []));
      return valueEdits;
    });
  return isSafe ? edits : undefined;
};

/**
 * Finds the `\` line continuation before a line, e.g. in `a \` + line break + `b`.
 * @param source The script
 * @param lineStart Where the line starts
 * @returns Where the `\` is, or -1 if the line doesn't continue the previous one
 */
const lineContinuationStart = (source: string, lineStart: number) => {
  if (source[lineStart - 1] !== '\n') {
    return -1;
  }

  const lineEnd = lineStart - (source[lineStart - 2] === '\r' ? 2 : 1);
  let backslashes = 0;
  while (source.codePointAt(lineEnd - backslashes - 1) === BACKSLASH_CODE_POINT) {
    backslashes++;
  }
  // An escaped backslash doesn't continue the line, e.g. in `a \\`
  return backslashes % 2 === 1 ? lineEnd - 1 : -1;
};

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

  const continuation = lineContinuationStart(source, start);
  if (continuation !== -1) {
    // Remove the `\` line continuation before the piece instead, so that the line break after the
    // piece still ends the line
    start = continuation;
    while (start > 0 && LINE_WHITESPACE.test(source.charAt(start - 1))) {
      start--;
    }
  } else if (start === 0 || source[start - 1] === '\n') {
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
      const commandIndex = argumentWords.findIndex((word) => !ASSIGNMENT.test(word.text));
      // Only without options, e.g. `env CI=1 jest`. The shell splits the values the same either way
      return commandIndex > 0 &&
        argumentWords
          .slice(0, commandIndex)
          .every((word) => !CROSS_ENV_CHANGED_VALUE.test(substringAfter(maskedValue(word), '='))) &&
        isCrossEnvCommandSafe(argumentWords.slice(commandIndex))
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
        globs.some((word) => !isPlainWord(word, GLOB_PART_TYPES)) ||
        // `rimraf` matches `**` recursively, unlike `sh`, which reads it as `*`
        globs.some((word) => word.text.includes('**')) ||
        // With `--glob`, the other paths are patterns too, e.g. `dist [old]`
        (globs.length > 0 &&
          paths.some((word) => !globs.includes(word) && GLOB_SYNTAX.test(staticValue(word) ?? '*')))
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

      // dash only looks for files without a slash in `PATH`, and macOS' `sh` looks there first
      const range = {end: first.end, pos: nameWord.pos};
      return replacement(
        range,
        source.slice(range.pos, range.end),
        `. ${isDotfileName(file) ? './' : ''}${first.text}`,
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
 * @param isDirectoryChanged Whether a command before it changed the directory, e.g. `cd`, so that
 * the binary's name could run another package's binary
 * @returns The fix, if the path is a dependency's binary or a JavaScript file
 */
export const pathCommandFix = (
  name: string,
  nameWord: Word,
  isDirectoryChanged: boolean,
): ScriptFix | undefined => {
  const binary = DEPENDENCY_BINARY.exec(name)?.[1];
  if (binary) {
    return isDirectoryChanged || SHADOWING_COMMANDS.has(binary.toLowerCase())
      ? undefined
      : replacement(nameWord, nameWord.text, binary);
  }

  return JAVASCRIPT_FILE.test(name)
    ? {
        description: 'Run the file with `node`.',
        edits: [{end: nameWord.pos, pos: nameWord.pos, text: 'node '}],
      }
    : undefined;
};

/**
 * Gets a fix that replaces the backslashes of a Windows path with slashes.
 * @param word The word with the path, e.g. `--config=configs\app.json`
 * @param original The word's text as the script has it
 * @param shouldQuote Whether to also quote the path, e.g. `src\**\*.js`, which would become a
 * recursive glob that `sh` doesn't support
 * @returns The fix, which only replaces the path: the text before it may have placeholders
 */
export const backslashPathFix = (word: Word, original: string, shouldQuote: boolean): ScriptFix => {
  const start = word.text.lastIndexOf('=') + 1;
  const path = toForwardSlashes(word.text.slice(start));
  const text = shouldQuote ? `"${path}"` : path;
  return {
    description: describeReplacement(original, `${original.slice(0, start)}${text}`),
    edits: [{end: word.end, pos: word.pos + start, text}],
  };
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

const hasAlternatives = ({command}: Statement) =>
  command.type === 'AndOr' && command.operators.includes('||');

/** Checks whether a command is only a word with the given text, e.g. `\` */
const isLoneWord = (node: AndOr | PipelineNode | undefined, text: string) =>
  node?.type === 'Command' &&
  node.prefix.length === 0 &&
  node.name?.text === text &&
  node.suffix.length === 0;

/** Checks whether a statement is a lone `\` at the end of the script, which can't follow `&&` */
const isTrailingBackslash = ({command}: Statement) => isLoneWord(command, '\\');

/**
 * Checks whether a statement ends with a command that is only a carriage return, e.g. after `&&`
 * and before a line feed, whose fix removes it
 */
const doesEndWithCarriageReturn = ({command}: Statement) => {
  const last = command.type === 'AndOr' ? command.commands.at(-1) : command;
  return isLoneWord(last?.type === 'Pipeline' ? last.commands.at(-1) : last, '\r');
};

/**
 * Checks whether joining two statements with `&&` keeps the logic the same, apart from stopping
 * after a failure.
 * @param statement The first statement
 * @param next The statement that follows
 * @returns Whether the rest of the logic stays the same, e.g. not for `a; b || c`, which would run
 * `c` when `a` fails, or for `a || b; c`, which cmd.exe would read as `a || (b && c)`
 */
const canChain = (statement: Statement, next: Statement) =>
  !next.background &&
  !hasAlternatives(statement) &&
  !hasAlternatives(next) &&
  !isTrailingBackslash(next);

/**
 * Gets a fix for a line break that separates statements.
 * @param source The source that the statements are in
 * @param gapStart Where the text between the statements starts, after the bodies of the first
 * statement's here-documents
 * @param statement The statement before the line break
 * @param next The statement that follows it
 * @returns The fix, if the text is only whitespace and the rest of the logic stays the same
 */
export const lineBreakFix = (
  source: string,
  gapStart: number,
  statement: Statement,
  next: Statement,
): ScriptFix | undefined => {
  const gap = source.slice(gapStart, next.pos);
  if (
    gap.trim().length > 0 ||
    // A here-document's closing line must stay on its own
    gapStart !== statement.end ||
    // e.g. after `\` and a carriage return, whose fix removes the carriage return instead
    lineContinuationStart(source, gapStart + gap.indexOf('\n') + 1) !== -1 ||
    // e.g. after `&&` and a carriage return, which is a command of its own, where `&&` can't
    // follow `&&`
    doesEndWithCarriageReturn(statement)
  ) {
    return undefined;
  }

  // `a &` and `b` on the next line are the same as `a & b`
  if (statement.background) {
    return {
      description: JOIN_LINES_DESCRIPTION,
      edits: [{end: next.pos, pos: gapStart, text: ' '}],
    };
  }

  return canChain(statement, next)
    ? {
        description: 'Replace the line break with `&&`, which stops at the first failing command.',
        edits: [{end: next.pos, pos: gapStart, text: ' && '}],
      }
    : undefined;
};

/**
 * Gets a fix that joins the lines of a command, e.g. after `||` or a `\` line continuation.
 * @param source The source that the command is in
 * @param position Where the line break is
 * @param end Where the text after the line break ends, e.g. the indentation of the next line
 * @returns The fix, which keeps the command the same in POSIX shells, if it only removes whitespace
 * or a `\` line continuation
 */
export const joinLinesFix = (
  source: string,
  position: number,
  end: number,
): ScriptFix | undefined => {
  // `\` and the line break are removed in POSIX shells, without adding a space
  if (source[position - 1] === '\\') {
    return {
      description: JOIN_LINES_DESCRIPTION,
      edits: [{end: position + 1, pos: position - 1, text: ''}],
    };
  }

  // Other text can't be removed, e.g. the body of a here-document
  return source.slice(position, end).trim().length === 0
    ? {description: JOIN_LINES_DESCRIPTION, edits: [{end, pos: position, text: ' '}]}
    : undefined;
};

/**
 * Gets a fix for a `;` that separates commands.
 * @param range Where the `;` is
 * @param gap The text between the commands, including the `;`
 * @param statement The statement before it
 * @param next The statement that follows it, if any
 * @returns The fix, unless a statement has alternatives (`||`) or the next one runs in the
 * background
 */
export const semicolonFix = (
  range: Range,
  gap: string,
  statement: Statement,
  next: Statement | undefined,
): ScriptFix | undefined => {
  if (!next) {
    // Without a space, a `#` right after the `;` would join the word before it instead of
    // starting a comment
    const text = gap[gap.indexOf(';') + 1] === '#' ? ' ' : '';
    return {description: 'Remove the `;`.', edits: [{...range, text}]};
  }

  return gap.trim() === ';' && canChain(statement, next)
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
