import {NO_LONG_OPTIONS_ON_MACOS} from './commands.ts';
import {
  CROSS_ENV_SUGGESTION,
  NODE_SCRIPT_SUGGESTION,
  RIMRAF_SUGGESTION,
  describeReplacement,
  truncate,
} from './messages.ts';
import {
  LINUX_PLATFORMS,
  MACOS_PLATFORMS,
  NOT_MACOS_OR_WINDOWS,
  PLATFORMS,
  POSIX_PLATFORMS,
  type Platform,
  WINDOWS_PLATFORMS,
} from './platforms.ts';
import {ASSIGNMENT, isShortOptionCluster} from './words.ts';

interface CommandArgument {
  /** The argument's source text */
  text: string;
  /** The argument's value, or `undefined` if it depends on expansions */
  value: string | undefined;
}

/** A fix that replaces an argument */
interface UsageFix {
  argumentIndex: number;
  description: string;
  /** The argument's new source text */
  text: string;
}

interface UsageIssue {
  /** The argument that the issue ends at, or `undefined` if it's about the command itself */
  argumentIndex: number | undefined;
  data: Record<string, string>;
  fix?: UsageFix;
  messageId: 'inconsistentBehavior' | 'unsupportedCommand' | 'unsupportedUsage';
  platforms: readonly Platform[];
}

interface UsageOptions {
  /** Whether the command runs in Bash, e.g. in `bash -c "..."` */
  bash: boolean;
  /** Index of the first argument that can't be an option of the command, e.g. after `--` */
  optionsEnd: number;
  /** Whether the command runs in Yarn's portable shell */
  portable: boolean;
}

/** Commands that also exist in cmd.exe, whose names are case-insensitive there */
const CMD_COMMANDS: ReadonlySet<string> = new Set(['mkdir', 'rmdir', 'set', 'sort', 'timeout']);

/** Bash's pseudo-signals for `trap`, which dash doesn't support */
const BASH_TRAP_CONDITIONS: ReadonlySet<string> = new Set(['DEBUG', 'ERR', 'RETURN']);

const DASH = 'dash, the `sh` of Debian/Ubuntu,';

/** GNU `find` primaries that BSD `find` doesn't support */
const GNU_FIND_PRIMARIES: ReadonlySet<string> = new Set([
  '-executable',
  '-fprintf',
  '-printf',
  '-readable',
  '-regextype',
  '-writable',
  '-xtype', // cspell:disable-line
]);
/** BSD `find` options, which come before the starting paths */
const BSD_FIND_OPTIONS = /^-[EHLPXdsx]+$/; // cspell:disable-line

/** GNU regex escapes that BSD `sed` doesn't support, e.g. `\s` */
const GNU_SED_ESCAPE = /\\[<>bsw]/i;
/** The same, in basic regexes only */
const GNU_SED_BASIC_ESCAPE = /\\[+?]/;

/** GNU `xargs` options that BSD `xargs` doesn't support, e.g. `-d` */
const GNU_XARGS_OPTION = /^(?:-[0prtx]*[adil]|--(?:arg-file|delimiter|max-lines|replace)\b)/; // cspell:disable-line

const LONG_OPTION = /^--[^-]/;
/** Any option, e.g. `-p` */
const POSIX_OPTION = /^-./;
/** A cmd.exe option, e.g. `/s` */
const CMD_OPTION = /^\/[a-z]/i;
/** Including combined switches, e.g. `/s/q` */
const RMDIR_CMD_OPTION = /^(?:\/[qs])+$/i;
const TIMEOUT_CMD_OPTION = /^\/t$/i;
const ECHO_OPTIONS = /^-[Een]+$/;
const HEAD_COUNT_OPTION = /^-[cn]$/;
/** e.g. `-n-1` */
const HEAD_NEGATIVE_COUNT_OPTION = /^-[cn]-\d/;
const NEGATIVE_NUMBER = /^-\d/;
const SED_EXTENDED_OPTION = /^-[a-z]*[er]/i;
const SED_IN_PLACE_OPTION = /^-[a-z]*i$/i;
/** `set -o`, possibly after other options, e.g. `set -euo` */
const SET_NAMED_OPTION = /^-[a-z]*o$/i;
const SET_SHELL_OPTIONS = /^[+-][a-z]+$/i;
/** Including attached values, e.g. `-f%z` */
const STAT_FORMAT_OPTION = /^-[cf]/;

