// cspell:ignore ftype mklink
import {
  BASH_4_SUGGESTION,
  BASH_SUGGESTION,
  CROSS_ENV_SUGGESTION,
  DEFAULT_SUGGESTION,
  RIMRAF_SUGGESTION,
  SHELL_SCRIPT_SUGGESTION,
} from './messages.ts';
import {
  LINUX_PLATFORMS,
  MACOS_PLATFORMS,
  NOT_LINUX_OR_WINDOWS,
  NOT_MACOS_OR_WINDOWS,
  PLATFORMS,
  POSIX_PLATFORMS,
  type Platform,
  WINDOWS_PLATFORMS,
} from './platforms.ts';

interface CommandInfo {
  /** Whether the command is a Bash builtin, i.e. it's available when the script runs in Bash */
  bashBuiltin?: boolean;
  /** Platforms on which the command isn't available */
  platforms: readonly Platform[];
  /** Appended to the report message */
  suggestion: string;
}

type CommandGroup = readonly [
  names: readonly string[],
  platforms: readonly Platform[],
  suggestion?: string,
];

/** POSIX shells, which don't exist on Windows */
export const SHELLS: readonly string[] = [
  'bash',
  'csh',
  'dash',
  'fish',
  'ksh',
  'sh',
  'tcsh', // cspell:disable-line
  'zsh',
];

