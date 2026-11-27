import type {Platform} from './platforms.ts';

export interface Range {
  end: number;
  pos: number;
}

/**
 * The shell that interprets a piece of a script:
 * - `native`: the package manager's default, i.e. `sh` on macOS/Linux and cmd.exe on Windows
 * - `sh`: POSIX `sh`, e.g. in `sh -c "..."`
 * - `bash`: Bash (or a shell compatible with it), e.g. in `bash -c "..."`
 */
export type Shell = 'bash' | 'native' | 'sh';

/**
 * Where a syntax works:
 * - `posix`: in POSIX shells, but not in cmd.exe
 * - `bash`: in Bash, but not in POSIX `sh` (e.g. dash) or cmd.exe
 * - `bash4`: in Bash 4 or later, so not in macOS' `sh` and `bash` (Bash 3.2) either
 * - `bashNonPosix`: in Bash outside of its POSIX mode, so not in macOS' `sh` either
 */
export type SyntaxKind = 'bash' | 'bash4' | 'bashNonPosix' | 'posix';

/**
 * How `cross-env` gets a piece of the script, whose variables it replaces and whose single quotes
 * it removes:
 * - `arguments`: as its arguments, e.g. the variables that it sets
 * - `command`: as the words of the command that it runs without a shell, which gets `%NAME%` for
 *   `$NAME` on Windows
 * - `script`: as the script that `cross-env-shell` runs, which has lost its single quotes before
 *   the shell runs it
 */
type CrossEnvRole = 'arguments' | 'command' | 'script';

export interface Context {
  /** Bash options enabled with `bash -O` or `shopt -s`, e.g. `globstar` */
  bashOptions?: ReadonlySet<string>;
  /** Platforms on which an enclosing piece of the script was already reported */
  covered: ReadonlySet<Platform>;
  /** How `cross-env` gets this piece, if it does */
  crossEnv: CrossEnvRole | false;

  /**
   * Variables that `cross-env` sets for the command that this piece is part of, e.g. `A` for `$A`
   * in `cross-env A=1 node $A`
   */
  crossEnvVariables?: ReadonlySet<string>;

  /**
   * Text that fixes can't insert, as it would end or change the string that contains this piece,
   * e.g. `"` in `sh -c "..."`
   */
  fixExclusions: readonly RegExp[];

  /**
   * The range to report where node positions can't be mapped to the analyzed script, e.g. in
   * escaped backticks.
   * Fixes aren't reported there
   */
  fixedRange: Range | undefined;
  /** Offset of `source` in the analyzed script */
  offset: number;

  /**
   * `source` with the outer shell's expansions instead of their placeholders, e.g. of `$OUT` in
   * `sh -c "tsc > $OUT"`.
   * It has the same length, so reports and fixes copy text from it
   */
  originalSource: string;
  /** Whether the output of this piece goes into a file or a pipe instead of the terminal */
  outputRedirected?: boolean;
  /** Whether this piece runs in Yarn's portable shell */
  portable: boolean;

  /**
   * Whether this piece is in the script that the runner runs, rather than in a script nested in it,
   * e.g. in `sh -c "..."`
   */
  runnerScript: boolean;
  shell: Shell;
  /** The source that node positions refer to */
  source: string;
}

/**
 * Gets where a node of a piece of the script is in the analyzed script.
 * @param context The piece that the node is in
 * @param node The node, with positions relative to the piece's source
 * @returns The range in the analyzed script, or the piece's fixed range
 */
export const rangeInScript = (context: Context, node: Range) =>
  context.fixedRange || {end: context.offset + node.end, pos: context.offset + node.pos};

/**
 * Gets the text of a node as the script has it, e.g. with `$OUT` instead of its placeholder.
 * @param context The piece of the script that the node is in
 * @param node The node, with positions relative to the piece's source
 * @returns The text
 */
export const originalText = (context: Context, node: Range) =>
  context.originalSource.slice(node.pos, node.end);

export const withCovered = (context: Context, platforms: readonly Platform[]) =>
  platforms.every((platform) => context.covered.has(platform))
    ? context
    : {...context, covered: new Set([...context.covered, ...platforms])};

/** Gets how reports name Bash syntax of a kind, e.g. "Bash 4" for Bash 4 syntax */
export const bashLabel = (kind: SyntaxKind) => (kind === 'bash4' ? 'Bash 4' : 'Bash-specific');