/**
 * Checks a command's options for ones that don't work (the same) on all platforms, e.g. `sed -i`.
 * @param name Name that the command was invoked with, e.g. `sed`
 * @param commandArguments The words that follow the command name
 * @param options Where the command runs, and where its options end
 * @returns The issues found
 */
export const checkCommandUsage = (
  name: string,
  commandArguments: readonly CommandArgument[],
  options: UsageOptions,
) => {
  const {bash, optionsEnd, portable} = options;
  const values = commandArguments.map(({value}) => value);
  const textOf = (index: number) => commandArguments[index]?.text || '';
  const issues: UsageIssue[] = [];
  const optionIndex = (isMatch: (value: string, index: number) => boolean) =>
    values.findIndex(
      (value, index) => index < optionsEnd && value != null && isMatch(value, index),
    );

  const report = (
    index: number,
    platforms: readonly Platform[],
    data: {reason: string; suggestion: string; syntax?: string; usage?: string},
    fix?: UsageFix,
  ) => {
    if (data.syntax) {
      issues.push({
        argumentIndex: index,
        data,
        fix,
        messageId: 'inconsistentBehavior',
        platforms,
      });
    } else {
      // Not `||` for the value: the value of `''` is empty
      const usage = data.usage || `${name} ${truncate(values[index] ?? textOf(index))}`;
      issues.push({
        argumentIndex: index,
        data: {...data, usage},
        fix,
        messageId: 'unsupportedUsage',
        platforms,
      });
    }
  };
  /** Creates a fix that replaces an argument's source text */
  const replaceArgument = (index: number, text: string): UsageFix => ({
    argumentIndex: index,
    description: describeReplacement(textOf(index), text),
    text,
  });
  const reportCommand = (platforms: readonly Platform[], suggestion: string) => {
    issues.push({
      argumentIndex: undefined,
      data: {command: name, suggestion},
      messageId: 'unsupportedCommand',
      platforms,
    });
  };

  if (NO_LONG_OPTIONS_ON_MACOS.has(name)) {
    const index = optionIndex((value) => LONG_OPTION.test(value));
    if (index !== -1) {
      report(index, MACOS_PLATFORMS, {
        reason: `BSD \`${name}\` doesn't support GNU-style long options`,
        suggestion: 'Use short options instead.',
        usage: `${name} ${values[index]?.split('=', 1)[0] || ''}`,
      });
    }
  }

  const lowerCaseName = name.toLowerCase();
  // Whether the command runs in dash on Debian/Ubuntu
  const isDash = !bash && !portable;

  switch (CMD_COMMANDS.has(lowerCaseName) ? lowerCaseName : name) {
    case '.': {
      const [file] = values;
      if (isDash && file != null && !file.includes('/')) {
        report(
          0,
          LINUX_PLATFORMS,
          {
            reason: 'dash only looks for the file in `PATH`, not in the current directory',
            suggestion: `Use \`. ./${truncate(file)}\` instead.`,
          },
          replaceArgument(0, `./${textOf(0)}`),
        );
      }
      break;
    }

    case '[':
    case 'test': {
      const index = values.indexOf('==');
      if (isDash && index !== -1) {
        report(
          index,
          LINUX_PLATFORMS,
          {
            reason: `${DASH} only supports \`=\` for comparing strings`,
            suggestion: 'Use `=` instead.',
            usage: name === '[' ? '[ ... == ... ]' : 'test ... == ...',
          },
          replaceArgument(index, '='),
        );
      }
      break;
    }

    case 'bash':
    case 'shopt': {
      // `bash -O globstar` and `shopt -s globstar`
      const option = name === 'bash' ? '-O' : '-s';
      const index = optionIndex(
        (value, valueIndex) => value === 'globstar' && values.slice(0, valueIndex).includes(option),
      );
      if (index !== -1) {
        report(index, MACOS_PLATFORMS, {
          reason: "macOS ships Bash 3.2, which doesn't have the `globstar` option",
          suggestion:
            'Quote globs with escaped double quotes (`\\"`) and let the tool expand them instead.',
          usage: `${name} ${option} globstar`,
        });
      }
      break;
    }

    case 'base64': {
      const index = optionIndex((value) => isShortOptionCluster(value, 'w'));
      if (index !== -1) {
        report(index, MACOS_PLATFORMS, {
          reason: 'BSD `base64` uses `-b` to wrap lines',
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      }
      break;
    }

    case 'cp': {
      const index = optionIndex((value) => isShortOptionCluster(value, 't'));
      if (index !== -1) {
        report(index, MACOS_PLATFORMS, {
          reason: "BSD `cp` doesn't support `-t`",
          suggestion: 'Put the target directory last instead.',
        });
      }
      break;
    }

    case 'date': {
      const index = optionIndex((value) => value.startsWith('-d'));
      if (index !== -1) {
        report(index, MACOS_PLATFORMS, {
          reason: 'BSD `date` uses `-j -f` to parse dates',
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      }
      break;
    }

    case 'dir': {
      const index = optionIndex((value) => CMD_OPTION.test(value));
      if (index !== -1) {
        report(index, LINUX_PLATFORMS, {
          reason: `\`${values[index] || ''}\` is a cmd.exe option`,
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      }
      break;
    }

    case 'find': {
      const start = values.findIndex((value) => value == null || !BSD_FIND_OPTIONS.test(value));
      const primary = values.findIndex((value) => value != null && GNU_FIND_PRIMARIES.has(value));

      if (values[start]?.startsWith('-')) {
        // GNU `find` uses the current directory by default
        report(
          start,
          MACOS_PLATFORMS,
          {
            reason: 'BSD `find` requires a starting path',
            suggestion: 'Add `.` before the expression.',
            usage: `find ${values[start] || ''}`,
          },
          {
            argumentIndex: start,
            description: 'Add `.` before the expression.',
            text: `. ${textOf(start)}`,
          },
        );
      } else if (primary !== -1) {
        report(primary, MACOS_PLATFORMS, {
          reason: `BSD \`find\` doesn't support \`${values[primary] || ''}\``,
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      }
      break;
    }

    case 'fuser': {
      const index = optionIndex((value) => isShortOptionCluster(value, 'k'));
      if (index !== -1) {
        report(index, MACOS_PLATFORMS, {
          reason: "macOS' `fuser` doesn't support `-k`",
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      }
      break;
    }

    case 'grep': {
      const index = optionIndex(
        (value) => isShortOptionCluster(value, 'P') || value === '--perl-regexp',
      );
      if (index !== -1) {
        report(index, MACOS_PLATFORMS, {
          reason: "BSD `grep` doesn't support Perl-compatible regular expressions",
          suggestion: 'Use `grep -E` or a Node.js script instead.',
        });
      }
      break;
    }

    case 'du': {
      const index = optionIndex((value) => isShortOptionCluster(value, 'b'));
      if (index !== -1) {
        report(index, MACOS_PLATFORMS, {
          reason: "BSD `du` doesn't support `-b`",
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      }
      break;
    }

    case 'echo': {
      const [first] = values;
      if (isDash && first != null && ECHO_OPTIONS.test(first)) {
        // macOS' `sh` is Bash in POSIX mode, whose `echo` doesn't take options either
        const isInterpretsEscapes = first.toLowerCase().includes('e');
        report(0, isInterpretsEscapes ? PLATFORMS : NOT_MACOS_OR_WINDOWS, {
          reason: isInterpretsEscapes
            ? "`sh`'s `echo` on macOS and Debian/Ubuntu, and cmd.exe's `echo` print the option literally"
            : "`sh`'s `echo` on macOS and cmd.exe's `echo` print the option literally",
          suggestion: NODE_SCRIPT_SUGGESTION,
          syntax: `\`echo ${first}\``,
        });
      }
      break;
    }

    case 'head': {
      // GNU's negative counts, e.g. `head -n -1` for all but the last line
      const index = optionIndex(
        (value, valueIndex) =>
          HEAD_NEGATIVE_COUNT_OPTION.test(value) ||
          (HEAD_COUNT_OPTION.test(value) && NEGATIVE_NUMBER.test(values[valueIndex + 1] || '')),
      );
      if (index !== -1) {
        const countIndex = HEAD_COUNT_OPTION.test(values[index] || '') ? index + 1 : index;
        report(countIndex, MACOS_PLATFORMS, {
          reason: "BSD `head` doesn't support negative counts",
          suggestion: NODE_SCRIPT_SUGGESTION,
          usage: `head ${values.slice(index, countIndex + 1).join(' ')}`,
        });
      }
      break;
    }

    case 'ln': {
      const index = optionIndex((value) => isShortOptionCluster(value, 'r'));
      if (index !== -1) {
        report(index, MACOS_PLATFORMS, {
          reason: "BSD `ln` doesn't support `-r`",
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      }
      break;
    }

    case 'mkdir':
    case 'rmdir': {
      const suggestion = lowerCaseName === 'mkdir' ? NODE_SCRIPT_SUGGESTION : RIMRAF_SUGGESTION;

      if (portable) {
        // Yarn's shell can't run cmd.exe builtins
        reportCommand(WINDOWS_PLATFORMS, suggestion);
        break;
      }

      const windowsOption = optionIndex((value) => RMDIR_CMD_OPTION.test(value));
      if (lowerCaseName === 'rmdir' && windowsOption !== -1) {
        report(windowsOption, POSIX_PLATFORMS, {
          reason: `\`${values[windowsOption] || ''}\` is a cmd.exe option`,
          suggestion,
        });
        break;
      }

      const posixOption = optionIndex((value) => POSIX_OPTION.test(value));
      if (posixOption !== -1) {
        report(posixOption, WINDOWS_PLATFORMS, {
          reason: `cmd.exe's \`${name}\` doesn't support POSIX options`,
          suggestion,
        });
        break;
      }

      // cmd.exe treats `/` in quoted paths as a path separator
      const pathWithSlash = values.findIndex(
        (value, index) =>
          value != null &&
          !value.startsWith('-') &&
          value.includes('/') &&
          !textOf(index).startsWith('"'),
      );
      if (pathWithSlash !== -1) {
        report(pathWithSlash, WINDOWS_PLATFORMS, {
          reason: `cmd.exe's \`${name}\` treats \`/\` as an option prefix`,
          suggestion,
        });
      }
      break;
    }

    case 'sed': {
      const isExtended =
        optionIndex((value) => SED_EXTENDED_OPTION.test(value) || value === '--regexp-extended') !==
        -1;
      const findEscape = (value: string | undefined) =>
        value == null || value.startsWith('-')
          ? undefined
          : (GNU_SED_ESCAPE.exec(value) ||
              (isExtended ? null : GNU_SED_BASIC_ESCAPE.exec(value)))?.[0];
      const escapeIndex = values.findIndex((value) => findEscape(value) != null);
      if (escapeIndex !== -1) {
        report(escapeIndex, MACOS_PLATFORMS, {
          reason: "BSD `sed` doesn't support it, so the pattern doesn't match",
          suggestion: 'Use POSIX regex syntax (e.g. `[[:space:]]`, or `+` with `sed -E`) instead.',
          syntax: `The GNU regex escape \`${findEscape(values[escapeIndex]) || ''}\``,
        });
      }

      const index = optionIndex((value) => SED_IN_PLACE_OPTION.test(value));
      if (index === -1) {
        break;
      }

      if (values[index + 1]?.length === 0) {
        report(index + 1, LINUX_PLATFORMS, {
          reason: 'GNU `sed` treats the empty backup suffix as the script',
          suggestion: 'Use an attached suffix (e.g. `-i.bak`) or a Node.js script instead.',
          usage: `sed ${values[index] || ''} ''`,
        });
      } else {
        report(index, MACOS_PLATFORMS, {
          reason: 'BSD `sed` requires a backup suffix argument after `-i`',
          suggestion: 'Use an attached suffix (e.g. `-i.bak`) or a Node.js script instead.',
        });
      }
      break;
    }

    case 'set': {
      const [first] = values;
      const pipefail = optionIndex(
        (value, index) => value === 'pipefail' && SET_NAMED_OPTION.test(values[index - 1] || ''),
      );

      if (isDash && pipefail !== -1) {
        report(pipefail, LINUX_PLATFORMS, {
          reason: `${DASH} doesn't support \`pipefail\``,
          suggestion: 'Remove it or use a Node.js script instead.',
          usage: 'set -o pipefail',
        });
      }

      if (first == null) {
        break;
      }

      if (SET_SHELL_OPTIONS.test(first)) {
        report(0, WINDOWS_PLATFORMS, {
          reason: "cmd.exe's `set` manages environment variables instead of shell options",
          suggestion: 'Remove it or use a Node.js script instead.',
        });
      } else if (ASSIGNMENT.test(first)) {
        // Yarn's shell can't run cmd.exe's `set` either
        report(0, portable ? PLATFORMS : POSIX_PLATFORMS, {
          reason: "POSIX shells don't set environment variables with `set`",
          suggestion: CROSS_ENV_SUGGESTION,
          syntax: `\`set ${truncate(first)}\``,
        });
      }
      break;
    }

    case 'sort': {
      const index = optionIndex((value) => POSIX_OPTION.test(value));
      if (index !== -1) {
        report(index, WINDOWS_PLATFORMS, {
          reason: "Windows' `sort` command uses `/` options",
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      }
      break;
    }

    case 'stat': {
      const index = optionIndex((value) => STAT_FORMAT_OPTION.test(value));
      if (index === -1) {
        break;
      }

      if (values[index]?.startsWith('-c')) {
        report(index, MACOS_PLATFORMS, {
          reason: 'BSD `stat` uses `-f` to specify the format',
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      } else {
        report(index, LINUX_PLATFORMS, {
          reason: 'GNU `stat -f` displays file system status instead of formatting the output',
          suggestion: NODE_SCRIPT_SUGGESTION,
          syntax: '`stat -f`',
        });
      }
      break;
    }

    case 'trap': {
      // e.g. `trap 'RC=1' ERR`
      const index = values.findIndex(
        (value, valueIndex) => valueIndex > 0 && value != null && BASH_TRAP_CONDITIONS.has(value),
      );
      if (isDash && index !== -1) {
        report(index, LINUX_PLATFORMS, {
          reason: `${DASH} doesn't support the \`${values[index] || ''}\` condition, so it ignores the trap`,
          suggestion: NODE_SCRIPT_SUGGESTION,
          syntax: `\`trap ... ${values[index] || ''}\``,
        });
      }
      break;
    }

    case 'xargs': {
      const index = optionIndex((value) => GNU_XARGS_OPTION.test(value));
      if (index !== -1) {
        report(index, MACOS_PLATFORMS, {
          reason: "BSD `xargs` doesn't support this GNU option",
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      }
      break;
    }

    case 'timeout': {
      if (TIMEOUT_CMD_OPTION.test(values[0] || '')) {
        report(0, POSIX_PLATFORMS, {
          reason: "`/t` is an option of Windows' `timeout` command",
          suggestion: NODE_SCRIPT_SUGGESTION,
        });
      } else {
        // GNU coreutils' `timeout` doesn't exist on macOS, and Windows' `timeout` is unrelated
        reportCommand(NOT_MACOS_OR_WINDOWS, NODE_SCRIPT_SUGGESTION);
      }
      break;
    }

    default: {
      break;
    }
  }

  return issues;
};