const COMMAND_GROUPS: readonly CommandGroup[] = [
  // POSIX utilities that don't exist on Windows
  [['rm'], WINDOWS_PLATFORMS, RIMRAF_SUGGESTION],
  [['env', 'export'], WINDOWS_PLATFORMS, CROSS_ENV_SUGGESTION],
  [['true', ':'], WINDOWS_PLATFORMS, 'Use `exit 0` instead (e.g. `command || exit 0`).'],
  [['false'], WINDOWS_PLATFORMS, 'Use `exit 1` instead.'],
  [
    ['find'],
    WINDOWS_PLATFORMS,
    'Windows ships an unrelated `find` command; use a Node.js script instead.',
  ],
  [
    ['date'],
    WINDOWS_PLATFORMS,
    "cmd.exe's `date` sets the system date; use a Node.js script instead.",
  ],
  [SHELLS, WINDOWS_PLATFORMS, SHELL_SCRIPT_SUGGESTION],
  [
    [
      '.',
      '[',
      'alias',
      'awk',
      'base64',
      'basename',
      'bg',
      'bzip2',
      'cat',
      'chgrp', // cspell:disable-line
      'chmod',
      'chown',
      'clear',
      'cmp',
      'column',
      'comm',
      'command',
      'cp',
      'crontab',
      'cut',
      'df',
      'diff',
      'dirname',
      'du',
      'egrep',
      'eval',
      'exec',
      'expr',
      'fg',
      'fgrep', // cspell:disable-line
      'file',
      'fmt',
      'fold',
      'fuser',
      'getopts',
      'grep',
      'gunzip',
      'gzip',
      'hash',
      'head',
      'hexdump', // cspell:disable-line
      'iconv',
      'id',
      'install',
      'jobs',
      'join',
      'kill',
      'killall', // cspell:disable-line
      'less',
      'ln',
      'local',
      'ls',
      'lsof',
      'md5sum',
      'mktemp',
      'mv',
      'nice',
      'nl',
      'nohup',
      'od',
      'paste',
      'patch',
      'pgrep',
      'pkill',
      'printenv',
      'printf',
      'ps',
      'pwd',
      'read',
      'readlink',
      'readonly',
      'realpath',
      'return',
      'rev',
      'rsync',
      'sed',
      'seq',
      'sha1sum',
      'sha224sum',
      'sha256sum',
      'sha384sum',
      'sha512sum',
      'shasum',
      'shift',
      'sleep',
      'split',
      'stat',
      'stdbuf',
      'strings',
      'su',
      'sudo',
      'tail',
      'tee',
      'test',
      'time',
      'touch',
      'tput',
      'tr',
      'trap',
      'truncate',
      'ulimit',
      'umask',
      'uname',
      'uniq',
      'unset',
      'unzip',
      'wait',
      'wc',
      'which',
      'xargs',
      'xxd',
      'yes',
      'zcat', // cspell:disable-line
      'zip',
    ],
    WINDOWS_PLATFORMS,
  ],

  // GNU/Linux utilities that don't exist on macOS (or Windows)
  [
    [
      'apk',
      'apt',
      'apt-get',
      'b2sum',
      'dnf',
      'dpkg',
      'free',
      'gawk',
      'inotifywait', // cspell:disable-line
      'ip',
      'journalctl', // cspell:disable-line
      'ldconfig',
      'ldd',
      'lsblk',
      'notify-send',
      'nproc',
      'pacman', // cspell:disable-line
      'rpm',
      'sensible-browser',
      'service',
      'setsid', // cspell:disable-line
      'shred',
      'snap',
      'ss',
      'strace',
      'systemctl',
      'tac',
      'taskset', // cspell:disable-line
      'unxz', // cspell:disable-line
      'wget',
      'wl-copy',
      'wl-paste',
      'xclip', // cspell:disable-line
      'xdg-open',
      'xdotool',
      'xsel', // cspell:disable-line
      'xz',
      'yum',
      'zypper',
    ],
    NOT_MACOS_OR_WINDOWS,
  ],

  // macOS utilities that don't exist on Linux (or Windows)
  [
    [
      'afplay', // cspell:disable-line
      'agvtool', // cspell:disable-line
      'caffeinate', // cspell:disable-line
      'codesign', // cspell:disable-line
      'defaults',
      'diskutil', // cspell:disable-line
      'ditto',
      'hdiutil',
      'install_name_tool',
      'launchctl',
      'lipo', // cspell:disable-line
      'md5',
      'mdfind', // cspell:disable-line
      'networksetup', // cspell:disable-line
      'open',
      'osacompile', // cspell:disable-line
      'osascript', // cspell:disable-line
      'pbcopy',
      'pbpaste',
      'pkgutil',
      'plutil', // cspell:disable-line
      'pmset', // cspell:disable-line
      'qlmanage', // cspell:disable-line
      'say',
      'scutil',
      'security',
      'sw_vers',
      'tccutil', // cspell:disable-line
      'xcodebuild',
      'xcrun', // cspell:disable-line
      'xed',
    ],
    NOT_LINUX_OR_WINDOWS,
  ],

  // Windows commands that don't exist on macOS or Linux
  [
    ['del'],
    POSIX_PLATFORMS,
    "Use `rimraf` instead (del-cli's `del` alias is shadowed by cmd.exe's builtin on Windows).",
  ],
  [['erase', 'rd'], POSIX_PLATFORMS, RIMRAF_SUGGESTION],
  [['setx'], POSIX_PLATFORMS, CROSS_ENV_SUGGESTION], // cspell:disable-line
  [['rem'], POSIX_PLATFORMS, 'Remove the comment instead.'],
  // GNU coreutils ship `dir`, macOS doesn't
  [['dir'], MACOS_PLATFORMS],
  [
    [
      'assoc',
      'attrib',
      'call',
      'certutil', // cspell:disable-line
      'chcp',
      'chdir',
      'choice',
      'clip',
      'cls',
      'cmd',
      'copy',
      'cscript', // cspell:disable-line
      'endlocal',
      'explorer',
      'findstr',
      'ftype',
      'goto',
      'icacls',
      'md',
      'mklink',
      'move',
      'msiexec', // cspell:disable-line
      'netsh', // cspell:disable-line
      'pause',
      'powershell',
      'reg',
      'ren',
      'rename',
      'robocopy',
      'rundll32', // cspell:disable-line
      'schtasks', // cspell:disable-line
      'setlocal',
      'start',
      'systeminfo', // cspell:disable-line
      'taskkill', // cspell:disable-line
      'tasklist',
      'title',
      'ver',
      'where',
      'wmic',
      'wscript', // cspell:disable-line
      'wsl',
      'xcopy',
    ],
    POSIX_PLATFORMS,
  ],
];

/** Bash builtins that POSIX `sh` (e.g. dash on Debian/Ubuntu) and cmd.exe don't have */
const BASH_BUILTINS: readonly CommandGroup[] = [
  [
    [
      'bind',
      'builtin',
      'caller',
      'compgen',
      'complete',
      'declare',
      'dirs',
      'disown',
      'enable',
      'help',
      'history',
      'let',
      'logout',
      'shopt',
      'source',
      'suspend',
      'typeset',
    ],
    NOT_LINUX_OR_WINDOWS,
  ],
  // cmd.exe has its own `pushd` and `popd`
  [['popd', 'pushd'], LINUX_PLATFORMS],
  // Bash 3.2 (macOS' `sh` and `bash`) doesn't have them either
  [['mapfile', 'readarray'], PLATFORMS, BASH_4_SUGGESTION],
];

