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

export interface Context {
  /** Bash options enabled with `bash -O` or `shopt -s`, e.g. `globstar` */
  bashOptions?: ReadonlySet<string>;

  /**
   * Whether the package manager replaces `/` with `\` in this piece's command names on Windows, as
   * Yarn v1 does for the script itself
   */
  convertsSlashes: boolean;
  /** Platforms on which an enclosing piece of the script was already reported */
  covered: ReadonlySet<Platform>;
  /** Whether `cross-env` runs this piece, which replaces variables and removes single quotes */
  crossEnv: boolean;

  /**
   * Text that fixes can't insert, as it would end or change the string that contains this piece,
   * e.g. `"` in `sh -c "..."`
   */
  fixExclusions: readonly RegExp[];

  /**
   * The range to report instead of node positions, e.g. in escaped backticks.
   * Node positions can't be mapped to the analyzed script there, so there are no fixes either
   */
  fixedRange: Range | undefined;
  /** Offset of `source` in the analyzed script */
  offset: number;
  /** Whether this piece runs in Yarn's portable shell */
  portable: boolean;
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

export const withCovered = (context: Context, platforms: readonly Platform[]) =>
  platforms.every((platform) => context.covered.has(platform))
    ? context
    : {...context, covered: new Set([...context.covered, ...platforms])};

/** Gets how reports name Bash syntax of a kind, e.g. "Bash 4" for Bash 4 syntax */
export const bashLabel = (kind: SyntaxKind) => (kind === 'bash4' ? 'Bash 4' : 'Bash-specific');