export const COMMANDS: ReadonlyMap<string, CommandInfo> = new Map([
  ...COMMAND_GROUPS.flatMap(([names, platforms, suggestion = DEFAULT_SUGGESTION]) =>
    names.map((name) => [name, {platforms, suggestion}] as const),
  ),
  ...BASH_BUILTINS.flatMap(([names, platforms, suggestion = BASH_SUGGESTION]) =>
    names.map((name) => [name, {bashBuiltin: true, platforms, suggestion}] as const),
  ),
]);

/** cmd.exe builtins (rather than executables), which Yarn's portable shell can't run on Windows */
export const CMD_BUILTINS: ReadonlySet<string> = new Set([
  'assoc',
  'call',
  'chdir',
  'cls',
  'copy',
  'del',
  'dir',
  'endlocal',
  'erase',
  'ftype',
  'goto',
  'md',
  'mklink',
  'move',
  'pause',
  'rd',
  'rem',
  'ren',
  'rename',
  'setlocal',
  'start',
  'title',
  'ver',
]);

/** Builtins of Yarn's portable shell, which work on all platforms */
export const PORTABLE_SHELL_BUILTINS: ReadonlySet<string> = new Set([
  ':',
  'cd',
  'echo',
  'exit',
  'false',
  'pwd',
  'sleep',
  'true',
  'unset',
]);

/** BSD utilities on macOS that don't support GNU-style long options */
export const NO_LONG_OPTIONS_ON_MACOS: ReadonlySet<string> = new Set([
  'basename',
  'cat',
  'chmod',
  'chown',
  'cp',
  'cut',
  'date',
  'df',
  'dirname',
  'du',
  'install',
  'ln',
  'mkdir',
  'mv',
  'readlink',
  'realpath',
  'rm',
  'rmdir',
  'sed',
  'stat',
  'tee',
  'touch',
  'tr',
  'truncate',
  'uname',
  'wc',
]);

/** OS commands rather than npm packages, including those that exist everywhere */
export const OS_COMMANDS: ReadonlySet<string> = new Set([
  ...COMMANDS.keys(),
  'cd',
  'echo',
  'mkdir',
  'rmdir',
  'sort',
  'timeout',
]);

/** Package manager subcommands that run the command given as their arguments */
export const EXEC_SUBCOMMANDS: Readonly<
  Record<'bun' | 'npm' | 'pnpm' | 'yarn', readonly string[]>
> = {
  bun: ['x'],
  npm: ['exec', 'x'],
  pnpm: ['dlx', 'exec'],
  yarn: ['dlx', 'exec'],
};

/** Options of package managers (before the subcommand) that take a value */
export const PACKAGE_MANAGER_VALUE_OPTIONS: readonly string[] = [
  '--cwd',
  '--dir',
  '--filter',
  '--prefix',
  '--workspace',
  '-C',
  '-F',
];

/** Options of package managers' exec subcommands that take a value */
export const EXEC_VALUE_OPTIONS: readonly string[] = ['--package', '-p'];

/** Commands whose arguments are often patterns rather than paths */
export const PATTERN_COMMANDS: ReadonlySet<string> = new Set([
  'awk',
  'echo',
  'egrep',
  'findstr',
  'grep',
  'printf',
  'sed',
]);

/** Commands that run the command given as their arguments, with their options that take a value */
export const WRAPPER_VALUE_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['bunx', ['--package', '-p']],
  ['command', []],
  ['env', ['--chdir', '--split-string', '--unset', '-C', '-S', '-u']],
  ['exec', ['-a']],
  ['nice', ['--adjustment', '-n']],
  ['nohup', []],
  ['npx', ['--package', '-p']],
  ['pnpx', ['--package', '-p']],
  ['sudo', ['-C', '-D', '-g', '-h', '-p', '-r', '-t', '-U', '-u']],
  ['time', ['-f', '-o']],
  ['xargs', ['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s']],
]);

/** Builtins that change the shell's state, which a subshell keeps from the commands that follow */
export const SHELL_STATE_COMMANDS: ReadonlySet<string> = new Set([
  '.',
  'alias',
  'cd',
  'exit',
  'export',
  'popd',
  'pushd',
  'read',
  'readonly',
  'return',
  'set',
  'shift',
  'source',
  'trap',
  'ulimit',
  'umask',
  'unalias',
  'unset',
]);
