import {type AnalyzeScriptOptions, type Runner, analyzeScript, applyFix} from '../src/index.ts';

type Summary = [messageId: string, text: string, platforms: string];
type FixSummary = [text: string, description: string, fixed: string];

/**
 * Summarizes the issues found in a script as `[messageId, reported text, platforms]` tuples.
 * @param script Script source to analyze
 * @param options Options for the analysis
 * @returns A compact representation of each issue
 */
const summarize = (script: string, options?: AnalyzeScriptOptions): Summary[] =>
  analyzeScript(script, options)
    // eslint-disable-next-line unicorn/no-array-sort -- Sorts a new array
    .sort((left, right) => left.pos - right.pos)
    .map(({end, messageId, platforms, pos}) => [
      messageId,
      script.slice(pos, end),
      platforms.join(','),
    ]);

/**
 * Summarizes the fixes of the issues found in a script as `[reported text, description, fixed
 * script]` tuples.
 * @param script Script source to analyze
 * @param options Options for the analysis
 * @returns A compact representation of each fix
 */
const summarizeFixes = (script: string, options?: AnalyzeScriptOptions) =>
  analyzeScript(script, options)
    // eslint-disable-next-line unicorn/no-array-sort -- Sorts a new array
    .sort((left, right) => left.pos - right.pos)
    .flatMap(({end, fix, pos}): FixSummary[] =>
      fix ? [[script.slice(pos, end), fix.description, applyFix(script, fix)]] : [],
    );

/**
 * Summarizes the issues found in a script as `[messageId, reported text, platforms, runners]`
 * tuples.
 * @param script Script source to analyze
 * @param options Options for the analysis
 * @returns A compact representation of each issue
 */
const summarizeRunners = (script: string, options?: AnalyzeScriptOptions) =>
  analyzeScript(script, options).map(({end, messageId, platforms, pos, runners}) => [
    messageId,
    script.slice(pos, end),
    platforms.join(','),
    runners.join(','),
  ]);

const nodeRun: AnalyzeScriptOptions = {runner: 'node'};
const yarn: AnalyzeScriptOptions = {runner: 'yarn'};
const yarnClassic: AnalyzeScriptOptions = {runner: 'yarn-classic'};

const QUOTE = 'Quote it with escaped double quotes.';
const CROSS_ENV = 'Prefix the command with `cross-env`.';
const exitZeroDescription = (command: string) =>
  `Replace \`${command}\` with \`exit 0\`, which Bash rejects if the script gets extra arguments.`;

describe('analyzeScript', () => {
  describe('portable scripts', () => {
    it.each([
      'node build.js',
      'tsc && vite build',
      'eslint . --max-warnings 0',
      'npm run build -- --watch',
      'cross-env NODE_ENV=production node server.js',
      'eslint "src/**/*.ts"',
      'prettier --write "**/*.{md,json}"',
      'rimraf dist/*',
      'shx rm -rf dist/*',
      'node -e "console.log(require(\'./package.json\').version)"',
      'tsc 2>&1 | tee-cli build.log',
      'echo done',
      'cd packages/a && npm test',
      'mkdir dist',
      'git rev-parse HEAD > version.txt',
      'vitest run || exit 0',
      '(npm run a && npm run b) || exit 1',
      'concurrently "npm:watch-*" "vite"',
      'concurrently -n tsc,vite -c blue,green "tsc -w" "vite"',
      'node --test "test/*.test.js"',
      'tar -czf archive.tgz dist',
      'curl -fsSL https://example.com -o out.html',
      'echo "a; b && $"',
      'npm run build --if-present',
      'date-fns-cli',
      // Not parsable as a POSIX shell script, and not recognizably cmd.exe syntax
      'echo "unterminated',
    ])('%s', (script) => {
      expect(summarize(script)).toStrictEqual([]);
    });
  });

  describe('commands', () => {
    it.each<[string, Summary[]]>([
      ['rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      [
        'cp -r src/assets dist && mv a b && ln -s a b',
        [
          ['unsupportedCommand', 'cp', 'win32'],
          ['unsupportedCommand', 'mv', 'win32'],
          ['unsupportedCommand', 'ln', 'win32'],
        ],
      ],
      ['jest || true', [['unsupportedCommand', 'true', 'win32']]],
      ['jest || :', [['unsupportedCommand', ':', 'win32']]],
      ['[ -d dist ] || tsc', [['unsupportedCommand', '[', 'win32']]],
      [
        'test -f .env || cp .env.example .env',
        [
          ['unsupportedCommand', 'test', 'win32'],
          ['unsupportedCommand', 'cp', 'win32'],
        ],
      ],
      ['export NODE_ENV=production && node x', [['unsupportedCommand', 'export', 'win32']]],
      ['which node', [['unsupportedCommand', 'which', 'win32']]],
      ['sleep 1', [['unsupportedCommand', 'sleep', 'win32']]],
      ['find . -name "*.map" -delete', [['unsupportedCommand', 'find', 'win32']]],
      ['date +%s > now.txt', [['unsupportedCommand', 'date', 'win32']]],
      ['open http://localhost:3000', [['unsupportedCommand', 'open', 'linux,win32']]],
      ['xdg-open http://localhost:3000', [['unsupportedCommand', 'xdg-open', 'darwin,win32']]],
      [
        'cat x | pbcopy',
        [
          ['unsupportedCommand', 'cat', 'win32'],
          ['unsupportedCommand', 'pbcopy', 'linux,win32'],
        ],
      ],
      ['sha256sum dist/index.js', [['unsupportedCommand', 'sha256sum', 'win32']]],
      ['timeout 5 node server.js', [['unsupportedCommand', 'timeout', 'darwin,win32']]],
      ['bash scripts/release', [['unsupportedCommand', 'bash', 'win32']]],
      ['source .env && node x', [['unsupportedCommand', 'source', 'linux,win32']]],
      [
        'pushd docs && npm run build && popd',
        [
          ['unsupportedCommand', 'pushd', 'linux'],
          ['unsupportedCommand', 'popd', 'linux'],
        ],
      ],
      ['del /q dist', [['unsupportedCommand', 'del', 'darwin,linux']]],
      ['COPY a.txt b.txt', [['unsupportedCommand', 'COPY', 'darwin,linux']]],
      [
        'xcopy src dist /e && cls',
        [
          ['unsupportedCommand', 'xcopy', 'darwin,linux'],
          ['unsupportedCommand', 'cls', 'darwin,linux'],
        ],
      ],
      ['start http://localhost:3000', [['unsupportedCommand', 'start', 'darwin,linux']]],
      ['powershell -File build.ps1', [['unsupportedCommand', 'powershell', 'darwin,linux']]],
      ['./scripts/build.sh', [['unsupportedCommand', './scripts/build.sh', 'win32']]],
      [
        String.raw`scripts\build.bat`,
        [
          ['unsupportedCommand', String.raw`scripts\build.bat`, 'darwin,linux'],
          ['inconsistentBehavior', String.raw`scripts\build.bat`, 'darwin,linux'],
        ],
      ],
      ['./node_modules/.bin/tsc', [['unsupportedSyntax', './node_modules/.bin/tsc', 'win32']]],
      ['/usr/bin/env node x.js', [['unsupportedSyntax', '/usr/bin/env', 'win32']]],
    ])('%s', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it('reports a command once per invocation', () => {
      expect(summarize('rm a && rm b')).toStrictEqual([
        ['unsupportedCommand', 'rm', 'win32'],
        ['unsupportedCommand', 'rm', 'win32'],
      ]);
    });
  });

  describe('command usage', () => {
    it.each<[string, Summary[]]>([
      ['mkdir -p dist/assets', [['unsupportedUsage', 'mkdir -p', 'win32']]],
      ['mkdir dist/assets', [['unsupportedUsage', 'mkdir dist/assets', 'win32']]],
      [
        'mkdir --parents dist',
        [
          ['unsupportedUsage', 'mkdir --parents', 'darwin'],
          ['unsupportedUsage', 'mkdir --parents', 'win32'],
        ],
      ],
      ['rmdir /s /q dist', [['unsupportedUsage', 'rmdir /s', 'darwin,linux']]],
      ['rmdir -p a/b', [['unsupportedUsage', 'rmdir -p', 'win32']]],
      [
        'rm --recursive --force dist',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedUsage', 'rm --recursive', 'darwin'],
        ],
      ],
      [
        'sed -i s/a/b/ file',
        [
          ['unsupportedCommand', 'sed', 'win32'],
          ['unsupportedUsage', 'sed -i', 'darwin'],
        ],
      ],
      [
        'sed -Ei s/a/b/ file',
        [
          ['unsupportedCommand', 'sed', 'win32'],
          ['unsupportedUsage', 'sed -Ei', 'darwin'],
        ],
      ],
      [
        "sed -i '' s/a/b/ file",
        [
          ['unsupportedCommand', 'sed', 'win32'],
          ['unsupportedUsage', "sed -i ''", 'linux'],
          ['inconsistentBehavior', "''", 'win32'],
        ],
      ],
      ['sed -i.bak s/a/b/ file', [['unsupportedCommand', 'sed', 'win32']]],
      [
        String.raw`grep -oP "\d+" file`,
        [
          ['unsupportedCommand', 'grep', 'win32'],
          ['unsupportedUsage', 'grep -oP', 'darwin'],
        ],
      ],
      [
        'date -d yesterday',
        [
          ['unsupportedCommand', 'date', 'win32'],
          ['unsupportedUsage', 'date -d', 'darwin'],
        ],
      ],
      [
        'stat -c %s file',
        [
          ['unsupportedCommand', 'stat', 'win32'],
          ['unsupportedUsage', 'stat -c', 'darwin'],
        ],
      ],
      [
        'stat -f %z file',
        [
          ['unsupportedCommand', 'stat', 'win32'],
          ['inconsistentBehavior', 'stat -f', 'linux'],
        ],
      ],
      [
        'find dist -printf "%p"',
        [
          ['unsupportedCommand', 'find', 'win32'],
          ['unsupportedUsage', 'find dist -printf', 'darwin'],
        ],
      ],
      [
        'ln -sr a b',
        [
          ['unsupportedCommand', 'ln', 'win32'],
          ['unsupportedUsage', 'ln -sr', 'darwin'],
        ],
      ],
      // macOS 15+ accepts `-w` too
      ['base64 -w 0 file', [['unsupportedCommand', 'base64', 'win32']]],
      ['sort -u file', [['unsupportedUsage', 'sort -u', 'win32']]],
      ['timeout /t 5', [['unsupportedUsage', 'timeout /t', 'darwin,linux']]],
      ['set -e && node x', [['unsupportedUsage', 'set -e', 'win32']]],
      [
        'set NODE_ENV=production&& node x',
        [['inconsistentBehavior', 'set NODE_ENV=production', 'darwin,linux']],
      ],
      ['echo -n done', [['inconsistentBehavior', 'echo -n', 'darwin,win32']]],
      [String.raw`echo -e "a\tb"`, [['inconsistentBehavior', 'echo -e', 'darwin,linux,win32']]],
      ['sed -n p f', [['unsupportedCommand', 'sed', 'win32']]],
      [
        'sed --in-place s/a/b/ f',
        [
          ['unsupportedCommand', 'sed', 'win32'],
          ['unsupportedUsage', 'sed --in-place', 'darwin'],
        ],
      ],
      [
        'grep --perl-regexp x f',
        [
          ['unsupportedCommand', 'grep', 'win32'],
          ['unsupportedUsage', 'grep --perl-regexp', 'darwin'],
        ],
      ],
      [
        'date --date=yesterday',
        [
          ['unsupportedCommand', 'date', 'win32'],
          ['unsupportedUsage', 'date --date=yesterday', 'darwin'],
        ],
      ],
      ['mkdir -m 755 dist', [['unsupportedUsage', 'mkdir -m', 'win32']]],
      ['rmdir dist', []],
      ['rmdir /q dist', [['unsupportedUsage', 'rmdir /q', 'darwin,linux']]],
      ['sort file', []],
      ['ln -s ../a b', [['unsupportedCommand', 'ln', 'win32']]],
      ['echo -n', [['inconsistentBehavior', 'echo -n', 'darwin,win32']]],
      ['echo -ne x', [['inconsistentBehavior', 'echo -ne', 'darwin,linux,win32']]],
      ['echo -x', []],
      ['timeout 10s node x', [['unsupportedCommand', 'timeout', 'darwin,win32']]],
      ['TIMEOUT /T 5', [['unsupportedUsage', 'TIMEOUT /T', 'darwin,linux']]],
      ['timeout /nobreak /t 10', [['unsupportedUsage', 'timeout /nobreak', 'darwin,linux']]],
      ['TIMEOUT /NOBREAK /T 10', [['unsupportedUsage', 'TIMEOUT /NOBREAK', 'darwin,linux']]],
      // GNU `timeout` fails without a command, unlike cmd.exe's
      ['timeout 5', [['unsupportedUsage', 'timeout 5', 'darwin,linux']]],
      [
        'timeout 5 > nul',
        [
          ['unsupportedUsage', 'timeout 5', 'darwin,linux'],
          ['inconsistentBehavior', 'nul', 'darwin,linux'],
        ],
      ],
      ['timeout -s KILL 5', [['unsupportedUsage', 'timeout -s KILL 5', 'darwin,linux']]],
      ['exit /b 1', [['unsupportedUsage', 'exit /b', 'darwin,linux']]],
      ['exit 1', []],
    ])('%s', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it('only considers options before --', () => {
      expect(summarize('rm -- --recursive')).toStrictEqual([['unsupportedCommand', 'rm', 'win32']]);
    });

    it('explains the report of `timeout` without a command', () => {
      expect(analyzeScript('timeout 5')[0]?.data).toStrictEqual({
        reason: "only Windows' `timeout` works without a command",
        suggestion: 'Use a Node.js script instead.',
        usage: 'timeout 5',
      });
    });
  });

  describe('syntax of POSIX shells', () => {
    it.each<[string, Summary[]]>([
      [
        'NODE_ENV=production node server.js',
        [['unsupportedSyntax', 'NODE_ENV=production', 'win32']],
      ],
      ['FOO=bar', [['unsupportedSyntax', 'FOO=bar', 'win32']]],
      [
        'echo $npm_package_version ${npm_package_name} ${A:-b} ${#A}',
        [
          ['unsupportedSyntax', '$npm_package_version', 'win32'],
          ['unsupportedSyntax', '${npm_package_name}', 'win32'],
          ['unsupportedSyntax', '${A:-b}', 'win32'],
          ['unsupportedSyntax', '${#A}', 'win32'],
        ],
      ],
      ['node -e "console.log($HOME)"', [['unsupportedSyntax', '$HOME', 'win32']]],
      [
        'echo $(git rev-parse HEAD) `date`',
        [
          ['unsupportedSyntax', '$(git rev-parse HEAD)', 'win32'],
          ['unsupportedSyntax', '`date`', 'win32'],
        ],
      ],
      ['echo $((1 + 2))', [['unsupportedSyntax', '$((1 + 2))', 'win32']]],
      ["prettier --write '**/*.md'", [['inconsistentBehavior', "'**/*.md'", 'win32']]],
      ['tsc; vite build', [['unsupportedSyntax', ';', 'win32']]],
      ['tsc;', [['unsupportedSyntax', ';', 'win32']]],
      ['tsc\nvite build', [['unsupportedSyntax', '\n', 'win32']]],
      ['npm run a & npm run b', [['inconsistentBehavior', '&', 'win32']]],
      [
        '! grep x file',
        [
          ['unsupportedSyntax', '!', 'win32'],
          ['unsupportedCommand', 'grep', 'win32'],
        ],
      ],
      ['time node x', [['unsupportedSyntax', 'time', 'win32']]],
      ['{ tsc && vite build; }', [['unsupportedSyntax', '{', 'win32']]],
      ['if [ -f x ]; then rm x; fi', [['unsupportedSyntax', 'if', 'win32']]],
      ['for f in a b; do node $f; done', [['unsupportedSyntax', 'for', 'win32']]],
      ['while true; do node x; done', [['unsupportedSyntax', 'while', 'win32']]],
      ['until node x; do sleep 1; done', [['unsupportedSyntax', 'until', 'win32']]],
      ['case $1 in a) node a;; esac', [['unsupportedSyntax', 'case', 'win32']]],
      [
        'build() { tsc; }; build',
        [
          ['unsupportedSyntax', 'build', 'win32'],
          ['unsupportedSyntax', ';', 'win32'],
        ],
      ],
      [
        'cat <<EOF\nx\nEOF',
        [
          ['unsupportedCommand', 'cat', 'win32'],
          ['unsupportedSyntax', '<<EOF', 'win32'],
        ],
      ],
      // Without a closing line, the body ends with the script
      [
        'cat <<EOF\na; b # c',
        [
          ['unsupportedCommand', 'cat', 'win32'],
          ['unsupportedSyntax', '<<EOF', 'win32'],
        ],
      ],
      [
        'cat <<EOF\na; b # c\nEOF ',
        [
          ['unsupportedCommand', 'cat', 'win32'],
          ['unsupportedSyntax', '<<EOF', 'win32'],
        ],
      ],
      ['node x >| out.log', [['unsupportedSyntax', '>| out.log', 'win32']]],
      ['node x > /dev/null 2>&1', [['unsupportedSyntax', '/dev/null', 'win32']]],
      ['node x --out-dir=/tmp/build', []],
      // Paths in a container or on a remote host
      [
        'docker run -v "$PWD:/var/app" image /bin/bash -c "npm test"',
        [['unsupportedSyntax', '$PWD', 'win32']],
      ],
      ['ssh host /usr/local/bin/deploy', []],
      ['node ~/scripts/x.js', [['unsupportedSyntax', '~/scripts/x.js', 'win32']]],
      [
        '(cd packages/a && npm test) && npm run b',
        [['inconsistentBehavior', '(cd packages/a && npm test)', 'win32']],
      ],
      ['npm test && (cd packages/a && npm test)', []],
      // A redirection isn't a command that follows
      ['(cd packages/a && npm test) > log', []],
      [
        '(cd packages/a && npm test) > log && npm run b',
        [['inconsistentBehavior', '(cd packages/a && npm test)', 'win32']],
      ],
      // Nor are `;` and a comment
      ['(cd a && b);', [['unsupportedSyntax', ';', 'win32']]],
      ['(cd a && b) # done', [['unsupportedSyntax', '# done', 'win32']]],
      [
        '(cd a && b); c',
        [
          ['inconsistentBehavior', '(cd a && b)', 'win32'],
          ['unsupportedSyntax', ';', 'win32'],
        ],
      ],
      ['(tsc;)', [['unsupportedSyntax', ';', 'win32']]],
      // Not the `function` keyword
      ['function_a() { tsc; }', [['unsupportedSyntax', 'function_a', 'win32']]],
    ])('%s', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('syntax specific to Bash', () => {
    it.each<[string, Summary[]]>([
      ['[[ -f x ]] && node x', [['unsupportedSyntax', '[[ -f x ]]', 'linux,win32']]],
      ['(( i++ ))', [['unsupportedSyntax', '(( i++ ))', 'linux,win32']]],
      [
        'cp a.{js,map} dist',
        [
          ['unsupportedCommand', 'cp', 'win32'],
          ['unsupportedSyntax', '{js,map}', 'linux,win32'],
        ],
      ],
      [String.raw`echo $'a\tb'`, [['unsupportedSyntax', String.raw`$'a\tb'`, 'linux,win32']]],
      ['echo $"hello"', [['unsupportedSyntax', '$"hello"', 'linux,win32']]],
      [
        'diff <(a) <(b)',
        [
          ['unsupportedCommand', 'diff', 'win32'],
          // Bash's POSIX mode (macOS' `sh`) doesn't support it either
          ['unsupportedSyntax', '<(a)', 'darwin,linux,win32'],
          ['unsupportedSyntax', '<(b)', 'darwin,linux,win32'],
        ],
      ],
      // Bash 4 syntax, which macOS' Bash 3.2 doesn't support
      ['node x |& tee-cli log', [['unsupportedSyntax', '|&', 'darwin,linux,win32']]],
      ['node x &> log', [['unsupportedSyntax', '&> log', 'linux,win32']]],
      ['node <<< "x"', [['unsupportedSyntax', '<<< "x"', 'linux,win32']]],
      ['x=(1 2)', [['unsupportedSyntax', 'x=(1 2)', 'linux,win32']]],
      [
        'echo ${x[0]} ${y//a/b} ${z:0:1} ${!w} ${v^^}',
        [
          ['unsupportedSyntax', '${x[0]}', 'linux,win32'],
          ['unsupportedSyntax', '${y//a/b}', 'linux,win32'],
          ['unsupportedSyntax', '${z:0:1}', 'linux,win32'],
          ['unsupportedSyntax', '${!w}', 'linux,win32'],
          ['unsupportedSyntax', '${v^^}', 'darwin,linux,win32'],
        ],
      ],
      ['function build { tsc; }', [['unsupportedSyntax', 'function build', 'linux,win32']]],
      ['select x in a b; do node $x; done', [['unsupportedSyntax', 'select', 'linux,win32']]],
      ['for ((i = 0; i < 3; i++)); do node x; done', [['unsupportedSyntax', 'for', 'linux,win32']]],
      ['coproc node x', [['unsupportedSyntax', 'coproc', 'darwin,linux,win32']]],
      [
        'exec {fd}>log',
        [
          ['unsupportedCommand', 'exec', 'win32'],
          ['unsupportedSyntax', '{fd}', 'darwin,linux,win32'],
        ],
      ],
      ['eslint @(src|test)', [['unsupportedSyntax', '@(src|test)', 'darwin,linux,win32']]],
      [
        'sh -c "case $x in @(a|b)) echo 1;; esac"',
        [
          ['unsupportedCommand', 'sh', 'win32'],
          ['unsupportedSyntax', '@(a|b)', 'darwin,linux'],
        ],
      ],
      [
        "bash -O extglob -c 'case $x in @(a|b)) echo 1;; esac'",
        [['unsupportedCommand', 'bash', 'win32']],
      ],
      // Patterns rather than file globs
      ['case $x in *.js|a|[ab]*) echo 1;; esac', [['unsupportedSyntax', 'case', 'win32']]],
    ])('%s', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('globs', () => {
    it.each<[string, Summary[]]>([
      ['eslint src/**/*.ts', [['inconsistentBehavior', 'src/**/*.ts', 'darwin,linux,win32']]],
      [
        'mocha test/**/*.spec.js --recursive',
        [['inconsistentBehavior', 'test/**/*.spec.js', 'darwin,linux,win32']],
      ],
      [
        'node --import tsx --test test/**/*.test.ts',
        [['inconsistentBehavior', 'test/**/*.test.ts', 'darwin,linux,win32']],
      ],
      [
        'eslint ./src/**/*.{ts,js}',
        [['inconsistentBehavior', './src/**/*.{ts,js}', 'darwin,linux,win32']],
      ],
      [
        'eslint src/**/*.ts test/**/*.ts',
        [
          ['inconsistentBehavior', 'src/**/*.ts', 'darwin,linux,win32'],
          ['inconsistentBehavior', 'test/**/*.ts', 'darwin,linux,win32'],
        ],
      ],
      // Many tools expand single-level globs themselves when the shell doesn't (e.g. cmd.exe)
      ['node --test test/*.test.js', []],
      ['prettier --write src/*.ts', []],
      ['rm -rf dist/*', [['unsupportedCommand', 'rm', 'win32']]],
      ['mocha test/?.js test/[ab].js', []],
      // `**` that isn't a whole path segment is just `*`
      ['documentation lint ./src**/*.mjs', []],
      ['eslint **/*.ts', [['inconsistentBehavior', '**/*.ts', 'darwin,linux,win32']]],
      // A trailing `**` matches the same top-level entries as `*`
      ['eslint src/**', []],
      ['eslint --ext .ts src/** test/**', []],
      // Patterns in option or assignment values can't match files, so they're passed on literally
      ['node --test --test-coverage-include=lib/** test', []],
      ['jest --collectCoverageFrom=src/**/*.js', []],
      ['cross-env DEBUG=app:**/* mocha', []],
      ['tsc --rootDir=src/*', []],
      // Quoted globs are left to the tool
      ['eslint "src/**/*.ts"', []],
      ["eslint 'src/**/*.ts'", [['inconsistentBehavior', "'src/**/*.ts'", 'win32']]],
      // cmd.exe passes the backslashes on
      [
        String.raw`eslint src/\*\*/\*.ts`,
        [['inconsistentBehavior', String.raw`src/\*\*/\*.ts`, 'win32']],
      ],
      // Braces in a glob are expanded by the tool when the shell doesn't
      ['eslint lib/{compile/,}*.js', []],
      [
        'cp a.{js,map} dist',
        [
          ['unsupportedCommand', 'cp', 'win32'],
          ['unsupportedSyntax', '{js,map}', 'linux,win32'],
        ],
      ],
      // Not globs
      ['node x > out-*.log', []],
      [
        '[[ $f == *.js ]] && node $f',
        [
          ['unsupportedSyntax', '[[ $f == *.js ]]', 'linux,win32'],
          ['unsupportedSyntax', '$f', 'win32'],
        ],
      ],
    ])('%s', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('syntax of Windows', () => {
    it.each<[string, Summary[]]>([
      [
        String.raw`node scripts\build.js`,
        [['inconsistentBehavior', String.raw`scripts\build.js`, 'darwin,linux']],
      ],
      [
        String.raw`.\node_modules\.bin\tsc`,
        [['inconsistentBehavior', String.raw`.\node_modules\.bin\tsc`, 'darwin,linux']],
      ],
      [
        String.raw`node "dist\cli\index"`,
        [['inconsistentBehavior', String.raw`"dist\cli\index"`, 'darwin,linux']],
      ],
      // It may be a regex or a path like `src\sub\dir`
      [
        String.raw`jest -t "adds\stwo\snumbers"`,
        [['inconsistentBehavior', String.raw`"adds\stwo\snumbers"`, 'darwin,linux']],
      ],
      [String.raw`grep "a\.b" file`, [['unsupportedCommand', 'grep', 'win32']]],
      [String.raw`echo "done\n"`, []],
      ['node x.js %PORT%', [['unsupportedSyntax', '%PORT%', 'darwin,linux']]],
      // One-letter names are mostly parts of format strings
      ['git log --pretty=%s%n', []],
      ['date +%Y%m%d', [['unsupportedCommand', 'date', 'win32']]],
      ['node x 2>nul', [['inconsistentBehavior', 'nul', 'darwin,linux']]],
      ['if exist dist rd /s /q dist', [['unsupportedSyntax', 'if exist', 'darwin,linux']]],
      ['for %f in (*.js) do node %f', [['unsupportedSyntax', 'for %f', 'darwin,linux']]],
      [
        'set "NODE_ENV=production" && node x',
        [['inconsistentBehavior', 'set "NODE_ENV=production"', 'darwin,linux']],
      ],
      ['set', []],
      ['set +x', [['unsupportedUsage', 'set +x', 'win32']]],
      ['more a.{js,map}', [['unsupportedSyntax', '{js,map}', 'linux,win32']]],
      [
        'copy /y a b && move a b && ren a b',
        [
          ['unsupportedCommand', 'copy', 'darwin,linux'],
          ['unsupportedCommand', 'move', 'darwin,linux'],
          ['unsupportedCommand', 'ren', 'darwin,linux'],
        ],
      ],
      ['if not exist dist mkdir dist', [['unsupportedSyntax', 'if not exist', 'darwin,linux']]],
      ['if "%CI%"=="true" echo x', [['unsupportedSyntax', 'if "%CI%"=="true"', 'darwin,linux']]],
      ['if "a b"=="c" echo x', [['unsupportedSyntax', 'if "a b"=="c"', 'darwin,linux']]],
      ['if /i not %A% == b echo x', [['unsupportedSyntax', 'if /i not %A% == b', 'darwin,linux']]],
      [
        'IF %ERRORLEVEL% NEQ 0 exit 1',
        [['unsupportedSyntax', 'IF %ERRORLEVEL% NEQ 0', 'darwin,linux']],
      ],
      // POSIX shells parse them as commands
      ['IF EXIST dist rd /s /q dist', [['unsupportedSyntax', 'IF EXIST', 'darwin,linux']]],
      ['IF NOT EXIST dist mkdir dist', [['unsupportedSyntax', 'IF NOT EXIST', 'darwin,linux']]],
      ['If Exist dist del /q dist', [['unsupportedSyntax', 'If Exist', 'darwin,linux']]],
      [
        String.raw`IF EXIST .\dist RMDIR /Q /S .\dist`,
        [['unsupportedSyntax', 'IF EXIST', 'darwin,linux']],
      ],
      ['IF x', []],
      [
        'echo %CD% %npm_package_version%',
        [
          ['unsupportedSyntax', '%CD%', 'darwin,linux'],
          ['unsupportedSyntax', '%npm_package_version%', 'darwin,linux'],
        ],
      ],
      ['printf "%s%n%" x', [['unsupportedCommand', 'printf', 'win32']]],
      // Percent-encoded bytes rather than variables
      ['open-cli http://localhost:3000/?name=J%C3%BCrgen', []],
      ['open-cli http://localhost/%C3%A9', []],
      [
        'open-cli "http://localhost/?a=%C3%A9&p=%PORT%"',
        [['unsupportedSyntax', '"http://localhost/?a=%C3%A9&p=%PORT%"', 'darwin,linux']],
      ],
      ['cmd /c "rd /s /q dist"', [['unsupportedCommand', 'cmd', 'darwin,linux']]],
      [
        String.raw`node .\scripts\build.js`,
        [['inconsistentBehavior', String.raw`.\scripts\build.js`, 'darwin,linux']],
      ],
      [
        String.raw`node --config=configs\app.json`,
        [['inconsistentBehavior', String.raw`--config=configs\app.json`, 'darwin,linux']],
      ],
      [
        String.raw`tslint .\lib\**`,
        [['inconsistentBehavior', String.raw`.\lib\**`, 'darwin,linux']],
      ],
      [String.raw`uvu test/ .*\.mjs`, []],
      [String.raw`del /q dist\*`, [['unsupportedCommand', 'del', 'darwin,linux']]],
    ])('%s', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it.each<[string, string]>([
      [
        String.raw`jest --testPathIgnorePatterns "\\.e2e\\."`,
        'Use a single backslash in double quotes (e.g. `"\\."`) instead.',
      ],
      [String.raw`node x \$a`, 'Use escaped double quotes (`\\"`) instead.'],
    ])('suggests how to replace the backslashes in %j', (script, suggestion) => {
      expect(analyzeScript(script)[0]?.data.suggestion).toBe(suggestion);
    });

    it('shows the text of `set` as the script has it', () => {
      expect(analyzeScript(String.raw`set OUT=dist\app\x.js`)[0]?.data.syntax).toBe(
        String.raw`${'`'}set OUT=dist\app\x.js${'`'}`,
      );
    });
  });

  describe('nested commands', () => {
    it.each<[string, Summary[]]>([
      ['cross-env NODE_ENV=production rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      ['cross-env-shell "echo $FOO && rm x"', [['unsupportedCommand', 'rm', 'win32']]],
      // A variable with an expansion in its value isn't the command
      ['cross-env A=$B rm -rf x', [['unsupportedCommand', 'rm', 'win32']]],
      // It joins its arguments into a single script
      ['cross-env-shell npm install x', []],
      ['cross-env-shell rm -rf $DIR', [['unsupportedCommand', 'rm -rf $DIR', 'win32']]],
      // It expands globs of script names itself
      ['concurrently "npm run watch:*(!css)" "npm:build"', []],
      ['concurrently "npm run a:*(!x) && npm run b:*(!y)" "z w"', []],
      [
        'concurrently "npm run test:*(!e2e) && rm -rf tmp"',
        [['unsupportedCommand', 'rm', 'win32']],
      ],
      ['env NODE_ENV=production rm -rf dist', [['unsupportedCommand', 'env', 'win32']]],
      [
        'env -u HOME open x',
        [
          ['unsupportedCommand', 'env', 'win32'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      [
        'xargs -n 1 open < urls.txt',
        [
          ['unsupportedCommand', 'xargs', 'win32'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      [
        'nohup sed -i x f',
        [
          ['unsupportedCommand', 'nohup', 'win32'],
          ['unsupportedUsage', 'sed -i', 'darwin'],
        ],
      ],
      // Third-party tools that run commands aren't followed (they'd each need their options listed)
      ['onchange "src/**" -- rm -rf dist', []],
      ['dotenv -e .env -- rm -rf dist', []],
      [
        'concurrently "rm -rf dist" "NODE_ENV=dev vite"',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedSyntax', 'NODE_ENV=dev', 'win32'],
        ],
      ],
      [
        'concurrently \'tsc -w\' --teardown "rm -rf tmp"',
        [
          ['inconsistentBehavior', "'tsc -w'", 'win32'],
          ['unsupportedCommand', 'rm', 'win32'],
        ],
      ],
      [
        String.raw`concurrently "echo \$HOME"`,
        [
          ['unsupportedSyntax', String.raw`"echo \$HOME"`, 'win32'],
          ['inconsistentBehavior', String.raw`"echo \$HOME"`, 'win32'],
        ],
      ],
      ['nodemon --exec "NODE_ENV=dev node x"', []],
      ['chokidar "src" -c "rm -rf dist"', []],
      ['npx -c "rm -rf dist"', [['unsupportedCommand', 'rm', 'win32']]],
      ['npm exec -c "rm -rf dist"', [['unsupportedCommand', 'rm', 'win32']]],
      ['c8 mocha ./test/*.mjs', []],
      ['c8 --reporter lcov rm -rf dist', []],
      ['nyc --reporter=lcov mocha test/*.js', []],
      ['env-cmd -e version run-s update:*', []],
      ['npx rimraf dist/* && npx -y rm -rf tmp', [['unsupportedCommand', 'rm', 'win32']]],
      ['pnpm -r exec rm -rf node_modules', [['unsupportedCommand', 'rm', 'win32']]],
      ['pnpm --filter app exec rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      ['yarn dlx rimraf dist/* && bun x rm -rf tmp', [['unsupportedCommand', 'rm', 'win32']]],
      ['npm exec -- rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      // Package specs, not paths
      ['bunx @stacksjs/logsmith --verbose && npx github:user/repo', []], // cspell:disable-line
      ['pnpm rm lodash && npm run build', []],
      [
        'sh -c "export A=1 && [[ -f a ]] && open x"',
        [
          ['unsupportedCommand', 'sh', 'win32'],
          ['unsupportedSyntax', '[[ -f a ]]', 'linux'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      [
        'bash -ec "source .env && [[ -f a ]] && open x"',
        [
          ['unsupportedCommand', 'bash', 'win32'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      // Options continue after `-c`
      [
        'sh -c -e "[[ -f x ]]"',
        [
          ['unsupportedCommand', 'sh', 'win32'],
          ['unsupportedSyntax', '[[ -f x ]]', 'linux'],
        ],
      ],
      [
        'bash -c -o pipefail "a |& b"',
        [
          ['unsupportedCommand', 'bash', 'win32'],
          ['unsupportedSyntax', '|&', 'darwin'],
        ],
      ],
      // But not after the script file
      ['sh build.sh -c "open x"', [['unsupportedCommand', 'sh', 'win32']]],
      [
        'echo $(sed -i s/a/b/ f)',
        [
          ['unsupportedSyntax', '$(sed -i s/a/b/ f)', 'win32'],
          ['unsupportedUsage', 'sed -i', 'darwin'],
        ],
      ],
      [
        'echo `echo \\`sed -i x f\\``',
        [
          ['unsupportedSyntax', '`echo \\`sed -i x f\\``', 'win32'],
          ['unsupportedUsage', '`echo \\`sed -i x f\\``', 'darwin'],
        ],
      ],
    ])('%s', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it.each(['cross-env-shell ', 'pnpm exec -c '])(
      "doesn't analyze scripts nested too deeply in %j",
      (command) => {
        expect(summarize(`${command.repeat(10)}rm -rf dist`)).toStrictEqual([
          ['unsupportedCommand', `${command.repeat(9)}rm -rf dist`, 'win32'],
        ]);
        expect(summarize(`${command.repeat(800)}rm -rf dist`)).toStrictEqual([]);
      },
    );
  });

  describe('exec commands of package managers', () => {
    it.each<[string, Summary[]]>([
      ['aube exec rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      ['aube dlx rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      ['aubx rimraf dist && aubx -p foo rm -rf tmp', [['unsupportedCommand', 'rm', 'win32']]],
      ['aube --cd app --filter-prod web exec rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      ['upm exec rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      ['upm --dir app exec rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      ['upx rm -rf tmp', [['unsupportedCommand', 'rm', 'win32']]],
      // Scripts run by name
      ['aube run clean && aubr build && upm run build', []], // cspell:disable-line
      // npm's and upm's `-c` takes a shell line
      ['upm exec -p del-cli -c "rm x"', [['unsupportedCommand', 'rm', 'win32']]],
      ['upx -c "open x"', [['unsupportedCommand', 'open', 'linux,win32']]],
      // pnpm's and aube's `-c` runs the command and its arguments as a shell line
      [
        'aube exec -c "rm -rf x && open y"',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedCommand', 'open', 'linux,win32'],
        ],
      ],
      ['pnpm exec -c "rm -rf x"', [['unsupportedCommand', 'rm', 'win32']]],
      ['pnpm dlx --shell-mode "rm -rf x"', [['unsupportedCommand', 'rm', 'win32']]],
      ['aubx -c rm -rf tmp', [['unsupportedCommand', 'rm -rf tmp', 'win32']]],
      // pnpm also takes it before `exec`, and in clusters
      ['pnpm -c exec "rm -rf x"', [['unsupportedCommand', 'rm', 'win32']]],
      ['pnpm -rc exec "rm -rf x"', [['unsupportedCommand', 'rm', 'win32']]],
      ['pnpm --filter app --shell-mode exec "rm -rf x"', [['unsupportedCommand', 'rm', 'win32']]],
      ['pnpm -r exec -cr "rm -rf x"', [['unsupportedCommand', 'rm', 'win32']]],
      // npm's `-w` and `--workspace` take a value
      ['npm exec -w pkg -- rm -rf x', [['unsupportedCommand', 'rm', 'win32']]],
      ['npm exec --workspace pkg -- rm -rf x', [['unsupportedCommand', 'rm', 'win32']]],
      ['npm -w pkg exec rm -rf x', [['unsupportedCommand', 'rm', 'win32']]],
      ['npm x -w pkg rm -rf x', [['unsupportedCommand', 'rm', 'win32']]],
      ['npx --workspace pkg rm -rf x', [['unsupportedCommand', 'rm', 'win32']]],
      ['npm exec -w pkg -c "rm -rf x"', [['unsupportedCommand', 'rm', 'win32']]],
      // pnpm's `-w` doesn't
      ['pnpm -w exec rm -rf x', [['unsupportedCommand', 'rm', 'win32']]],
    ])('%s', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('portable shell', () => {
    it.each<[string, Summary[]]>([
      ['NODE_ENV=production node x; echo $FOO > /dev/null', []],
      ["prettier '**/*.md' src/**/*.ts && node x &", []],
      ['true && sleep 1 && cd x && pwd && echo -n x', []],
      [
        'rm -rf dist && mkdir dist',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedCommand', 'mkdir', 'win32'],
        ],
      ],
      ['del dist', [['unsupportedCommand', 'del', 'darwin,linux,win32']]],
      // GNU coreutils ship `dir`
      ['dir', [['unsupportedCommand', 'dir', 'darwin,win32']]],
      ['if true; then node x; fi', [['unsupportedSyntax', 'if', 'darwin,linux,win32']]],
      ['echo `date`', [['unsupportedSyntax', '`date`', 'darwin,linux,win32']]],
      ['echo ${A#b}', [['unsupportedSyntax', '${A#b}', 'darwin,linux,win32']]],
      // Yarn's shell only expands braces to the names of files that exist
      [
        'eslint {src,test}/**/*.js && cp a.{js,map} dist',
        [
          ['unsupportedCommand', 'cp', 'win32'],
          ['inconsistentBehavior', '{js,map}', 'darwin,linux,win32'],
        ],
      ],
      [
        'mkdir -p dist/{esm,cjs}',
        [
          ['unsupportedCommand', 'mkdir', 'win32'],
          ['inconsistentBehavior', '{esm,cjs}', 'darwin,linux,win32'],
        ],
      ],
      // Builtins that Yarn's shell doesn't have, and that have no executables
      ['export A=1 && jest', [['unsupportedCommand', 'export', 'darwin,linux,win32']]],
      ['set -e', [['unsupportedCommand', 'set', 'darwin,linux,win32']]],
      ['SET A=1', [['unsupportedCommand', 'SET', 'darwin,linux,win32']]],
      ['eval "x"', [['unsupportedCommand', 'eval', 'darwin,linux,win32']]],
      ['. ./env.sh', [['unsupportedCommand', '.', 'darwin,linux,win32']]],
      ['source x', [['unsupportedCommand', 'source', 'darwin,linux,win32']]],
      ['pushd a', [['unsupportedCommand', 'pushd', 'darwin,linux,win32']]],
      // They have executables on macOS and Linux
      [
        '[ -d a ] && test -f b',
        [
          ['unsupportedCommand', '[', 'win32'],
          ['unsupportedCommand', 'test', 'win32'],
        ],
      ],
      // Yarn's shell only sets `$RANDOM` of the Bash variables
      [
        'node x $UID ${SECONDS} $RANDOM',
        [
          ['inconsistentBehavior', '$UID', 'darwin,linux,win32'],
          ['inconsistentBehavior', '${SECONDS}', 'darwin,linux,win32'],
        ],
      ],
      // But it supports defaults
      ['node x ${UID:-0} ${SECONDS:+x}', []],
      // With a glob, the braces are part of it
      ['cp src/{a,b}/*.js dist', [['unsupportedCommand', 'cp', 'win32']]],
      [
        String.raw`node scripts\build.js`,
        [['inconsistentBehavior', String.raw`scripts\build.js`, 'darwin,linux,win32']],
      ],
      // Commands like `concurrently` run their arguments with the system shell
      ['concurrently "NODE_ENV=dev vite"', [['unsupportedSyntax', 'NODE_ENV=dev', 'win32']]],
      // Commands that other commands start don't run in Yarn's shell, e.g. its builtins
      ['cross-env A=1 sleep 5', [['unsupportedCommand', 'sleep', 'win32']]],
      ['npx mkdir -p dist', [['unsupportedUsage', 'mkdir -p', 'win32']]],
      ['cross-env A=1 del dist', [['unsupportedCommand', 'del', 'darwin,linux']]],
      // Yarn's shell doesn't support comments
      [
        '{ node x # c\n}',
        [
          ['unsupportedSyntax', '# c', 'darwin,linux,win32'],
          ['unsupportedSyntax', '\n', 'darwin,linux,win32'],
        ],
      ],
    ])('%s', (script, expected) => {
      expect(summarize(script, yarn)).toStrictEqual(expected);
    });

    it.each<[string, FixSummary[]]>([
      [
        'export A=1 && jest',
        [['export', 'Replace `export ... &&` with `cross-env`.', 'cross-env A=1 jest']],
      ],
      // Yarn's shell doesn't have `.` either
      ['source .env && tsc', []],
      [
        'cp a.{js,map} dist',
        [['{js,map}', 'Replace `a.{js,map}` with `a.js a.map`.', 'cp a.js a.map dist']],
      ],
    ])('only keeps the fixes that work there in %j', (script, expected) => {
      expect(summarizeFixes(script, yarn)).toStrictEqual(expected);
    });

    it.each<[string, Record<string, string>]>([
      ['pushd a', {command: 'pushd', suggestion: 'Use a Node.js script instead.'}],
      ['set A=1', {command: 'set', suggestion: 'Use `cross-env` instead.'}],
      ['type a.txt', {command: 'type', suggestion: 'Use a Node.js script instead.'}],
      [
        'echo $UID',
        {
          reason: "Yarn's shell doesn't set it, so the script fails",
          suggestion: 'Use a Node.js script instead.',
          syntax: 'The Bash variable `$UID`',
        },
      ],
      [
        'mkdir -p dist/{esm,cjs}',
        {
          reason: "Yarn's shell only expands it to the names of files that exist",
          suggestion: 'List the alternatives explicitly instead.',
          syntax: 'The brace expansion `{esm,cjs}`',
        },
      ],
    ])('explains the report of %j', (script, data) => {
      expect(analyzeScript(script, yarn).at(-1)?.data).toStrictEqual(data);
    });
  });

  describe('parsing edge cases', () => {
    it.each<[string, Summary[]]>([
      ['', []],
      [' '.repeat(3), []],
      ['> out.txt', []],
      ['node x # rm -rf y', [['unsupportedSyntax', '# rm -rf y', 'win32']]],
      ['# set up\nnode y', [['unsupportedSyntax', '# set up', 'win32']]],
      [
        'node x;# comment',
        [
          ['unsupportedSyntax', ';', 'win32'],
          ['unsupportedSyntax', '# comment', 'win32'],
        ],
      ],
      [
        'a\n# c1\n# c2\nb',
        [
          ['unsupportedSyntax', '\n', 'win32'],
          ['unsupportedSyntax', '# c1', 'win32'],
          ['unsupportedSyntax', '# c2', 'win32'],
        ],
      ],
      ['node "a#b" a#b', []],
      ['git log --format=%H#%s', []],
      // A `;` in a comment doesn't separate commands
      ['tsc # a; b', [['unsupportedSyntax', '# a; b', 'win32']]],
      // Neither does one in a here-document, which doesn't contain comments either
      [
        "cat > x << 'EOF'\na; b # c\nEOF\necho done",
        [
          ['unsupportedCommand', 'cat', 'win32'],
          ['unsupportedSyntax', "<< 'EOF'", 'win32'],
          ['unsupportedSyntax', '\n', 'win32'],
        ],
      ],
      ['"rm" -rf dist', [['unsupportedCommand', '"rm"', 'win32']]],
      [
        "'rm' -rf dist",
        [
          ['unsupportedCommand', "'rm'", 'win32'],
          ['inconsistentBehavior', "'rm'", 'win32'],
        ],
      ],
      ['$CMD --flag', [['unsupportedSyntax', '$CMD', 'win32']]],
      ['"$npm_execpath" run build', [['unsupportedSyntax', '$npm_execpath', 'win32']]],
      ['Rm -rf x', [['unsupportedCommand', 'Rm', 'linux,win32']]],
      ['DEL x', [['unsupportedCommand', 'DEL', 'darwin,linux']]],
      ['echo 😀 && rm x', [['unsupportedCommand', 'rm', 'win32']]],
      [
        'echo $# $@ $1',
        [
          ['unsupportedSyntax', '$#', 'win32'],
          ['unsupportedSyntax', '$@', 'win32'],
          ['unsupportedSyntax', '$1', 'win32'],
        ],
      ],
      [String.raw`echo \$HOME`, [['inconsistentBehavior', String.raw`\$HOME`, 'win32']]],
      ['npm run build && npm test || echo failed', []],
      [
        'echo ~ ~user a~b ~/x',
        [
          ['unsupportedSyntax', '~', 'win32'],
          ['unsupportedSyntax', '~user', 'win32'],
          ['unsupportedSyntax', '~/x', 'win32'],
        ],
      ],
      // A version range rather than a tilde expansion
      ['semver -r ~1.2.3 1.2.4', []],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('expansions', () => {
    it.each<[string, Summary[]]>([
      ['echo "$(rm x)"', [['unsupportedSyntax', '$(rm x)', 'win32']]],
      [
        'echo $(echo $(open x))',
        [
          ['unsupportedSyntax', '$(echo $(open x))', 'win32'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      [
        'echo ${A:-$(sed -i x f)}',
        [
          ['unsupportedSyntax', '${A:-$(sed -i x f)}', 'win32'],
          ['unsupportedUsage', 'sed -i', 'darwin'],
        ],
      ],
      ['echo ${A/$(open x)/b}', [['unsupportedSyntax', '${A/$(open x)/b}', 'linux,win32']]],
      [
        'echo ${#A} ${A%.js} ${A##*/}',
        [
          ['unsupportedSyntax', '${#A}', 'win32'],
          ['unsupportedSyntax', '${A%.js}', 'win32'],
          ['unsupportedSyntax', '${A##*/}', 'win32'],
        ],
      ],
      ['echo $((1 + $(wc -l < f)))', [['unsupportedSyntax', '$((1 + $(wc -l < f)))', 'win32']]],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('nested script positions', () => {
    it.each<[string, Summary[]]>([
      [
        'concurrently "rm x" "open y"',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedCommand', 'open', 'linux,win32'],
        ],
      ],
      [
        "concurrently 'rm x'",
        [
          ['inconsistentBehavior', "'rm x'", 'win32'],
          ['unsupportedCommand', 'rm', 'win32'],
        ],
      ],
      // Only quoted, multi-word arguments are assumed to be commands
      ['concurrently rm "tsc -w" --names "a b"', []],
      // The outer shell expands `$HOME`, so the nested script doesn't see it
      [String.raw`concurrently "echo \"$HOME\""`, [['unsupportedSyntax', '$HOME', 'win32']]],
      [
        "concurrently 'echo $HOME'",
        [
          ['inconsistentBehavior', "'echo $HOME'", 'win32'],
          ['unsupportedSyntax', '$HOME', 'win32'],
        ],
      ],
      // With escapes, positions can't be mapped, so the whole argument is reported
      [
        String.raw`concurrently "echo \"x\" && rm y"`,
        [['unsupportedCommand', String.raw`"echo \"x\" && rm y"`, 'win32']],
      ],
      // cmd.exe splits the word at the space
      [String.raw`concurrently a\ b`, [['inconsistentBehavior', String.raw`a\ b`, 'win32']]],
      [
        'sh -c "rm x; open y"',
        [
          ['unsupportedCommand', 'sh', 'win32'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      ["sh -c 'cd x && rm -rf y'", [['unsupportedCommand', 'sh', 'win32']]],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  // The outer shell expands them, so their values aren't known to the nested script
  describe('expansions of the outer shell in nested scripts', () => {
    it.each<[string, Summary[]]>([
      ['sh -c ". $FILE"', [['unsupportedCommand', 'sh', 'win32']]],
      [
        'concurrently "node_modules/.bin/$TOOL --watch" "tsc -w"',
        [['unsupportedSyntax', '$TOOL', 'win32']],
      ],
      [
        String.raw`concurrently "tool $DIR\src\file.js --watch"`,
        [['unsupportedSyntax', '$DIR', 'win32']],
      ],
      ['npx -c "node_modules/.bin/$TOOL --watch"', [['unsupportedSyntax', '$TOOL', 'win32']]],
    ])('are reported like expansions in %j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it.each<[string, FixSummary[]]>([
      [
        'sh -c "node x.js &> $OUT"',
        [['&> $OUT', 'Replace `&> $OUT` with `> $OUT 2>&1`.', 'sh -c "node x.js > $OUT 2>&1"']],
      ],
      ['sh -c "cp $SRC/{a,b} dist"', []],
      ['sh -c "source $FILE"', []],
      ['concurrently "node_modules/.bin/$TOOL --watch" "tsc -w"', []],
      [String.raw`concurrently "tool $DIR\src\file.js --watch"`, []],
      ['concurrently "A=$X node y"', [['A=$X', CROSS_ENV, 'concurrently "cross-env A=$X node y"']]],
      [
        String.raw`concurrently "mocha --$X=test\unit\a.js"`,
        [
          [
            String.raw`--$X=test\unit\a.js`,
            String.raw`Replace ${'`'}--$X=test\unit\a.js${'`'} with ${'`'}--$X=test/unit/a.js${'`'}.`,
            'concurrently "mocha --$X=test/unit/a.js"',
          ],
        ],
      ],
    ])("doesn't insert placeholders in the fixes of %j", (script, expected) => {
      expect(summarizeFixes(script)).toStrictEqual(expected);
    });

    it.each<[string, string]>([
      ['concurrently "A=$X node y"', 'The inline environment variable assignment `A=$X`'],
      [`concurrently "grep '$P' f"`, "The single-quoted string `'$P'`"],
      ['sh -c "eslint $D/**/*.ts"', 'The unquoted glob `$D/**/*.ts`'],
      ['concurrently "ls ~/$D"', 'The tilde expansion `~/$D`'],
      ['concurrently "npm i a@^$V"', 'The caret in `a@^$V`'],
      ['concurrently "f$X() { a; }; f"', 'The shell function definition `f$X()`'],
      ['concurrently "cp {a,$B} c"', 'The Bash-specific brace expansion `{a,$B}`'],
      // With escapes, which make positions in the nested script differ
      [String.raw`concurrently "echo \"x\" \${A:-$B}"`, 'The variable expansion `${A:-$B}`'],
      // In backticks with escapes, which have a source of their own
      [String.raw`concurrently "echo \`cat \\\$c $D/**/*.ts\`"`, 'The unquoted glob `$D/**/*.ts`'],
    ])('shows the original text in the messages of %j', (script, syntax) => {
      expect(analyzeScript(script).map((issue) => issue.data.syntax)).toContain(syntax);
    });
  });

  // Linux finds commands by their exact name, unlike cmd.exe and macOS, where only some shell
  // builtins need it
  describe('names of OS commands in the wrong case', () => {
    it.each<[string, Summary[]]>([
      ['MKDIR dist', [['unsupportedCommand', 'MKDIR', 'linux']]],
      ['ECHO hi', [['unsupportedCommand', 'ECHO', 'linux']]],
      ['SORT a.txt', [['unsupportedCommand', 'SORT', 'linux']]],
      // macOS' `/usr/bin/cd` changes the directory of a child process
      ['CD src && node x', [['unsupportedCommand', 'CD', 'darwin,linux']]],
      [
        'Echo hi && MkDir dist',
        [
          ['unsupportedCommand', 'Echo', 'linux'],
          ['unsupportedCommand', 'MkDir', 'linux'],
        ],
      ],
      ['RM -rf dist', [['unsupportedCommand', 'RM', 'linux,win32']]],
      ['CAT a', [['unsupportedCommand', 'CAT', 'linux,win32']]],
      // macOS has no executables for these builtins
      ['EXPORT A=1', [['unsupportedCommand', 'EXPORT', 'darwin,linux,win32']]],
      ['PUSHD docs', [['unsupportedCommand', 'PUSHD', 'darwin,linux']]],
      ['DIR /b', [['unsupportedCommand', 'DIR', 'darwin,linux']]],
      [
        'EXIT 0 && Exit 1',
        [
          ['unsupportedCommand', 'EXIT', 'darwin,linux'],
          ['unsupportedCommand', 'Exit', 'darwin,linux'],
        ],
      ],
      ['tsc || EXIT 0', [['unsupportedCommand', 'EXIT', 'darwin,linux']]],
      // macOS has executables that work for these
      [
        'PWD && TRUE && Test -f x',
        [
          ['unsupportedCommand', 'PWD', 'linux,win32'],
          ['unsupportedCommand', 'TRUE', 'linux,win32'],
          ['unsupportedCommand', 'Test', 'linux,win32'],
        ],
      ],
      ['COMMAND -v node', [['unsupportedCommand', 'COMMAND', 'linux,win32']]],
      ['MORE x', [['unsupportedCommand', 'MORE', 'linux']]],
      ['EXIT /B 1', [['unsupportedUsage', 'EXIT /B', 'darwin,linux']]],
      // Not OS commands
      ['Xvfb :99 && R x && TSC', []],
      // Their usage tells more
      ['TIMEOUT /T 5', [['unsupportedUsage', 'TIMEOUT /T', 'darwin,linux']]],
      ['RMDIR /Q dist', [['unsupportedUsage', 'RMDIR /Q', 'darwin,linux']]],
      ['TIMEOUT 5 node x', [['unsupportedCommand', 'TIMEOUT', 'darwin,linux,win32']]],
      [
        'MKDIR -p dist',
        [
          ['unsupportedCommand', 'MKDIR', 'linux'],
          ['unsupportedUsage', 'MKDIR -p', 'win32'],
        ],
      ],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    // Its builtins only have their exact names, and Windows has no executables for them
    it.each<[string, Summary[]]>([
      ['ECHO hi', [['unsupportedCommand', 'ECHO', 'linux,win32']]],
      ['CD src', [['unsupportedCommand', 'CD', 'darwin,linux,win32']]],
      ['SLEEP 1', [['unsupportedCommand', 'SLEEP', 'linux,win32']]],
      ['EXIT 0', [['unsupportedCommand', 'EXIT', 'darwin,linux,win32']]],
      // It can't run cmd.exe's `mkdir` either
      ['MKDIR dist', [['unsupportedCommand', 'MKDIR', 'linux,win32']]],
      ['DIR', [['unsupportedCommand', 'DIR', 'darwin,linux,win32']]],
    ])("%j in Yarn's shell", (script, expected) => {
      expect(summarize(script, yarn)).toStrictEqual(expected);
    });

    it.each<[string, FixSummary[]]>([
      ['RM -rf dist', [['RM', 'Replace `RM -rf` with `rimraf`.', 'rimraf dist']]],
      ['MKDIR dist', [['MKDIR', 'Replace `MKDIR` with `mkdir`.', 'mkdir dist']]],
      ['CD src && node x', [['CD', 'Replace `CD` with `cd`.', 'cd src && node x']]],
      ['tsc || EXIT 0', [['EXIT', 'Replace `EXIT` with `exit`.', 'tsc || exit 0']]],
      // POSIX shells fail with `/b` in lower case too
      ['EXIT /B 1', []],
      // `echo` is a builtin of `sh`, but an executable on macOS, and `cat` isn't on Windows
      ['ECHO hi', []],
      ['CAT a', []],
      ['DIR /b', []],
    ])('fixes %j', (script, expected) => {
      expect(summarizeFixes(script)).toStrictEqual(expected);
    });

    it('suggests the lower case', () => {
      expect(analyzeScript('MKDIR dist')[0]?.data.suggestion).toBe(
        'Use `mkdir` in lower case instead.',
      );
    });
  });

  // The nested script is reported instead of the word that contains it
  describe('words of nested scripts', () => {
    const backslashPath = String.raw`--spec=test\unit\a.js`;

    it.each([
      `concurrently "mocha ${backslashPath}"`,
      `concurrently 'mocha ${backslashPath}'`,
      `sh -c "mocha ${backslashPath}"`,
      `bash -c 'mocha ${backslashPath}'`,
      `npx -c "mocha ${backslashPath}"`,
      `cross-env-shell "mocha ${backslashPath}"`,
      `pnpm exec -c "mocha ${backslashPath}"`,
    ])('reports a backslash path once in %j', (script) => {
      expect(
        summarize(script).filter(([messageId]) => messageId !== 'unsupportedCommand'),
      ).toContainEqual(['inconsistentBehavior', backslashPath, 'darwin,linux']);
      expect(
        analyzeScript(script).filter((issue) => issue.data.reason?.includes('backslashes')),
      ).toHaveLength(1);
    });

    it.each<[string, Summary[]]>([
      ['concurrently "echo %AB%"', [['unsupportedSyntax', '%AB%', 'darwin,linux']]],
      [
        'concurrently "node x --out=/dev/null"',
        [['unsupportedSyntax', '--out=/dev/null', 'win32']],
      ],
      // Not a nested script, or one that can't be parsed
      [
        `concurrently "${backslashPath}"`,
        [['inconsistentBehavior', `"${backslashPath}"`, 'darwin,linux']],
      ],
      [
        `concurrently "a 'b ${backslashPath}"`,
        [['inconsistentBehavior', `"a 'b ${backslashPath}"`, 'darwin,linux']],
      ],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    // Joined words are reported as a whole, so each word keeps its own report
    it.each<[string, Summary[], AnalyzeScriptOptions?]>([
      [
        'cross-env-shell ls ~/x',
        [
          ['unsupportedCommand', 'ls ~/x', 'win32'],
          ['unsupportedSyntax', '~/x', 'win32'],
        ],
      ],
      ['cross-env-shell A=1 echo %AB%', [['unsupportedSyntax', '%AB%', 'darwin,linux']]],
      [
        'cross-env-shell A=1 cat /dev/null',
        [
          ['unsupportedCommand', 'cat /dev/null', 'win32'],
          ['unsupportedSyntax', '/dev/null', 'win32'],
        ],
      ],
      ['pnpm exec -c npm i a@^5', [['inconsistentBehavior', 'a@^5', 'win32']]],
      [
        'cross-env-shell A=1 tool src/**/*.js',
        [['inconsistentBehavior', 'src/**/*.js', 'darwin,linux,win32']],
      ],
      ['cross-env-shell tsc\r x', [['inconsistentBehavior', '\r', 'darwin,linux']]],
      // The quoted word isn't checked for a tilde expansion, so the joined script keeps it
      [
        'cross-env-shell A=1 "ls ~/x" ~/y',
        [
          ['unsupportedCommand', '"ls ~/x" ~/y', 'win32'],
          ['unsupportedSyntax', '"ls ~/x" ~/y', 'win32'],
          ['unsupportedSyntax', '~/y', 'win32'],
        ],
      ],
      // The word's report covers more platforms in Yarn's shell
      [
        'cross-env-shell ls ~/x',
        [
          ['unsupportedCommand', 'ls ~/x', 'win32'],
          ['unsupportedSyntax', '~/x', 'darwin,linux,win32'],
        ],
        yarn,
      ],
    ])('reports %j once in joined words', (script, expected, options) => {
      expect(summarize(script, options)).toStrictEqual(expected);
    });

    it.each<[string, FixSummary[]]>([
      ['cross-env-shell tsc\r x', [['\r', 'Remove the carriage return.', 'cross-env-shell tsc x']]],
      // The joined script loses the quotes of the words, so quoting them doesn't help
      ['pnpm exec -c npm i a@^5', []],
      ['cross-env-shell A=1 tool src/**/*.js', []],
      ['aubx -c tool src/**/*.js', []],
      ["cross-env-shell A=1 tool 'a b'", []],
    ])('keeps the fixes of the words that still work in %j', (script, expected) => {
      expect(summarizeFixes(script)).toStrictEqual(expected);
    });
  });

  describe('platforms covered by an enclosing report', () => {
    it.each<[string, Summary[]]>([
      [
        'if [ -f x ]; then sed -i s/a/b/ f; fi',
        [
          ['unsupportedSyntax', 'if', 'win32'],
          ['unsupportedUsage', 'sed -i', 'darwin'],
        ],
      ],
      [
        'for f in src/**/*.js; do open $f; done',
        [
          ['unsupportedSyntax', 'for', 'win32'],
          ['inconsistentBehavior', 'src/**/*.js', 'darwin,linux'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      [
        'f() { open x; }; f',
        [
          ['unsupportedSyntax', 'f', 'win32'],
          ['unsupportedCommand', 'open', 'linux'],
          ['unsupportedSyntax', ';', 'win32'],
        ],
      ],
      [
        '[[ -f x ]] && pbcopy < x',
        [
          ['unsupportedSyntax', '[[ -f x ]]', 'linux,win32'],
          ['unsupportedCommand', 'pbcopy', 'linux,win32'],
        ],
      ],
      ['xargs rm < files', [['unsupportedCommand', 'xargs', 'win32']]],
      [
        'xargs open < files',
        [
          ['unsupportedCommand', 'xargs', 'win32'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      ['bash -c "echo -e x && source y"', [['unsupportedCommand', 'bash', 'win32']]],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('redirections', () => {
    it.each<[string, Summary[]]>([
      ['node x < input.txt >> log 2>&1', []],
      ['node x 2>&1 | tee-cli log', []],
      ['node x >&2', []],
      ['node x 1>&-', []],
      ['node x 2> /dev/null', [['unsupportedSyntax', '/dev/null', 'win32']]],
      ['node x >/dev/stderr', [['unsupportedSyntax', '/dev/stderr', 'win32']]],
      ['node x > NUL', [['inconsistentBehavior', 'NUL', 'darwin,linux']]],
      ['node x &>> log', [['unsupportedSyntax', '&>> log', 'darwin,linux,win32']]],
      ['node x <> f', [['unsupportedSyntax', '<> f', 'win32']]],
      [
        'cat <<-EOF\n\tx\n\tEOF',
        [
          ['unsupportedCommand', 'cat', 'win32'],
          ['unsupportedSyntax', '<<-EOF', 'win32'],
        ],
      ],
      ['node x > out-$(date +%s).log', [['unsupportedSyntax', '$(date +%s)', 'win32']]],
      ['node x > ~/log', [['unsupportedSyntax', '~/log', 'win32']]],
      // A here-string is text rather than a file
      ['node x <<< /dev/null', [['unsupportedSyntax', '<<< /dev/null', 'linux,win32']]],
      ['node x <<< nul', [['unsupportedSyntax', '<<< nul', 'linux,win32']]],
      [
        String.raw`node x <<< src\a.js`,
        [['unsupportedSyntax', String.raw`<<< src\a.js`, 'linux,win32']],
      ],
      [
        'node x <<< $A',
        [
          ['unsupportedSyntax', '<<< $A', 'linux,win32'],
          ['unsupportedSyntax', '$A', 'win32'],
        ],
      ],
      [
        'node x <<< %AB%',
        [
          ['unsupportedSyntax', '<<< %AB%', 'linux,win32'],
          ['unsupportedSyntax', '%AB%', 'darwin,linux'],
        ],
      ],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('assignments', () => {
    it.each<[string, Summary[]]>([
      [
        'NODE_OPTIONS="--max-old-space-size=4096" vite build',
        [['unsupportedSyntax', 'NODE_OPTIONS="--max-old-space-size=4096"', 'win32']],
      ],
      [
        'A=1 B=2 node x',
        [
          ['unsupportedSyntax', 'A=1', 'win32'],
          ['unsupportedSyntax', 'B=2', 'win32'],
        ],
      ],
      [
        'PORT=3000 URL=http://localhost:$PORT node x',
        [
          ['unsupportedSyntax', 'PORT=3000', 'win32'],
          ['unsupportedSyntax', 'URL=http://localhost:$PORT', 'win32'],
        ],
      ],
      [
        'A=$(pwd) node x',
        [
          ['unsupportedSyntax', 'A=$(pwd)', 'win32'],
          ['unsupportedSyntax', '$(pwd)', 'win32'],
        ],
      ],
      [
        'FOO=~/x node y',
        [
          ['unsupportedSyntax', 'FOO=~/x', 'win32'],
          ['unsupportedSyntax', '~/x', 'win32'],
        ],
      ],
      ['A+=1 node x', [['unsupportedSyntax', 'A+=1', 'linux,win32']]],
      ['A[0]=1 node x', [['unsupportedSyntax', 'A[0]=1', 'linux,win32']]],
      [
        'export A=$(pwd)',
        [
          ['unsupportedCommand', 'export', 'win32'],
          ['unsupportedSyntax', '$(pwd)', 'win32'],
        ],
      ],
      ['node x NODE_ENV=production', []],
      // Arguments of declaration commands
      [
        'export A=(1 2)',
        [
          ['unsupportedCommand', 'export', 'win32'],
          ['unsupportedSyntax', 'A=(1 2)', 'linux,win32'],
        ],
      ],
      [
        'export A+=1',
        [
          ['unsupportedCommand', 'export', 'win32'],
          ['unsupportedSyntax', 'A+=1', 'linux,win32'],
        ],
      ],
      [
        'readonly A[0]=1',
        [
          ['unsupportedCommand', 'readonly', 'win32'],
          ['unsupportedSyntax', 'A[0]=1', 'linux,win32'],
        ],
      ],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('regressions from real-world scripts', () => {
    it.each<[string, Summary[]]>([
      // `-c` belongs to `concurrently` (colors), not `npx`
      ['pnpx concurrently -c "#ffcf00,#3178c6" "pnpm dev:build"', []],
      [
        'npx --yes concurrently -c red,blue "tsc -w" "rm -rf x"',
        [['unsupportedCommand', 'rm', 'win32']],
      ],
      ['npm exec --package=foo -c "rm y"', [['unsupportedCommand', 'rm', 'win32']]],
      ['npm exec -- concurrently -c "#fff" "vite"', []],
      // `concurrently`'s script shortcuts aren't shell scripts
      ['concurrently "npm:lint:*(!fix)" "pnpm:dev:*"', []],
      ["concurrently 'npm:watch-*'", [['inconsistentBehavior', "'npm:watch-*'", 'win32']]],
      // Many tools expand braces themselves, when the shell doesn't
      ['prettier --write {index,test}.js', []],
      ['postcss src/styles/{base,style}.css --dir dist', []],
      ['shx cp -r node_modules/shiki/{dist,themes} docs/', []], // cspell:disable-line
      [
        'rm -f dynamic.{d.ts,mjs}',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedSyntax', '{d.ts,mjs}', 'linux,win32'],
        ],
      ],
      [
        'cross-env A=1 cp a.{js,map} dist',
        [
          ['unsupportedCommand', 'cp', 'win32'],
          ['unsupportedSyntax', '{js,map}', 'linux,win32'],
        ],
      ],
      ['echo {a,b}', [['unsupportedSyntax', '{a,b}', 'linux,win32']]],
      // Also with a glob, which OS utilities don't expand themselves either
      [
        'cp src/{a,b}/*.js dist',
        [
          ['unsupportedCommand', 'cp', 'win32'],
          ['unsupportedSyntax', '{a,b}', 'linux,win32'],
        ],
      ],
      ['eslint src/{a,b}/*.js', []],
      // Shells don't expand braces in assignments, `case` words and here-strings
      ['FOO={a,b} node x.js', [['unsupportedSyntax', 'FOO={a,b}', 'win32']]],
      ['case {a,b} in a) node x;; esac', [['unsupportedSyntax', 'case', 'win32']]],
      ['node x <<< {a,b}', [['unsupportedSyntax', '<<< {a,b}', 'linux,win32']]],
      // But they do in arrays and the arguments of declaration commands
      [
        'x=({a,b})',
        [
          ['unsupportedSyntax', 'x=({a,b})', 'linux,win32'],
          ['unsupportedSyntax', '{a,b}', 'linux,win32'],
        ],
      ],
      [
        'export A={a,b}',
        [
          ['unsupportedCommand', 'export', 'win32'],
          ['unsupportedSyntax', '{a,b}', 'linux,win32'],
        ],
      ],
      // Bash expands them in a redirection and fails, other shells keep them
      ['node x.js > out.{log,txt}', [['inconsistentBehavior', '{log,txt}', 'darwin']]],
      [
        'bash -c "node x.js > out.{log,txt}"',
        [
          ['unsupportedCommand', 'bash', 'win32'],
          ['inconsistentBehavior', '{log,txt}', 'darwin,linux'],
        ],
      ],
      // Nor globs in assignments
      ['A=src/**/*.js jest', [['unsupportedSyntax', 'A=src/**/*.js', 'win32']]],
      [
        'for f in {a,b}; do node $f; done',
        [
          ['unsupportedSyntax', 'for', 'win32'],
          ['unsupportedSyntax', '{a,b}', 'linux'],
        ],
      ],
      // cspell:disable-next-line
      // The npm `watch` package, not procps' `watch`
      ['watch "npm run build" ./lib', []],
      // Reported once
      ['tsc\nvite build\nnode x', [['unsupportedSyntax', '\n', 'win32']]],
      // The innermost command receives the arguments
      [String.raw`cross-env A=1 grep "a\.b" f`, [['unsupportedCommand', 'grep', 'win32']]],
      ['cross-env A=1 date +%Y%m%d', [['unsupportedCommand', 'date', 'win32']]],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('syntax coverage', () => {
    it.each<[string, Summary[]]>([
      [
        'env $CMD x',
        [
          ['unsupportedCommand', 'env', 'win32'],
          ['unsupportedSyntax', '$CMD', 'win32'],
        ],
      ],
      [
        "sh -c $'rm x'",
        [
          ['unsupportedCommand', 'sh', 'win32'],
          ['unsupportedSyntax', "$'rm x'", 'linux'],
        ],
      ],
      [String.raw`sh -c rm\ x`, [['unsupportedCommand', 'sh', 'win32']]],
      [
        'dash -c "[[ -f x ]] && open y"',
        [
          ['unsupportedCommand', 'dash', 'win32'],
          ['unsupportedSyntax', '[[ -f x ]]', 'linux'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      ['pnpx -c "rm x"', [['unsupportedCommand', 'rm', 'win32']]],
      ['command -v rm', [['unsupportedCommand', 'command', 'win32']]],
      // `-v` of the command that it runs
      [
        'command grep -v -P x f',
        [
          ['unsupportedCommand', 'command', 'win32'],
          ['unsupportedUsage', 'grep -v -P', 'darwin'],
        ],
      ],
      [
        'command open x',
        [
          ['unsupportedCommand', 'command', 'win32'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      ['echo ${!prefix*}', [['unsupportedSyntax', '${!prefix*}', 'linux,win32']]],
      ['cross-env A=${B} node x', []],
      // A nested script that can't be parsed is skipped
      ['echo $(echo "x)', []],
      [
        'base64 file && set foo && stat file && grep x f',
        [
          ['unsupportedCommand', 'base64', 'win32'],
          ['unsupportedCommand', 'stat', 'win32'],
          ['unsupportedCommand', 'grep', 'win32'],
        ],
      ],
      ['for f; do node $f; done', [['unsupportedSyntax', 'for', 'win32']]],
      ['select x; do node $x; done', [['unsupportedSyntax', 'select', 'linux,win32']]],
      [
        'if a; then b; elif c; then open d; else e; fi',
        [
          ['unsupportedSyntax', 'if', 'win32'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      ['while read line; do echo $line; done < f', [['unsupportedSyntax', 'while', 'win32']]],
      [
        '{ a; b; } > /dev/null',
        [
          ['unsupportedSyntax', '{', 'win32'],
          ['unsupportedSyntax', '/dev/null', 'win32'],
        ],
      ],
      [
        '(rm x) 2> nul',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['inconsistentBehavior', 'nul', 'darwin,linux'],
        ],
      ],
      [
        'declare -a x=(1 $(pwd))',
        [
          ['unsupportedCommand', 'declare', 'linux,win32'],
          // dash fails to parse the whole script
          ['unsupportedSyntax', 'x=(1 $(pwd))', 'linux,win32'],
          ['unsupportedSyntax', '$(pwd)', 'win32'],
        ],
      ],
      [
        '[[ ! -f a && ( -d b || -e $c ) ]]',
        [['unsupportedSyntax', '[[ ! -f a && ( -d b || -e $c ) ]]', 'linux,win32']],
      ],
      ['coproc { a; }', [['unsupportedSyntax', 'coproc', 'darwin,linux,win32']]],
      ['# Only a comment', []],
      ['# Only a comment \n\n', []],
      ['# Only\n\n  # comments\n', []],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it.each<[string, Summary[]]>([
      ['if exist dist del dist', [['unsupportedSyntax', 'if exist', 'darwin,linux,win32']]],
      ['IF EXIST dist del dist', [['unsupportedSyntax', 'IF EXIST', 'darwin,linux,win32']]],
      ['echo %CD%', [['unsupportedSyntax', '%CD%', 'darwin,linux,win32']]],
      ['echo ${A:+x} ${A-x}', [['unsupportedSyntax', '${A-x}', 'darwin,linux,win32']]],
      ['node x 2>/dev/null', []],
      ['node x --out=/dev/null', [['unsupportedSyntax', '--out=/dev/null', 'win32']]],
    ])('%j in the portable shell', (script, expected) => {
      expect(summarize(script, yarn)).toStrictEqual(expected);
    });
  });

  describe('platform fallbacks', () => {
    it.each<[string, Summary[]]>([
      ['rm -rf dist || rmdir /s /q dist', []],
      ['export NODE_ENV=test || set NODE_ENV=test&& mocha', []],
      [String.raw`xcopy /e /i . ..\x || rsync -r ./ ../x`, []],
      ['powershell ./cert.cmd || sh ./cert.sh', []],
      [String.raw`.\prepare.bat || ./prepare`, []],
      ['rm -rf dist || IF EXIST dist rd /s /q dist', []],
      ['rm -rf \'a b\' || rd /s /q "a b"', []],
      ['sleep 5 || timeout 5', []],
      // Only commands make an alternative fail, not their arguments
      [
        'tsc --outDir $OUT || rd /s /q out',
        [
          ['unsupportedSyntax', '$OUT', 'win32'],
          ['unsupportedCommand', 'rd', 'darwin,linux'],
        ],
      ],
      // Issues of an alternative stay where it doesn't fail
      ['rm -rf **/x || rd /s /q x', [['inconsistentBehavior', '**/x', 'darwin,linux']]],
      // Dropped issues don't hide other ones, e.g. a later line break or a duplicate report
      ['rm -rf \\\n  a || rd /s /q a\nnpm run build', [['unsupportedSyntax', '\n', 'win32']]],
      [
        String.raw`concurrently "rm -rf \"a b\" || rd /s /q \"a b\" && rm -rf \"c d\"" "x y"`,
        [
          [
            'unsupportedCommand',
            String.raw`"rm -rf \"a b\" || rd /s /q \"a b\" && rm -rf \"c d\""`,
            'win32',
          ],
        ],
      ],
      // Each command is paired once: `true` is still reported, as it runs on Windows when `rmdir`
      // fails
      ['rm -rf dist || rmdir /s /q dist || true', [['unsupportedCommand', 'true', 'win32']]],
      // Not an alternative for another platform
      ['rm -rf dist || echo failed', [['unsupportedCommand', 'rm', 'win32']]],
      // Alternatives that aren't a fallback don't hide one that follows them
      [
        'rm -rf a || rm -rf b && rm -rf c || rd /s /q c',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedCommand', 'rm', 'win32'],
        ],
      ],
      [
        'rm -rf a || rm -rf b || echo x || rm -rf c || rd /s /q c',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedCommand', 'rm', 'win32'],
        ],
      ],
      [
        'rm -rf dist || true',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedCommand', 'true', 'win32'],
        ],
      ],
      // Only the platforms where all alternatives fail are left
      [
        'open x || xdg-open x',
        [
          ['unsupportedCommand', 'open', 'win32'],
          ['unsupportedCommand', 'xdg-open', 'win32'],
        ],
      ],
      [
        "sed -i s/a/b/ f || sed -i '' s/a/b/ f",
        [
          ['unsupportedCommand', 'sed', 'win32'],
          ['unsupportedCommand', 'sed', 'win32'],
          ['inconsistentBehavior', "''", 'win32'],
        ],
      ],
      // An alternative only takes over where it works and the other one doesn't, e.g. not `cp`,
      // which handles errors instead
      [
        'open x || xdg-open x || cp a b',
        [
          ['unsupportedCommand', 'open', 'win32'],
          ['unsupportedCommand', 'xdg-open', 'win32'],
          ['unsupportedCommand', 'cp', 'win32'],
        ],
      ],
      [
        'sed -i s/a/b/ f || cp f.bak f',
        [
          ['unsupportedCommand', 'sed', 'win32'],
          ['unsupportedUsage', 'sed -i', 'darwin'],
          ['unsupportedCommand', 'cp', 'win32'],
        ],
      ],
      [
        'grep -P x f || rm -rf dist',
        [
          ['unsupportedCommand', 'grep', 'win32'],
          ['unsupportedUsage', 'grep -P', 'darwin'],
          ['unsupportedCommand', 'rm', 'win32'],
        ],
      ],
      [
        'rm -rf dist || open x',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedCommand', 'open', 'linux,win32'],
        ],
      ],
      // On Linux, `cp` runs after `open`
      [
        'open x || cp a b || xdg-open x',
        [
          ['unsupportedCommand', 'open', 'linux,win32'],
          ['unsupportedCommand', 'cp', 'win32'],
          ['unsupportedCommand', 'xdg-open', 'win32'],
        ],
      ],
      // Several alternatives for the same platforms
      ['cp -r a b || rsync -a a b || xcopy a b /e', []],
      [`${'rm -rf a || '.repeat(50)}rd /s /q a`, []],
      [
        'rm -rf dist || open x || xdg-open x',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedCommand', 'open', 'win32'],
          ['unsupportedCommand', 'xdg-open', 'win32'],
        ],
      ],
      [
        'rm -rf dist && rmdir /s /q dist',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedUsage', 'rmdir /s', 'darwin,linux'],
        ],
      ],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('hand-checked regressions', () => {
    it.each<[string, Summary[]]>([
      // Backslashes escaping dots are a regex, not a Windows path
      [String.raw`jest --testPathIgnorePatterns=logging\.spec\.ts`, []],
      [String.raw`uvu tests .*\.test\.js`, []],
      [
        String.raw`node .\node_modules\.bin\tsc`,
        [['inconsistentBehavior', String.raw`.\node_modules\.bin\tsc`, 'darwin,linux']],
      ],
      // Bash options that change globbing
      [
        "bash -O globstar -c 'rm -f lib/**/*.{js,d.ts}'",
        [
          ['unsupportedCommand', 'bash', 'win32'],
          // macOS ships Bash 3.2
          ['unsupportedUsage', 'bash -O globstar', 'darwin'],
        ],
      ],
      ["bash -O extglob -c 'rm -f !(package.json)'", [['unsupportedCommand', 'bash', 'win32']]],
      [
        "bash -c 'rm -f lib/**/*.js'",
        [
          ['unsupportedCommand', 'bash', 'win32'],
          ['inconsistentBehavior', 'lib/**/*.js', 'darwin,linux'],
        ],
      ],
      // Option values attached to the option
      [
        'stat -f%z f',
        [
          ['unsupportedCommand', 'stat', 'win32'],
          ['inconsistentBehavior', 'stat -f%z', 'linux'],
        ],
      ],
      [
        'stat -c%s f',
        [
          ['unsupportedCommand', 'stat', 'win32'],
          ['unsupportedUsage', 'stat -c%s', 'darwin'],
        ],
      ],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe("variables that Windows doesn't set", () => {
    it.each<[string, Summary[]]>([
      // `cross-env` replaces them with an empty string there
      ['cross-env NODE_PATH=$PWD/src jest', [['inconsistentBehavior', '$PWD', 'win32']]],
      ['cross-env-shell "jest --rootDir $PWD"', [['inconsistentBehavior', '$PWD', 'win32']]],
      ['cross-env A=1 node x.js --tmp $TMPDIR', [['inconsistentBehavior', '$TMPDIR', 'win32']]],
      [
        'X=$PWD/tmp jest',
        [
          ['unsupportedSyntax', 'X=$PWD/tmp', 'win32'],
          ['inconsistentBehavior', '$PWD', 'win32'],
        ],
      ],
      // npm sets `HOME`
      ['cross-env CONFIG=${HOME}/.config node x.js', []],
      // Variables of the user or the package manager
      ['cross-env NODE_ENV=$NODE_ENV jest', []],
      ['cross-env VERSION=$npm_package_version jest', []],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it.each<Runner>(['aube', 'node', 'pnpm', 'upm', 'yarn-classic'])(
      "reports `HOME` when %s runs the script, which doesn't set it",
      (runner) => {
        expect(summarize('cross-env CONFIG=${HOME}/.config node x.js', {runner})).toStrictEqual([
          ['inconsistentBehavior', '${HOME}', 'win32'],
        ]);
      },
    );

    it("doesn't report `HOME` when pnpm v10 runs the script, which sets it", () => {
      expect(
        summarize('cross-env CONFIG=${HOME}/.config node x.js', {runner: 'pnpm-10'}),
      ).toStrictEqual([]);
    });

    it("doesn't report them in Yarn's shell, which expands variables itself", () => {
      expect(summarize('cross-env NODE_PATH=$PWD/src jest', yarn)).toStrictEqual([]);
    });

    it.each<[string, string, AnalyzeScriptOptions?]>([
      ['node x.js --root $PWD', 'Use a relative path or a Node.js script instead.'],
      ['node x.js --tmp $TMPDIR', 'Use a Node.js script instead.'],
      ['node x.js --home ${HOME}', 'Use `cross-env` or a Node.js script instead.'],
      ['node x.js --home ${HOME}', 'Use a Node.js script instead.', yarnClassic],
      ['node x.js --home ${HOME}', 'Use a Node.js script instead.', nodeRun],
      ['node x.js --env $NODE_ENV', 'Use `cross-env` or a Node.js script instead.'],
    ])("doesn't suggest `cross-env` for them in %j", (script, suggestion, options) => {
      expect(analyzeScript(script, options).map((issue) => issue.data.suggestion)).toStrictEqual([
        suggestion,
      ]);
    });
  });

  // POSIX shells expand them before `cross-env` sets them, while on Windows `cross-env` replaces
  // them with `%NAME%`, which only a shell expands, e.g. the one of `cross-env-shell`
  describe('variables that `cross-env` sets for its command', () => {
    it.each<[string, Summary[]]>([
      [
        'cross-env NODE_ENV=production webpack --env mode=$NODE_ENV',
        [
          ['inconsistentBehavior', '$NODE_ENV', 'darwin,linux'],
          ['inconsistentBehavior', '$NODE_ENV', 'win32'],
        ],
      ],
      [
        'cross-env A=1 B=2 node x ${B} "$A"',
        [
          ['inconsistentBehavior', '${B}', 'darwin,linux'],
          ['inconsistentBehavior', '${B}', 'win32'],
          ['inconsistentBehavior', '$A', 'darwin,linux'],
          ['inconsistentBehavior', '$A', 'win32'],
        ],
      ],
      // Windows doesn't set it, but `cross-env` does
      [
        'cross-env HOME=/tmp node x $HOME',
        [
          ['inconsistentBehavior', '$HOME', 'darwin,linux'],
          ['inconsistentBehavior', '$HOME', 'win32'],
        ],
      ],
      // The shell expands it in the string before `cross-env-shell` runs the string
      ['cross-env-shell A=1 "echo $A"', [['inconsistentBehavior', '$A', 'darwin,linux']]],
      ['cross-env-shell A=1 echo $A', [['inconsistentBehavior', '$A', 'darwin,linux']]],
      // The shell that `cross-env-shell` starts expands it after it's set
      ["cross-env-shell A=1 'echo $A'", [['inconsistentBehavior', "'echo $A'", 'win32']]],
      // Escaped
      [String.raw`cross-env A=1 node x \$A $B`, [['inconsistentBehavior', '$B', 'win32']]],
      // In the values of its other variables, which `cross-env` resolves itself
      ['cross-env A=1 B=$A node x', []],
      // Not set by `cross-env`, which still replaces it on Windows
      ['cross-env A=1 node x $FOO', [['inconsistentBehavior', '$FOO', 'win32']]],
      ['cross-env A=1 $CMD x', [['inconsistentBehavior', '$CMD', 'win32']]],
      // The shell of `cross-env-shell` expands `%NAME%`
      ['cross-env-shell A=1 node x $FOO', []],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it("doesn't report them in Yarn's shell, which expands them itself on all platforms", () => {
      expect(
        summarize('cross-env NODE_ENV=production webpack --env mode=$NODE_ENV', yarn),
      ).toStrictEqual([]);
    });

    it('explains the reports', () => {
      expect(analyzeScript('cross-env A=1 node x $A').map(({data}) => data)).toStrictEqual([
        {
          reason:
            "POSIX shells expand it before `cross-env` sets it, so the command doesn't get the new value",
          suggestion: 'Use the value itself or a Node.js script instead.',
          syntax: 'The variable `$A`',
        },
        {
          reason: "`cross-env` replaces it with `%A%`, which isn't expanded without a shell",
          suggestion: 'Use `cross-env-shell` or a Node.js script instead.',
          syntax: 'The variable `$A`',
        },
      ]);
    });
  });

  describe("variables that `node --run` doesn't set", () => {
    it.each<[string, Summary[]]>([
      // cmd.exe doesn't expand `$npm_package_version` anyway
      [
        'echo $npm_package_version ${npm_lifecycle_event}',
        [
          ['unsupportedSyntax', '$npm_package_version', 'win32'],
          ['inconsistentBehavior', '$npm_package_version', 'darwin,linux'],
          ['unsupportedSyntax', '${npm_lifecycle_event}', 'win32'],
          ['inconsistentBehavior', '${npm_lifecycle_event}', 'darwin,linux'],
        ],
      ],
      [
        'node x.js --cwd $INIT_CWD',
        [
          ['unsupportedSyntax', '$INIT_CWD', 'win32'],
          ['inconsistentBehavior', '$INIT_CWD', 'darwin,linux'],
        ],
      ],
      [
        'cross-env VERSION=$npm_package_version jest',
        [['inconsistentBehavior', '$npm_package_version', 'darwin,linux,win32']],
      ],
      [
        "sh -c 'echo $npm_lifecycle_event'",
        [
          ['unsupportedCommand', 'sh', 'win32'],
          ['inconsistentBehavior', '$npm_lifecycle_event', 'darwin,linux'],
        ],
      ],
      [
        'echo %npm_package_version%',
        [
          ['unsupportedSyntax', '%npm_package_version%', 'darwin,linux'],
          ['inconsistentBehavior', '%npm_package_version%', 'win32'],
        ],
      ],
      [
        'cross-env CONFIG=${HOME}/.config node x.js',
        [['inconsistentBehavior', '${HOME}', 'win32']],
      ],
      // Variables of the user
      ['cross-env TOKEN=$NPM_TOKEN jest', []],
    ])('%j', (script, expected) => {
      expect(summarize(script, nodeRun)).toStrictEqual(expected);
    });

    it('explains why the variable is empty', () => {
      expect(
        analyzeScript('cross-env VERSION=$npm_package_version jest', nodeRun).map(
          (issue) => issue.data,
        ),
      ).toStrictEqual([
        {
          reason: "`node --run` doesn't set it",
          suggestion: 'Use a Node.js script instead.',
          syntax: 'The variable `$npm_package_version`',
        },
      ]);
    });

    it.each<[string, Summary[]]>([
      ['cross-env VERSION=$npm_package_version jest', []],
      [
        'cross-env CLI=$npm_execpath node x.js',
        [['inconsistentBehavior', '$npm_execpath', 'darwin,linux,win32']],
      ],
    ])('only reports the ones that upm sets in %j', (script, expected) => {
      expect(summarize(script, {runner: 'upm'})).toStrictEqual(expected);
    });

    it('names upm in the reason', () => {
      expect(
        analyzeScript('cross-env CLI=$npm_execpath node x.js', {runner: 'upm'})[0]?.data.reason,
      ).toBe("upm doesn't set it");
    });
  });

  describe('runners', () => {
    it.each<Runner>(['pnpm', 'pnpm-10'])(
      "checks the scripts in Yarn's shell when %s's `shell-emulator` is on",
      (runner) => {
        expect(summarize('npm run a & npm run b', {runner, shellEmulator: true})).toStrictEqual([]);
      },
    );

    it('ignores `shellEmulator` for other runners', () => {
      expect(
        summarize('npm run a & npm run b', {runner: 'npm', shellEmulator: true}),
      ).toStrictEqual([['inconsistentBehavior', '&', 'win32']]);
    });

    it.each<Runner>(['aube', 'npm', 'pnpm', 'pnpm-10', 'upm'])(
      'checks the scripts like npm runs them with %s',
      (runner) => {
        expect(summarize('rm -rf dist; echo $npm_package_version', {runner})).toStrictEqual(
          summarize('rm -rf dist; echo $npm_package_version'),
        );
      },
    );
  });

  describe('several runners', () => {
    it.each<[string, Runner[], string[][]]>([
      // The same issue with several runners is reported once
      ['rm -rf dist', ['npm', 'yarn'], [['unsupportedCommand', 'rm', 'win32', 'npm,yarn']]],
      // Yarn's shell supports it
      [
        'NODE_ENV=production node x',
        ['npm', 'yarn'],
        [['unsupportedSyntax', 'NODE_ENV=production', 'win32', 'npm']],
      ],
      // Yarn's shell can't run cmd.exe's builtins on Windows either
      [
        'del dist',
        ['npm', 'yarn'],
        [['unsupportedCommand', 'del', 'darwin,linux,win32', 'npm,yarn']],
      ],
      // Of these, only npm sets `HOME`
      [
        'cross-env CONFIG=${HOME}/.config node x.js',
        ['npm', 'pnpm', 'yarn-classic'],
        [['inconsistentBehavior', '${HOME}', 'win32', 'pnpm,yarn-classic']],
      ],
      // The reasons differ
      [
        'cross-env CLI=$npm_execpath node x.js',
        ['node', 'npm', 'upm'],
        [
          ['inconsistentBehavior', '$npm_execpath', 'darwin,linux,win32', 'node'],
          ['inconsistentBehavior', '$npm_execpath', 'darwin,linux,win32', 'upm'],
        ],
      ],
      ['rm -rf dist', ['npm', 'npm'], [['unsupportedCommand', 'rm', 'win32', 'npm']]],
      // Runners that run scripts the same way are analyzed once, e.g. aube and pnpm
      [
        'rm -rf dist',
        ['pnpm', 'npm', 'aube'],
        [['unsupportedCommand', 'rm', 'win32', 'pnpm,npm,aube']],
      ],
      [
        'cross-env CONFIG=${HOME}/.config node x.js',
        ['pnpm', 'npm', 'aube', 'pnpm-10'],
        [['inconsistentBehavior', '${HOME}', 'win32', 'pnpm,aube']],
      ],
      ['rm -rf dist', [], [['unsupportedCommand', 'rm', 'win32', 'npm']]],
    ])('%j with %j', (script, runner, expected) => {
      expect(summarizeRunners(script, {runner})).toStrictEqual(expected);
    });

    it('ignores unknown runners, e.g. from JavaScript', () => {
      // eslint-disable-next-line un/no-type-assertion -- Not a runner
      const unknown = 'bogus' as Runner;

      expect(summarizeRunners('rm -rf dist', {runner: [unknown]})).toStrictEqual([
        ['unsupportedCommand', 'rm', 'win32', 'npm'],
      ]);
      expect(summarizeRunners('rm -rf dist', {runner: [unknown, 'pnpm']})).toStrictEqual([
        ['unsupportedCommand', 'rm', 'win32', 'pnpm'],
      ]);
    });

    it("analyzes pnpm with its shell emulator apart from aube, which doesn't have one", () => {
      expect(
        summarizeRunners('a; b', {runner: ['aube', 'pnpm'], shellEmulator: true}),
      ).toStrictEqual([['unsupportedSyntax', ';', 'win32', 'aube']]);
    });

    it('keeps a fix that all runners suggest', () => {
      expect(analyzeScript('rm -rf dist', {runner: ['npm', 'yarn']})[0]?.fix?.description).toBe(
        'Replace `rm -rf` with `rimraf`.',
      );
    });

    // Runners share an analysis that didn't use the traits they differ in, whatever their order
    describe.each<[string, Runner[]]>([
      ['in order', ['aube', 'node', 'npm', 'pnpm', 'pnpm-10', 'upm', 'yarn', 'yarn-classic']],
      [
        'in reverse order',
        ['yarn-classic', 'yarn', 'upm', 'pnpm-10', 'pnpm', 'npm', 'node', 'aube'],
      ],
      ['mixed', ['yarn-classic', 'npm', 'yarn', 'node', 'pnpm-10', 'upm', 'aube', 'pnpm']],
    ])('with all runners %s', (_, runner) => {
      /**
       * Summarizes the issues like `summarizeRunners`, but sorted, and with sorted runners: their
       * order follows the order of the runners in the options.
       * @param script Script source to analyze
       * @param options Options for the analysis
       * @returns A compact representation of each issue
       */
      const summarizeSorted = (script: string, options: AnalyzeScriptOptions) =>
        analyzeScript(script, {...options, runner})
          .map(({end, messageId, platforms, pos, runners}) =>
            [
              messageId,
              script.slice(pos, end),
              platforms.join(','),
              // eslint-disable-next-line unicorn/no-array-sort, sonar/no-misleading-array-reverse -- Sorts a new array
              runners.sort().join(','),
            ].join(' '),
          )
          .sort();

      it.each<[string, AnalyzeScriptOptions, string[]]>([
        // Yarn v1 replaces `/` with `\` in it, and Yarn's shell runs it
        [
          'node_modules/.bin/tsc',
          {},
          ['unsupportedSyntax node_modules/.bin/tsc win32 aube,node,npm,pnpm,pnpm-10,upm'],
        ],
        // npm and pnpm v10 set `HOME`, and Yarn's shell expands variables itself
        [
          'cross-env CONFIG=${HOME}/.config node x.js',
          {},
          ['inconsistentBehavior ${HOME} win32 aube,node,pnpm,upm,yarn-classic'],
        ],
        [
          'cross-env CLI=$npm_execpath node x.js',
          {},
          [
            'inconsistentBehavior $npm_execpath darwin,linux,win32 node',
            'inconsistentBehavior $npm_execpath darwin,linux,win32 upm',
          ],
        ],
        [
          'a; b',
          {shellEmulator: true},
          ['unsupportedSyntax ; win32 aube,node,npm,upm,yarn-classic'],
        ],
        [
          'node_modules/.bin/tsc && cross-env CONFIG=$HOME CLI=$npm_execpath node x.js; b',
          {shellEmulator: true},
          [
            'inconsistentBehavior $HOME win32 aube,node,upm,yarn-classic',
            'inconsistentBehavior $npm_execpath darwin,linux,win32 node',
            'inconsistentBehavior $npm_execpath darwin,linux,win32 upm',
            'unsupportedSyntax ; win32 aube,node,npm,upm,yarn-classic',
            'unsupportedSyntax node_modules/.bin/tsc win32 aube,node,npm,upm',
          ],
        ],
      ])('%j with %j', (script, options, expected) => {
        expect(summarizeSorted(script, options)).toStrictEqual(expected);
      });

      it('names each runner in its reason', () => {
        expect(
          analyzeScript('cross-env CLI=$npm_execpath node x.js', {runner})
            .map((issue) => `${issue.runners.join(',')}: ${issue.data.reason}`)
            .sort(),
        ).toStrictEqual(["node: `node --run` doesn't set it", "upm: upm doesn't set it"]);
      });
    });
  });

  describe('runner-agnostic scripts', () => {
    // Only npm and pnpm v10 set `HOME`
    const SCRIPT = 'cross-env CONFIG=${HOME}/.config node x.js';
    const homeIssue = ['inconsistentBehavior', '${HOME}', 'win32', 'aube,pnpm,upm,yarn-classic'];

    it.each<[string, AnalyzeScriptOptions, string[][]]>([
      ['include install scripts', {scriptName: 'postinstall'}, [homeIssue]],
      ['include `prepare`', {scriptName: 'prepare'}, [homeIssue]],
      ["don't include other scripts", {scriptName: 'build'}, []],
      [
        "don't include any script with `false`",
        {runnerAgnosticScripts: false, scriptName: 'postinstall'},
        [],
      ],
      [
        'include all scripts with `true`',
        {runnerAgnosticScripts: true, scriptName: 'build'},
        [homeIssue],
      ],
      [
        'include scripts set to `true`',
        {runnerAgnosticScripts: {release: true}, scriptName: 'release'},
        [homeIssue],
      ],
      [
        "don't include scripts set to `false`",
        {runnerAgnosticScripts: {prepare: false}, scriptName: 'prepare'},
        [],
      ],
      [
        'keep the other defaults',
        {runnerAgnosticScripts: {prepare: false}, scriptName: 'postinstall'},
        [homeIssue],
      ],
      [
        "don't include inherited properties like `constructor`",
        {runnerAgnosticScripts: {}, scriptName: 'constructor'},
        [],
      ],
      [
        'keep the defaults with `null`',
        {
          // eslint-disable-next-line un/no-type-assertion -- JavaScript callers may pass `null`, which the types don't allow
          runnerAgnosticScripts: null as unknown as undefined,
          scriptName: 'postinstall',
        },
        [homeIssue],
      ],
    ])('%s', (_, options, expected) => {
      expect(summarizeRunners(SCRIPT, {...options, runner: 'npm'})).toStrictEqual(expected);
    });

    it("doesn't check them with `node --run`, which doesn't install packages", () => {
      expect(
        analyzeScript('cross-env CLI=$npm_execpath node x.js', {scriptName: 'postinstall'}).map(
          (issue) => issue.runners,
        ),
      ).toStrictEqual([['upm']]);
    });
  });

  // Checked on GitHub's Windows runners with npm, pnpm v10 and Yarn v1
  describe('line breaks', () => {
    it.each<[string, Summary[]]>([
      // cmd.exe only runs the first line, even in quotes, and fails on an incomplete one
      ['tsc\nvite build', [['unsupportedSyntax', '\n', 'win32']]],
      ['tsc &&\n  vite build', [['unsupportedSyntax', '\n', 'win32']]],
      [
        'tsc |\n  tee log',
        [
          ['unsupportedSyntax', '\n', 'win32'],
          ['unsupportedCommand', 'tee', 'win32'],
        ],
      ],
      ['node x.js \\\n  --watch', [['unsupportedSyntax', '\n', 'win32']]],
      ['node x.js "a\nb"', [['unsupportedSyntax', '\n', 'win32']]],
      ['tsc\n', []],
      // Before the first command, where cmd.exe has nothing to run
      ['\ntsc', [['unsupportedSyntax', '\n', 'win32']]],
      // In a subshell, which isn't complete on the first line
      ['(\n  tsc\n)', [['unsupportedSyntax', '\n', 'win32']]],
      ['(tsc\n)', [['unsupportedSyntax', '\n', 'win32']]],
      [
        '(node a.js # comment\n)',
        [
          ['unsupportedSyntax', '# comment', 'win32'],
          ['unsupportedSyntax', '\n', 'win32'],
        ],
      ],
      [
        'node server.js &\nnode client.js',
        [
          ['inconsistentBehavior', '&', 'win32'],
          ['unsupportedSyntax', '\n', 'win32'],
        ],
      ],
      [
        'rd /s /q dist &\nnpm run build',
        [
          ['unsupportedCommand', 'rd', 'darwin,linux'],
          ['unsupportedSyntax', '\n', 'win32'],
        ],
      ],
      [
        'node x.js <<EOF\nhello\nEOF\necho done',
        [
          ['unsupportedSyntax', '<<EOF', 'win32'],
          ['unsupportedSyntax', '\n', 'win32'],
        ],
      ],
      // Reported once, for the outer script
      ['concurrently "tsc\nvite"', [['unsupportedSyntax', '\n', 'win32']]],
      // Once per source
      ['concurrently "tsc\nvite" "tsc\nvite"', [['unsupportedSyntax', '\n', 'win32']]],
      [
        'concurrently "tsc\nvite" "jest\nvite"',
        [
          ['unsupportedSyntax', '\n', 'win32'],
          ['unsupportedSyntax', '\n', 'win32'],
        ],
      ],
      // `rd` runs instead of `rm` on Windows, so the line break is reported for the outer script
      // instead of the nested one
      ['concurrently "rm -rf \'a\nb\' || rd /s /q a"', [['unsupportedSyntax', '\n', 'win32']]],
      // Also with escapes, where positions in the nested script can't be mapped
      ['concurrently "rm -rf \\"a\nb\\" || rd /s /q a"', [['unsupportedSyntax', '\n', 'win32']]],
      // A line break in a statement that's reported already doesn't count
      [
        'if [ -d dist ]; then\nrimraf dist\nfi\ntsc',
        [
          ['unsupportedSyntax', 'if', 'win32'],
          ['unsupportedSyntax', '\n', 'win32'],
        ],
      ],
      // POSIX shells keep the carriage returns of CRLF line breaks
      [
        'tsc\r\nvite build',
        [
          ['inconsistentBehavior', '\r', 'darwin,linux'],
          ['unsupportedSyntax', '\n', 'win32'],
        ],
      ],
      [
        'echo "a\r\nb" > x.txt',
        [
          ['inconsistentBehavior', '"a\r\nb"', 'win32'],
          ['unsupportedSyntax', '\n', 'win32'],
        ],
      ],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    // Yarn's shell keeps them in words, e.g. in a command named with a line break after `&&`
    it.each<[string, Summary[]]>([
      ['tsc &&\n  vite build', [['unsupportedSyntax', '\n', 'darwin,linux,win32']]],
      ['node x.js \\\n  --watch', [['unsupportedSyntax', '\n', 'darwin,linux,win32']]],
      // Only `tr` itself
      ["tr -d '\n' < a.txt", [['unsupportedCommand', 'tr', 'win32']]],
      // Unlike `;` itself
      ['a;\nb', [['unsupportedSyntax', '\n', 'darwin,linux,win32']]],
    ])("%j in Yarn's shell", (script, expected) => {
      expect(summarize(script, yarn)).toStrictEqual(expected);
    });

    it("reports a line break after `;` in pnpm's shell emulator", () => {
      expect(summarize('a;\nb', {runner: 'pnpm', shellEmulator: true})).toStrictEqual([
        ['unsupportedSyntax', '\n', 'darwin,linux,win32'],
      ]);
    });

    it("doesn't report carriage returns in Yarn's shell", () => {
      expect(summarize('tsc\r\nvite build', yarn)).toStrictEqual([
        ['unsupportedSyntax', '\n', 'darwin,linux,win32'],
      ]);
    });

    it.each<[string, FixSummary[]]>([
      ['tsc &&\n  vite build', [['\n', 'Join the lines.', 'tsc && vite build']]],
      ['node x.js \\\n--watch', [['\n', 'Join the lines.', 'node x.js --watch']]],
      // A `\` line continuation before the operator
      ['tsc \\\n&& vite build', [['\n', 'Join the lines.', 'tsc && vite build']]],
      ['tsc \\\n| node x.js', [['\n', 'Join the lines.', 'tsc | node x.js']]],
      // Only the line continuation is removed, so the body of the here-document stays
      [
        'node a.js <<EOF \\\n| node b.js\nbody\nEOF',
        [['\n', 'Join the lines.', 'node a.js <<EOF | node b.js\nbody\nEOF']],
      ],
      // `&&` would wait for the first command
      [
        'node server.js &\nnode client.js',
        [['\n', 'Join the lines.', 'node server.js & node client.js']],
      ],
      ['\ntsc', [['\n', 'Join the lines.', ' tsc']]],
      ['(\n  tsc\n)', [['\n', 'Join the lines.', '( tsc\n)']]],
      // Without the carriage return, it's the line break after `&&` above, which can be joined
      ['tsc &&\r\n  vite build', [['\r', 'Remove the carriage return.', 'tsc &&\n  vite build']]],
      ['tsc |\r\n tee log', [['\r', 'Remove the carriage return.', 'tsc |\n tee log']]],
      ['a &\r\nb', [['\r', 'Remove the carriage return.', 'a &\nb']]],
      // Both fixes together give `tsc && vite build`
      [
        'tsc\r\nvite build',
        [
          ['\r', 'Remove the carriage return.', 'tsc\nvite build'],
          [
            '\n',
            'Replace the line break with `&&`, which stops at the first failing command.',
            'tsc\r && vite build',
          ],
        ],
      ],
    ])('fixes %j', (script, expected) => {
      expect(summarizeFixes(script)).toStrictEqual(expected);
    });

    it.each([
      // Joining the lines would comment the rest out
      'tsc && # build\nvite build',
      'node x.js "a\nb"',
      // In a word, e.g. in single quotes, where POSIX shells keep the line break
      'node x.js\\\n--watch',
      // The closing line of a here-document must stay on its own, and the body can't be removed
      'node x.js <<EOF\nhello\nEOF\necho done',
      'node a.js <<EOF |\nbody\nEOF\nnode b.js',
      'node a.js <<EOF &\nbody\nEOF\nnode b.js',
      // Not before `)` either, as `}` must follow a line break or `;`
      '(tsc\n)',
      // cmd.exe would read `a || b && c` as `a || (b && c)`
      'a || b\nc',
      'a || b; c',
    ])("doesn't fix %j", (script) => {
      expect(summarizeFixes(script)).toStrictEqual([]);
    });
  });

  // Checked on GitHub's Windows runners with npm, pnpm v10 and Yarn v1
  describe('command paths', () => {
    it.each<[string, Summary[]]>([
      // `cross-env`'s `cross-spawn` normalizes the path and reads the file's shebang
      ['cross-env A=1 ./node_modules/.bin/eslint .', []],
      ['cross-env A=1 ./scripts/build.js', []],
      // A shell runs it there
      [
        'cross-env-shell "./node_modules/.bin/eslint ."',
        [['unsupportedSyntax', './node_modules/.bin/eslint', 'win32']],
      ],
      ['cross-env A=1 ./scripts/build.sh', [['unsupportedCommand', './scripts/build.sh', 'win32']]],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    // Yarn v1 replaces `/` with `\` in the script's command names on Windows
    it.each<[string, Summary[]]>([
      ['./node_modules/.bin/eslint . && node_modules/.bin/tsc', []],
      ['tsc | ./node_modules/.bin/tee-cli log', []],
      ['tsc || node_modules/.bin/x', []],
      ['tsc & node_modules/.bin/x', [['inconsistentBehavior', '&', 'win32']]],
      ['tsc&&node_modules/.bin/x', []],
      ['  node_modules/.bin/x', []],
      ['tsc &&\n\tnode_modules/.bin/x', [['unsupportedSyntax', '\n', 'win32']]],
      // Not after `;`, which cmd.exe doesn't support either
      [
        'tsc; node_modules/.bin/x',
        [
          ['unsupportedSyntax', ';', 'win32'],
          ['unsupportedSyntax', 'node_modules/.bin/x', 'win32'],
        ],
      ],
      // Not after `(`, and not in the scripts that other commands run
      [
        '(./node_modules/.bin/eslint .)',
        [['unsupportedSyntax', './node_modules/.bin/eslint', 'win32']],
      ],
      [
        'concurrently "./node_modules/.bin/tsc -w" vite',
        [['unsupportedSyntax', './node_modules/.bin/tsc', 'win32']],
      ],
      // cmd.exe runs JavaScript files with Windows Script Host
      ['./scripts/build.js', [['unsupportedSyntax', './scripts/build.js', 'win32']]],
    ])('%j with Yarn v1', (script, expected) => {
      expect(summarize(script, yarnClassic)).toStrictEqual(expected);
    });

    it('reports dependency binaries for other package managers', () => {
      expect(summarize('./node_modules/.bin/eslint .')).toStrictEqual([
        ['unsupportedSyntax', './node_modules/.bin/eslint', 'win32'],
      ]);
    });
  });

  describe('single quotes removed by cross-env', () => {
    it.each<[string, Summary[]]>([
      ["cross-env NODE_OPTIONS='--experimental-vm-modules' jest", []],
      ["cross-env A=1 jest --testPathPattern='tests/(?!e2e)'", []],
      ["cross-env A=1 prettier --write 'src/**/*.ts'", []],
      ["cross-env A=1 npx eslint 'src/**'", []],
      // `cross-env-shell` removes them before the shell runs the script, so the string isn't
      // quoted on any platform
      [
        'cross-env-shell "eslint \'src/**\'"',
        [['inconsistentBehavior', "'src/**'", 'darwin,linux,win32']],
      ],
      [
        "cross-env-shell A=1 \"printf '%s|' 'a b' 'open'\"",
        [
          ['unsupportedCommand', 'printf', 'win32'],
          ['inconsistentBehavior', "'%s|'", 'darwin,linux,win32'],
          ['inconsistentBehavior', "'a b'", 'darwin,linux,win32'],
        ],
      ],
      // Its words aren't in the script, and whitespace in a string that `echo` prints is harmless
      ["cross-env-shell A=1 'echo $A'", [['inconsistentBehavior', "'echo $A'", 'win32']]],
      ['cross-env-shell "echo \'a b\'"', []],
      // cmd.exe splits the string at whitespace and interprets its special characters first
      ["cross-env NODE_OPTIONS='--a --b' jest", [['inconsistentBehavior', "'--a --b'", 'win32']]],
      ["cross-env A=1 node -e 'a&b'", [['inconsistentBehavior', "'a&b'", 'win32']]],
      // The suggested fix moves inline assignments to `cross-env`
      ["WATCH_ARGS='open' npm run watch", [['unsupportedSyntax', "WATCH_ARGS='open'", 'win32']]],
      ['NODE_ENV=$ENV node x', [['unsupportedSyntax', 'NODE_ENV=$ENV', 'win32']]],
      [
        'TERM=${TERM_OVERRIDE:-$TERM} node x',
        [
          ['unsupportedSyntax', 'TERM=${TERM_OVERRIDE:-$TERM}', 'win32'],
          ['unsupportedSyntax', '${TERM_OVERRIDE:-$TERM}', 'win32'],
        ],
      ],
      // `cross-env` only replaces `$VAR` and `${VAR}`
      ['cross-env A=${B:-x} node x', [['unsupportedSyntax', '${B:-x}', 'win32']]],
      ['cross-env A=$? node x', [['unsupportedSyntax', '$?', 'win32']]],
      // Standalone assignments aren't arguments of `cross-env`
      [
        'node x; e=$?; exit $e',
        [
          ['unsupportedSyntax', ';', 'win32'],
          ['unsupportedSyntax', 'e=$?', 'win32'],
          ['unsupportedSyntax', '$?', 'win32'],
          ['unsupportedSyntax', ';', 'win32'],
          ['unsupportedSyntax', '$e', 'win32'],
        ],
      ],
      [
        "BODY='a b' node x",
        [
          ['unsupportedSyntax', "BODY='a b'", 'win32'],
          ['inconsistentBehavior', "'a b'", 'win32'],
        ],
      ],
      ["cross-env A=1 node -e 'a\"b'", [['inconsistentBehavior', "'a\"b'", 'win32']]],
      // Only the arguments of `cross-env` are rewritten
      ["cross-env A=1 jest && jest 'src/**'", [['inconsistentBehavior', "'src/**'", 'win32']]],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it('explains why the quotes break', () => {
      const [issue] = analyzeScript("cross-env A=1 jest 'a b'");
      const [nestedIssue] = analyzeScript('cross-env-shell "eslint \'src/**\'"');

      expect(issue?.data.reason).toBe(
        "cmd.exe doesn't treat single quotes as quotes, so it splits the string before `cross-env` removes them",
      );
      expect(nestedIssue?.data.reason).toBe(
        "`cross-env-shell` removes single quotes before the shell runs the script, so the string isn't quoted",
      );
    });
  });

  // Checked against Debian 12's dash and Bash 5.2, and macOS' `/bin/sh` and `/bin/bash` (Bash 3.2)
  describe('shell differences', () => {
    describe("macOS' Bash 3.2", () => {
      it.each<[string, Summary[]]>([
        [
          'case $1 in a) node a ;& b) node b ;; esac',
          [
            ['unsupportedSyntax', 'case', 'win32'],
            ['unsupportedSyntax', ';&', 'darwin,linux'],
          ],
        ],
        [
          'case $1 in a) node a ;;& b) node b ;; esac',
          [
            ['unsupportedSyntax', 'case', 'win32'],
            ['unsupportedSyntax', ';;&', 'darwin,linux'],
          ],
        ],
        ['mapfile -t lines < f', [['unsupportedCommand', 'mapfile', 'darwin,linux,win32']]],
        [
          "bash -c 'readarray -t lines < f'",
          [
            ['unsupportedCommand', 'bash', 'win32'],
            ['unsupportedCommand', 'readarray', 'darwin'],
          ],
        ],
        ['echo ${x@Q}', [['unsupportedSyntax', '${x@Q}', 'darwin,linux,win32']]],
        [
          'bash -c "exec {fd}>log"',
          [
            ['unsupportedCommand', 'bash', 'win32'],
            ['unsupportedSyntax', '{fd}', 'darwin'],
          ],
        ],
        // Bash only disables process substitution in POSIX mode
        ["bash -c 'diff <(a) <(b)'", [['unsupportedCommand', 'bash', 'win32']]],
        [
          "bash -c 'shopt -s globstar; rm -f lib/**/*.js'",
          [
            ['unsupportedCommand', 'bash', 'win32'],
            ['unsupportedUsage', 'shopt -s globstar', 'darwin'],
          ],
        ],
        [
          'shopt -s nullglob globstar',
          [
            ['unsupportedCommand', 'shopt', 'linux,win32'],
            ['unsupportedUsage', 'shopt -s nullglob globstar', 'darwin'],
          ],
        ],
        [
          "bash -c 'echo $EPOCHSECONDS'",
          [
            ['unsupportedCommand', 'bash', 'win32'],
            ['inconsistentBehavior', '$EPOCHSECONDS', 'darwin'],
          ],
        ],
      ])('%j', (script, expected) => {
        expect(summarize(script)).toStrictEqual(expected);
      });
    });

    describe("macOS' BSD utilities", () => {
      it.each<[string, Summary[]]>([
        [
          "grep -RhoP 'a(?=b)' src",
          [
            ['unsupportedCommand', 'grep', 'win32'],
            ['unsupportedUsage', 'grep -RhoP', 'darwin'],
            ['inconsistentBehavior', "'a(?=b)'", 'win32'],
          ],
        ],
        ['grep -E "a|b" f', [['unsupportedCommand', 'grep', 'win32']]],
        [
          'find -name "*.log" -delete',
          [
            ['unsupportedCommand', 'find', 'win32'],
            ['unsupportedUsage', 'find -name', 'darwin'],
          ],
        ],
        ['find -L . -name x', [['unsupportedCommand', 'find', 'win32']]],
        ['find', [['unsupportedCommand', 'find', 'win32']]],
        ['find -L', [['unsupportedCommand', 'find', 'win32']]],
        ['xargs find', [['unsupportedCommand', 'xargs', 'win32']]],
        [
          'find . -name x -printf %p',
          [
            ['unsupportedCommand', 'find', 'win32'],
            ['unsupportedUsage', 'find . -name x -printf', 'darwin'],
          ],
        ],
        [
          'find src -regextype posix-extended -regex ".*"',
          [
            ['unsupportedCommand', 'find', 'win32'],
            ['unsupportedUsage', 'find src -regextype', 'darwin'],
          ],
        ],
        [
          'find . -wholename "*x*"', // cspell:disable-line
          [['unsupportedCommand', 'find', 'win32']],
        ],
        // BSD `sed` doesn't support GNU's escapes, so the pattern silently doesn't match
        [
          String.raw`sed "/^\s*$/d" f`,
          [
            ['unsupportedCommand', 'sed', 'win32'],
            ['inconsistentBehavior', String.raw`sed "/^\s*$/d"`, 'darwin'],
          ],
        ],
        [
          String.raw`sed "s/\([0-9]\+\) bytes/x/" f`,
          [
            ['unsupportedCommand', 'sed', 'win32'],
            ['inconsistentBehavior', String.raw`sed "s/\([0-9]\+\) bytes/x/"`, 'darwin'],
          ],
        ],
        ['sed -E "s/a+/b/" f', [['unsupportedCommand', 'sed', 'win32']]],
        [String.raw`sed "s/a\/b/c/" f`, [['unsupportedCommand', 'sed', 'win32']]],
        // `\+` is a literal `+` in extended regexes, but `-e` takes the script
        [String.raw`sed -nE "s/a\+/b/p" f`, [['unsupportedCommand', 'sed', 'win32']]],
        [String.raw`sed -r "s/a\+/b/" f`, [['unsupportedCommand', 'sed', 'win32']]],
        [
          String.raw`sed -e "s/a\+/b/" f`,
          [
            ['unsupportedCommand', 'sed', 'win32'],
            ['inconsistentBehavior', String.raw`sed -e "s/a\+/b/"`, 'darwin'],
          ],
        ],
        [
          String.raw`sed -i.bak -e "s/a\?/b/" f`,
          [
            ['unsupportedCommand', 'sed', 'win32'],
            ['inconsistentBehavior', String.raw`sed -i.bak -e "s/a\?/b/"`, 'darwin'],
          ],
        ],
        [
          'xargs -a .gitignore rm -rf',
          [
            ['unsupportedCommand', 'xargs', 'win32'],
            ['unsupportedUsage', 'xargs -a', 'darwin'],
          ],
        ],
        ['xargs -I {} -n1 -P4 echo {}', [['unsupportedCommand', 'xargs', 'win32']]],
        [
          'cat --number f',
          [
            ['unsupportedCommand', 'cat', 'win32'],
            ['unsupportedUsage', 'cat --number', 'darwin'],
          ],
        ],
        [
          'fuser -k 3000/tcp',
          [
            ['unsupportedCommand', 'fuser', 'win32'],
            ['unsupportedUsage', 'fuser -k', 'darwin'],
          ],
        ],
        // macOS' `mktemp` supports long options
        ['mktemp --directory', [['unsupportedCommand', 'mktemp', 'win32']]],
        // And `du` and `df` support some
        ['du --si .', [['unsupportedCommand', 'du', 'win32']]],
        [
          'df --si --libxo=json .', // cspell:disable-line
          [['unsupportedCommand', 'df', 'win32']],
        ],
        [
          'du --si --summarize .',
          [
            ['unsupportedCommand', 'du', 'win32'],
            ['unsupportedUsage', 'du --si --summarize', 'darwin'],
          ],
        ],
      ])('%j', (script, expected) => {
        expect(summarize(script)).toStrictEqual(expected);
      });
    });

    describe('dash', () => {
      it.each<[string, Summary[]]>([
        [
          '[ "$CI" == true ] && node x',
          [
            ['unsupportedCommand', '[', 'win32'],
            ['unsupportedUsage', '[ "$CI" ==', 'linux'],
            ['unsupportedSyntax', '$CI', 'win32'],
          ],
        ],
        [
          'test a == b',
          [
            ['unsupportedCommand', 'test', 'win32'],
            ['unsupportedUsage', 'test a ==', 'linux'],
          ],
        ],
        ['[ a = b ] && node x', [['unsupportedCommand', '[', 'win32']]],
        // A quoted `==` is an operand
        [
          '[ "$op" = "==" ]',
          [
            ['unsupportedCommand', '[', 'win32'],
            ['unsupportedSyntax', '$op', 'win32'],
          ],
        ],
        ["bash -c '[ a == b ]'", [['unsupportedCommand', 'bash', 'win32']]],
        [
          'set -euo pipefail',
          [
            ['unsupportedUsage', 'set -euo pipefail', 'linux'],
            ['unsupportedUsage', 'set -euo', 'win32'],
          ],
        ],
        [
          'set -o errexit -o pipefail',
          [
            ['unsupportedUsage', 'set -o errexit -o pipefail', 'linux'],
            ['unsupportedUsage', 'set -o', 'win32'],
          ],
        ],
        ["bash -c 'set -euo pipefail; node x'", [['unsupportedCommand', 'bash', 'win32']]],
        [
          'trap "RC=1" ERR',
          [
            ['unsupportedCommand', 'trap', 'win32'],
            ['unsupportedUsage', 'trap "RC=1" ERR', 'linux'],
          ],
        ],
        ['trap "rm -f tmp" EXIT', [['unsupportedCommand', 'trap', 'win32']]],
        [
          '. .env && node x',
          [
            ['unsupportedCommand', '.', 'win32'],
            ['unsupportedUsage', '. .env', 'linux'],
          ],
        ],
        ['. ./.env && node x', [['unsupportedCommand', '.', 'win32']]],
        [
          '. activate',
          [
            ['unsupportedCommand', '.', 'win32'],
            ['unsupportedUsage', '. activate', 'linux'],
          ],
        ],
        [
          'echo $((2 ** 10))',
          [
            ['unsupportedSyntax', '$((2 ** 10))', 'win32'],
            ['unsupportedSyntax', '$((2 ** 10))', 'linux'],
          ],
        ],
        ['echo $((i + 1))', [['unsupportedSyntax', '$((i + 1))', 'win32']]],
        [
          'echo $((i++))',
          [
            ['unsupportedSyntax', '$((i++))', 'win32'],
            ['unsupportedSyntax', '$((i++))', 'linux'],
          ],
        ],
        [
          'node x --seed=$RANDOM',
          [
            ['unsupportedSyntax', '$RANDOM', 'win32'],
            ['inconsistentBehavior', '$RANDOM', 'linux'],
          ],
        ],
        // `cross-env` takes the value from the environment on Windows, which doesn't have it either
        [
          'cross-env SEED=$RANDOM node x',
          [
            ['inconsistentBehavior', '$RANDOM', 'win32'],
            ['inconsistentBehavior', '$RANDOM', 'linux'],
          ],
        ],
        [
          'node x ${OSTYPE}',
          [
            ['unsupportedSyntax', '${OSTYPE}', 'win32'],
            ['inconsistentBehavior', '${OSTYPE}', 'linux'],
          ],
        ],
        ["bash -c 'node x $RANDOM'", [['unsupportedCommand', 'bash', 'win32']]],
        ['node x >& log', [['unsupportedSyntax', '>& log', 'linux,win32']]],
        ['node x 2>&1 >&2', []],
      ])('%j', (script, expected) => {
        expect(summarize(script)).toStrictEqual(expected);
      });

      // dash fails on it, so the commands after `&&` don't run
      it('explains the report of `trap ... ERR`', () => {
        expect(analyzeScript('trap "RC=1" ERR && node x').at(-1)?.data).toStrictEqual({
          reason: "dash, the `sh` of Debian/Ubuntu, doesn't support the `ERR` condition",
          suggestion: 'Use a Node.js script instead.',
          usage: 'trap ... ERR',
        });
      });
    });

    describe('cmd.exe', () => {
      it.each<[string, Summary[]]>([
        // POSIX shells remove the backslashes of escapes, cmd.exe passes them on
        [String.raw`node x.js foo\ bar`, [['inconsistentBehavior', String.raw`foo\ bar`, 'win32']]],
        [
          String.raw`node -e console.log\(1\)`,
          [['inconsistentBehavior', String.raw`console.log\(1\)`, 'win32']],
        ],
        [
          String.raw`jest --testRegex=.spec.ts\$`,
          [['inconsistentBehavior', String.raw`--testRegex=.spec.ts\$`, 'win32']],
        ],
        [
          'node -e "console.log(\\`a\\`)"',
          [['inconsistentBehavior', '"console.log(\\`a\\`)"', 'win32']],
        ],
        // `cross-env` removes them itself
        [String.raw`cross-env A=1 jest --testRegex=.spec.ts\$`, []],
        // But not other escapes after them
        [
          String.raw`cross-env A=\$A\ b node x`,
          [['inconsistentBehavior', String.raw`A=\$A\ b`, 'win32']],
        ],
        [
          'cross-env A="\\$A \\`x\\`" node x',
          [['inconsistentBehavior', 'A="\\$A \\`x\\`"', 'win32']],
        ],
        // Escaped double quotes mean the same to Node.js on Windows
        [String.raw`node x.js \"a\" "b\"c"`, []],
        // Backslashes too, but only before a `"`
        [String.raw`node x a\\"b" "c\\" "d\\\"e"`, []],
        [String.raw`node x a\\b`, [['inconsistentBehavior', String.raw`a\\b`, 'win32']]],
        [
          String.raw`jest --testPathIgnorePatterns "\\.e2e\\."`,
          [['inconsistentBehavior', String.raw`"\\.e2e\\."`, 'win32']],
        ],
        // `cross-env` replaces them with one backslash itself
        [String.raw`cross-env A=1 node x a\\b`, []],
        // Backslashes in Windows paths and regexes are reported as such, or not at all
        [String.raw`del /q dist\*`, [['unsupportedCommand', 'del', 'darwin,linux']]],
        [String.raw`jest --testPathPattern=logging\.spec\.ts`, []],
        [String.raw`rd .\node_modules\ -r`, [['unsupportedCommand', 'rd', 'darwin,linux']]],
        // `find` has to be replaced on Windows anyway
        [
          String.raw`find . \( -name '*.js' -o -name '*.ts' \) -exec node x {} \;`,
          [['unsupportedCommand', 'find', 'win32']],
        ],
        [String.raw`bash -c 'echo \$HOME'`, [['unsupportedCommand', 'bash', 'win32']]],
        // cmd.exe prints quotes, which only matters if the output is used
        ["svelte-kit sync || echo ''", []],
        ["echo 'Done!' && exit 0", []],
        ["echo 'a' > f", [['inconsistentBehavior', "'a'", 'win32']]],
        ["echo 'a' 1> f", [['inconsistentBehavior', "'a'", 'win32']]],
        ["(echo 'a') > f", [['inconsistentBehavior', "'a'", 'win32']]],
        ["(echo 'a') | node x.js", [['inconsistentBehavior', "'a'", 'win32']]],
        ["(echo 'a')", []],
        ["echo 'a' >&2 && echo 'b' 1>&2 && echo 'c' 2>&1 && echo 'd' 2> err.log", []],
        [
          "echo 'a' | xargs rm",
          [
            ['inconsistentBehavior', "'a'", 'win32'],
            ['unsupportedCommand', 'xargs', 'win32'],
          ],
        ],
        // cmd.exe's escape character
        ['npm i mobx@^5.15.0', [['inconsistentBehavior', 'mobx@^5.15.0', 'win32']]],
        [
          'turbo run build --filter=app^...',
          [['inconsistentBehavior', '--filter=app^...', 'win32']],
        ],
        ['pnpm run "/^dev:.*/"', []],
        ['cross-env A=1 npm i mobx@^5', [['inconsistentBehavior', 'mobx@^5', 'win32']]],
        ['npx . --config', []],
        ['rmdir lib /s/q', [['unsupportedUsage', 'rmdir lib /s/q', 'darwin,linux']]],
        // `&` is meant for cmd.exe in scripts with Windows commands
        ['rd /s /q dist & npm run build', [['unsupportedCommand', 'rd', 'darwin,linux']]],
        // Not in scripts with other issues on macOS and Linux
        [
          'node x $EPOCHSECONDS & node y',
          [
            ['unsupportedSyntax', '$EPOCHSECONDS', 'win32'],
            ['inconsistentBehavior', '$EPOCHSECONDS', 'darwin,linux'],
            ['inconsistentBehavior', '&', 'win32'],
          ],
        ],
        [
          'node x\r & node y',
          [
            ['inconsistentBehavior', '\r', 'darwin,linux'],
            ['inconsistentBehavior', '&', 'win32'],
          ],
        ],
        ['npm run a & npm run b', [['inconsistentBehavior', '&', 'win32']]],
        [
          "bash -c 'open x' & npm run a",
          [
            ['unsupportedCommand', 'bash', 'win32'],
            ['unsupportedCommand', 'open', 'linux'],
            ['inconsistentBehavior', '&', 'win32'],
          ],
        ],
        // cmd.exe builtins
        ['rem node build.js', [['unsupportedCommand', 'rem', 'darwin,linux']]],
        // Placeholders of the tool rather than Windows variables
        [
          "lokalise2 file download --bundle-structure '%LANG_ISO%.json'",
          [['inconsistentBehavior', "'%LANG_ISO%.json'", 'win32']],
        ],
        // A known limit: without single quotes, they can't be told from Windows variables
        [
          'lokalise2 file download --bundle-structure "%LANG_ISO%.json"',
          [['unsupportedSyntax', '"%LANG_ISO%.json"', 'darwin,linux']],
        ],
        ['setlocal && node x', [['unsupportedCommand', 'setlocal', 'darwin,linux']]],
        // It prints a file in cmd.exe, but tells what a command is in POSIX shells
        ['type a.txt > b.txt', [['inconsistentBehavior', 'type', 'darwin,linux,win32']]],
        ['TYPE a.txt', [['inconsistentBehavior', 'TYPE', 'darwin,linux,win32']]],
        ['sh -c "type node"', [['unsupportedCommand', 'sh', 'win32']]],
      ])('%j', (script, expected) => {
        expect(summarize(script)).toStrictEqual(expected);
      });

      it.each<[string, Summary[]]>([
        [String.raw`echo \$HOME`, []],
        ['node x --seed=$RANDOM', []],
        ['npm i mobx@^5', []],
        // Yarn's shell has no `set`
        ['set NODE_ENV=production&& node x', [['unsupportedCommand', 'set', 'darwin,linux,win32']]],
        ['[ a == b ] && node x', [['unsupportedCommand', '[', 'win32']]],
        ['rem node build.js', [['unsupportedCommand', 'rem', 'darwin,linux,win32']]],
        // It can't run cmd.exe's `type` on Windows
        ['type node', [['unsupportedCommand', 'type', 'win32']]],
        [
          String.raw`node "scripts\build.js"`,
          [['inconsistentBehavior', String.raw`"scripts\build.js"`, 'darwin,linux']],
        ],
        [
          String.raw`node scripts\build.js`,
          [['inconsistentBehavior', String.raw`scripts\build.js`, 'darwin,linux,win32']],
        ],
      ])('%j in the portable shell', (script, expected) => {
        expect(summarize(script, yarn)).toStrictEqual(expected);
      });
    });
  });

  describe('other regressions', () => {
    it.each<[string, Summary[]]>([
      // Alternatives that together work on all platforms
      ['open x || xdg-open x || start x', []],
      // cmd.exe's `echo` writes quotes into files
      [
        String.raw`echo "{\"type\":\"module\"}" > dist/package.json`,
        [['inconsistentBehavior', String.raw`"{\"type\":\"module\"}"`, 'win32']],
      ],
      ['echo "hi" && echo "x" >> log 2>&1', [['inconsistentBehavior', '"x"', 'win32']]],
      ['echo "hi"', []],
      ['echo "x" 2> err.log', []],
      // macOS' `sh` is Bash in POSIX mode, so `echo` doesn't take options
      ["bash -c 'echo -n x'", [['unsupportedCommand', 'bash', 'win32']]],
      // GNU-only options
      [
        'head -n -1 f && head -n-1 f && head -n 5 f',
        [
          ['unsupportedCommand', 'head', 'win32'],
          ['unsupportedUsage', 'head -n -1', 'darwin'],
          ['unsupportedCommand', 'head', 'win32'],
          ['unsupportedUsage', 'head -n-1', 'darwin'],
          ['unsupportedCommand', 'head', 'win32'],
        ],
      ],
      [
        'du -sb dist',
        [
          ['unsupportedCommand', 'du', 'win32'],
          ['unsupportedUsage', 'du -sb', 'darwin'],
        ],
      ],
      [
        'cp -t dist a b',
        [
          ['unsupportedCommand', 'cp', 'win32'],
          ['unsupportedUsage', 'cp -t', 'darwin'],
        ],
      ],
      // Options that BSD tools on current macOS support
      [
        'xargs --null rm && sort --ignore-case f',
        [
          ['unsupportedCommand', 'xargs', 'win32'],
          ['unsupportedUsage', 'sort --ignore-case', 'win32'],
        ],
      ],
      [
        'wc --lines f',
        [
          ['unsupportedCommand', 'wc', 'win32'],
          ['unsupportedUsage', 'wc --lines', 'darwin'],
        ],
      ],
      // Quoted paths work with cmd.exe's `mkdir`
      ['mkdir "dist/esm"', []],
      // GNU coreutils ship `dir`, macOS doesn't
      ['dir', [['unsupportedCommand', 'dir', 'darwin']]],
      [
        'dir /b',
        [
          ['unsupportedCommand', 'dir', 'darwin'],
          ['unsupportedUsage', 'dir /b', 'linux'],
        ],
      ],
      // Linux finds commands by their exact name
      ['DIR /b', [['unsupportedCommand', 'DIR', 'darwin,linux']]],
      ['wget https://example.com', [['unsupportedCommand', 'wget', 'darwin,win32']]],
      // Node.js resolves `/tmp` on Windows too
      ['node x /tmp/out', []],
      // `cross-env` behind another command still replaces variables and removes single quotes
      [
        'npx cross-env NODE_ENV=production webpack --env mode=$MODE',
        [['inconsistentBehavior', '$MODE', 'win32']],
      ],
      [
        'npx cross-env NODE_ENV=production webpack --env mode=$NODE_ENV',
        [
          ['inconsistentBehavior', '$NODE_ENV', 'darwin,linux'],
          ['inconsistentBehavior', '$NODE_ENV', 'win32'],
        ],
      ],
      ["pnpm exec cross-env A=1 node x 'ab'", []],
      // But only in the words after it
      [
        'npx -p $PKG cross-env A=1 node x $B',
        [
          ['unsupportedSyntax', '$PKG', 'win32'],
          ['inconsistentBehavior', '$B', 'win32'],
        ],
      ],
      // cmd.exe runs the operators in single-quoted strings that `echo` prints
      ["echo 'Done & dusted'", [['inconsistentBehavior', "'Done & dusted'", 'win32']]],
      ["echo '==> Building'", [['inconsistentBehavior', "'==> Building'", 'win32']]],
      // cmd.exe's `echo` writes quotes into pipes and through groups too
      ['echo "y" | some-cli', [['inconsistentBehavior', '"y"', 'win32']]],
      ['(echo "a") > f', [['inconsistentBehavior', '"a"', 'win32']]],
      ['echo "a" 1> f', [['inconsistentBehavior', '"a"', 'win32']]],
      // Devices don't keep the output
      ['echo "x" > /dev/null', [['unsupportedSyntax', '/dev/null', 'win32']]],
      ["echo 'x' > /dev/null", [['unsupportedSyntax', '/dev/null', 'win32']]],
      // A `-c` after a script file is the script's own argument
      ['bash ./deploy.sh -c "find -name x"', [['unsupportedCommand', 'bash', 'win32']]],
      ['sh ./run.sh -c "source x"', [['unsupportedCommand', 'sh', 'win32']]],
      // An option with a value doesn't end the shell's options
      [
        'bash -euo pipefail -c "find -name x"',
        [
          ['unsupportedCommand', 'bash', 'win32'],
          ['unsupportedUsage', 'find -name', 'darwin'],
        ],
      ],
      // GNU `timeout` runs a command, unlike cmd.exe's
      [
        'timeout -k 5 10 open x',
        [
          ['unsupportedCommand', 'timeout', 'darwin,win32'],
          ['unsupportedCommand', 'open', 'linux'],
        ],
      ],
      ['timeout /t 10', [['unsupportedUsage', 'timeout /t', 'darwin,linux']]],
      // `\b` after an escaped backslash is a plain letter
      [
        String.raw`sed 's/a\\b/x/' f`,
        [
          ['unsupportedCommand', 'sed', 'win32'],
          ['inconsistentBehavior', String.raw`'s/a\\b/x/'`, 'win32'],
        ],
      ],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('ignoreCommands', () => {
    it.each<[string, string[], Summary[]]>([
      ['rm -rf dist && cp a b', ['rm'], [['unsupportedCommand', 'cp', 'win32']]],
      ['cross-env A=1 rm x', ['rm'], []],
      ['xargs rm < files', ['xargs'], [['unsupportedCommand', 'rm', 'win32']]],
      ['sh -c "rm x"', ['sh'], [['unsupportedCommand', 'rm', 'win32']]],
      // The builtins of the shell that runs the script exist wherever it does
      ['sh -c "export A=1 && . ./x && true && [ -f a ] && printf x"', ['sh'], []],
      ['sh -c "set -e"', ['sh'], []],
      [
        'bash -c "source .env && cd x && export A=1 && read y && mapfile z"',
        ['bash'],
        [['unsupportedCommand', 'mapfile', 'darwin']],
      ],
      ['./scripts/build.sh', ['./scripts/build.sh'], []],
      ['sed -i x f', ['sed'], []],
      // cmd.exe still reads the quotes differently
      [
        "sh -c 'echo hi && ls'",
        ['sh', 'ls'],
        [['inconsistentBehavior', "'echo hi && ls'", 'win32']],
      ],
      ["find . -name '*.js'", ['find'], [['inconsistentBehavior', "'*.js'", 'win32']]],
      // Linux needs the exact name, and macOS too for builtins without executables
      ['RM -rf dist', ['rm'], [['unsupportedCommand', 'RM', 'linux']]],
      ['EXPORT A=1', ['export'], [['unsupportedCommand', 'EXPORT', 'darwin,linux']]],
      ['RM -rf dist', ['rm', 'RM'], []],
    ])('%j with %j', (script, ignoreCommands, expected) => {
      expect(summarize(script, {ignoreCommands})).toStrictEqual(expected);
    });
  });

  describe('dependencies', () => {
    it("doesn't assume that commands named like a dependency are its binaries", () => {
      // cspell:disable-next-line
      // e.g. the `touch` package's binary is `nodetouch`
      expect(summarize('touch x', {dependencies: ['touch']})).toStrictEqual([
        ['unsupportedCommand', 'touch', 'win32'],
      ]);
    });

    it("reports del-cli's `del`, which cmd.exe's builtin shadows", () => {
      expect(summarize('del dist', {dependencies: ['del-cli']})).toStrictEqual([
        ['inconsistentBehavior', 'del', 'win32'],
      ]);
    });

    // Linux only finds the binary by its exact name
    it.each<[AnalyzeScriptOptions, Summary[]]>([
      [
        {},
        [
          ['inconsistentBehavior', 'DEL', 'win32'],
          ['unsupportedCommand', 'DEL', 'linux'],
        ],
      ],
      [yarn, [['unsupportedCommand', 'DEL', 'linux']]],
    ])("reports del-cli's `del` in the wrong case with %j", (options, expected) => {
      expect(summarize('DEL dist', {...options, dependencies: ['del-cli']})).toStrictEqual(
        expected,
      );
    });

    it.each<AnalyzeScriptOptions>([yarn, {runner: 'pnpm', shellEmulator: true}])(
      "doesn't report del-cli's `del` in Yarn's shell, which can't run cmd.exe's builtins (%j)",
      (options) => {
        expect(summarize('del dist', {...options, dependencies: ['del-cli']})).toStrictEqual([]);
      },
    );

    it("reports del-cli's `del` that another command starts in Yarn's shell", () => {
      expect(
        summarize('cross-env A=1 del dist', {...yarn, dependencies: ['del-cli']}),
      ).toStrictEqual([['inconsistentBehavior', 'del', 'win32']]);
    });
  });

  it.each([
    ':-<<`&><<<\\',
    '-rf${|&.\\',
    '!<<-rffi`;&a 2>&1.\\', // cspell:disable-line
    '<<`<A=\\',
    '${|&sh -c do\\',
    'if}<<if`A==${then\\',
  ])('keeps the ranges of malformed script %j within the script', (script) => {
    analyzeScript(script).forEach(({end, fix, pos}) => {
      [{end, pos}, ...(fix?.edits || [])].forEach((range) => {
        expect(range.pos).toBeGreaterThanOrEqual(0);
        expect(range.end).toBeGreaterThanOrEqual(range.pos);
        expect(range.end).toBeLessThanOrEqual(script.length);
      });
    });
  });

  it('reports message data', () => {
    expect(analyzeScript('rm -rf dist')).toStrictEqual([
      {
        data: {command: 'rm', suggestion: 'Use `rimraf` instead.'},
        end: 2,
        fix: {
          description: 'Replace `rm -rf` with `rimraf`.',
          edits: [{end: 6, pos: 0, text: 'rimraf'}],
        },
        messageId: 'unsupportedCommand',
        platforms: ['win32'],
        pos: 0,
        runners: ['npm'],
      },
    ]);
  });

  describe('fixes', () => {
    it.each<[string, FixSummary[]]>([
      // Commands
      ['rm -rf dist', [['rm', 'Replace `rm -rf` with `rimraf`.', 'rimraf dist']]],
      ['rm -r -f a b', [['rm', 'Replace `rm -r -f` with `rimraf`.', 'rimraf a b']]],
      ['rm dist.zip', [['rm', 'Replace `rm` with `rimraf`.', 'rimraf dist.zip']]],
      ['rm -rf -- dist', [['rm', 'Replace `rm -rf` with `rimraf`.', 'rimraf -- dist']]],
      [
        'rm -rf dist/* .cache',
        [
          [
            'rm',
            'Replace `rm -rf` with `rimraf --glob`, and quote the globs.',
            'rimraf --glob "dist/*" .cache',
          ],
        ],
      ],
      // With `--glob`, the other paths are patterns too
      ['rm -rf "dist [old]" *.log', []],
      ['rm -rf $DIR *.log', []],
      ['env CI=1 jest', [['env', 'Replace `env` with `cross-env`.', 'cross-env CI=1 jest']]],
      [
        'export CI=1 A="b c" && jest',
        [['export', 'Replace `export ... &&` with `cross-env`.', 'cross-env CI=1 A="b c" jest']],
      ],
      // `cross-env` would run `exit` with the fix of `true`
      ['export A=1 && true', [['true', exitZeroDescription('true'), 'export A=1 && exit 0']]],
      ['tsc || true', [['true', exitZeroDescription('true'), 'tsc || exit 0']]],
      ['tsc || :', [[':', exitZeroDescription(':'), 'tsc || exit 0']]],
      ['vitest && false', [['false', 'Replace `false` with `exit 1`.', 'vitest && exit 1']]],
      [
        'concurrently "tsc || true"',
        [['true', exitZeroDescription('true'), 'concurrently "tsc || exit 0"']],
      ],
      [
        'source .env && tsc',
        [['source', 'Replace `source .env` with `. ./.env`.', '. ./.env && tsc']],
      ],
      // The file may be in `PATH`, where macOS' `sh` looks first
      [
        'source activate && python x.py',
        [['source', 'Replace `source activate` with `. activate`.', '. activate && python x.py']],
      ],
      [
        './node_modules/.bin/eslint .',
        [
          [
            './node_modules/.bin/eslint',
            'Replace `./node_modules/.bin/eslint` with `eslint`.',
            'eslint .',
          ],
        ],
      ],
      [
        './scripts/build.mjs --watch',
        [['./scripts/build.mjs', 'Run the file with `node`.', 'node ./scripts/build.mjs --watch']],
      ],
      // The binary's name may run the binary of another package there
      ['cd packages/a && ./node_modules/.bin/tsc', []],
      ['pushd a && ./node_modules/.bin/tsc', []],
      ['cd packages/app && concurrently "./node_modules/.bin/tsc -w" "node x"', []],
      ['cd packages/app && npx -c "./node_modules/.bin/tsc"', []],
      [`cd a && concurrently "npx -c './node_modules/.bin/tsc'"`, []],
      [
        `concurrently "npx -c './node_modules/.bin/tsc'" && cd a`,
        [
          [
            './node_modules/.bin/tsc',
            'Replace `./node_modules/.bin/tsc` with `tsc`.',
            `concurrently "npx -c 'tsc'" && cd a`,
          ],
        ],
      ],
      [
        'pnpm -C dir exec ./node_modules/.bin/tsc',
        [
          [
            './node_modules/.bin/tsc',
            'Replace `./node_modules/.bin/tsc` with `tsc`.',
            'pnpm -C dir exec tsc',
          ],
        ],
      ],
      [
        'cd a && ./build.js',
        [['./build.js', 'Run the file with `node`.', 'cd a && node ./build.js']],
      ],

      // Assignments
      [
        'CI=1 FORCE_COLOR=0 jest',
        [
          ['CI=1', CROSS_ENV, 'cross-env CI=1 FORCE_COLOR=0 jest'],
          ['FORCE_COLOR=0', CROSS_ENV, 'cross-env CI=1 FORCE_COLOR=0 jest'],
        ],
      ],
      [
        'A=1 B=2 C=3 jest',
        [
          ['A=1', CROSS_ENV, 'cross-env A=1 B=2 C=3 jest'],
          ['B=2', CROSS_ENV, 'cross-env A=1 B=2 C=3 jest'],
          ['C=3', CROSS_ENV, 'cross-env A=1 B=2 C=3 jest'],
        ],
      ],
      // Only a command with nothing but plain assignments before it gets `cross-env`
      ['A=1 2>/dev/null B=2 jest', [['/dev/null', 'Remove `2>/dev/null`.', 'A=1 B=2 jest']]],
      // `$A` is the outer value either way, as `A=1` comes after it. Quotes keep shells from
      // splitting the values, which they don't do in assignments
      [
        'B=$A A=1 jest',
        [
          ['B=$A', CROSS_ENV, 'cross-env B="$A" A=1 jest'],
          ['A=1', CROSS_ENV, 'cross-env B="$A" A=1 jest'],
        ],
      ],
      ['PATH=$PATH:bin jest', [['PATH=$PATH:bin', CROSS_ENV, 'cross-env PATH="$PATH:bin" jest']]],
      [
        'A=$(ls src) B=*.js node x',
        [
          ['A=$(ls src)', CROSS_ENV, 'cross-env A="$(ls src)" B="*.js" node x'],
          ['B=*.js', CROSS_ENV, 'cross-env A="$(ls src)" B="*.js" node x'],
        ],
      ],
      [
        'export A=$B && C=$D jest',
        [
          ['export', 'Replace `export ... &&` with `cross-env`.', 'cross-env A="$B" C="$D" jest'],
          ['C=$D', CROSS_ENV, 'export A=$B && cross-env C="$D" jest'],
        ],
      ],
      // `cross-env` changes these values or words, or shells expand `~` only in assignments
      ['NODE_ENV=test node -e "console.log(\'hi\')"', []],
      ['A="\'x\'" node y', []],
      ['A=\\$B node y', []],
      ['A=~/x node y', []],
      ['A=x:~/y node z', []],
      ['A=1 node x ""', []],
      [String.raw`A=1 node "a\\\$b"`, []],
      ['A=$(ls "a") node x', []],
      ['export NODE_ENV=test && node -e "require(\'./x\')"', []],
      ['env CI=1 node -e "console.log(\'hi\')"', []],
      ["env CI='$A' node x", []],
      // The shell splits the values of `env` the same way
      ['env CI=$A node x', [['env', 'Replace `env` with `cross-env`.', 'cross-env CI=$A node x']]],

      // Quotes and escapes
      [
        "eslint 'src/**/*.ts'",
        [["'src/**/*.ts'", 'Use escaped double quotes instead.', 'eslint "src/**/*.ts"']],
      ],
      ['eslint src/**/*.ts', [['src/**/*.ts', QUOTE, 'eslint "src/**/*.ts"']]],
      ['npm i mobx@^5', [['mobx@^5', QUOTE, 'npm i "mobx@^5"']]],
      [
        String.raw`node .\scripts\build.js`,
        [
          [
            String.raw`.\scripts\build.js`,
            String.raw`Replace ${'`'}.\scripts\build.js${'`'} with ${'`'}./scripts/build.js${'`'}.`,
            'node ./scripts/build.js',
          ],
        ],
      ],
      // cmd.exe's own commands read `/a.txt` as an option
      [String.raw`type src\a.txt > out.txt`, []],
      [String.raw`more src\a.txt`, []],
      [String.raw`set OUT=dist\app\x.js`, []],
      [
        String.raw`mocha --spec=test\unit\a.js`,
        [
          [
            String.raw`--spec=test\unit\a.js`,
            String.raw`Replace ${'`'}--spec=test\unit\a.js${'`'} with ${'`'}--spec=test/unit/a.js${'`'}.`,
            'mocha --spec=test/unit/a.js',
          ],
        ],
      ],
      [
        String.raw`node scripts\build.js`,
        [
          [
            String.raw`scripts\build.js`,
            String.raw`Replace ${'`'}scripts\build.js${'`'} with ${'`'}scripts/build.js${'`'}.`,
            'node scripts/build.js',
          ],
        ],
      ],
      [
        String.raw`tsc --outDir ..\dist`,
        [
          [
            String.raw`..\dist`,
            String.raw`Replace ${'`'}..\dist${'`'} with ${'`'}../dist${'`'}.`,
            'tsc --outDir ../dist',
          ],
        ],
      ],
      // The fixed path is a `**/` glob, which `sh` doesn't expand recursively
      [
        String.raw`tool src\**\*.js`,
        [
          [
            String.raw`src\**\*.js`,
            String.raw`Replace ${'`'}src\**\*.js${'`'} with ${'`'}"src/**/*.js"${'`'}.`,
            'tool "src/**/*.js"',
          ],
        ],
      ],
      [
        String.raw`tool --files=src\**\*.js`,
        [
          [
            String.raw`--files=src\**\*.js`,
            String.raw`Replace ${'`'}--files=src\**\*.js${'`'} with ${'`'}--files=src/**/*.js${'`'}.`,
            'tool --files=src/**/*.js',
          ],
        ],
      ],

      // Separators, groups and comments
      [
        'tsc; vite build',
        [
          [
            ';',
            'Replace `;` with `&&`, which stops at the first failing command.',
            'tsc && vite build',
          ],
        ],
      ],
      [
        'tsc ;vite build',
        [
          [
            ';',
            'Replace `;` with `&&`, which stops at the first failing command.',
            'tsc && vite build',
          ],
        ],
      ],
      ['tsc;', [[';', 'Remove the `;`.', 'tsc']]],
      // The line break after `\` and a carriage return isn't replaced, as the fix of the carriage
      // return joins the lines
      ['tsc \\\r\n--noEmit', [['\r', 'Remove the carriage return.', 'tsc \\\n--noEmit']]],
      // A space keeps the comment apart from the word before it
      [
        'node x;# note',
        [
          [';', 'Remove the `;`.', 'node x # note'],
          ['# note', 'Remove the comment.', 'node x;'],
        ],
      ],
      [
        '{ tsc; vite build; } > log',
        [['{', 'Replace `{ ... }` with `( ... )`.', '( tsc; vite build; ) > log']],
      ],
      // Bash reads `((` as an arithmetic command
      [
        '({ tsc; vite build; })',
        [['{', 'Replace `{ ... }` with `( ... )`.', '( ( tsc; vite build; ) )']],
      ],
      ['tsc # build', [['# build', 'Remove the comment.', 'tsc']]],
      ['# Build\ntsc', [['# Build', 'Remove the comment.', 'tsc']]],
      ['tsc\n# Done', [['# Done', 'Remove the comment.', 'tsc']]],
      [
        'a\n# c1\n# c2\nb',
        [
          ['# c1', 'Remove the comment.', 'a\n# c2\nb'],
          ['# c2', 'Remove the comment.', 'a\n# c1\nb'],
        ],
      ],
      [
        'tsc\r\n# Done',
        [
          ['\r', 'Remove the carriage return.', 'tsc\n# Done'],
          ['# Done', 'Remove the comment.', 'tsc'],
        ],
      ],
      // A comment ends at the line feed, so it includes the carriage return
      ['tsc # c\r\nvite build', [['# c\r', 'Remove the comment.', 'tsc\nvite build']]],
      ['(tsc;)', [[';', 'Remove the `;`.', '(tsc)']]],
      ['(node a.js # c\n)', [['# c', 'Remove the comment.', '(node a.js\n)']]],
      // The `\` line continuation is removed instead of the line break after the comment
      ['a \\\n# c\nb', [['# c', 'Remove the comment.', 'a\nb']]],
      [
        'mkdir -p dist/{esm,cjs}',
        [
          [
            '{esm,cjs}',
            'Replace `dist/{esm,cjs}` with `dist/esm dist/cjs`.',
            'mkdir -p dist/esm dist/cjs',
          ],
        ],
      ],

      // Redirections
      ['a |& b', [['|&', 'Replace `|&` with `2>&1 |`.', 'a 2>&1 | b']]],
      ['a|&b', [['|&', 'Replace `|&` with `2>&1 |`.', 'a 2>&1 |b']]],
      ['bash -c "a |& b"', [['|&', 'Replace `|&` with `2>&1 |`.', 'bash -c "a 2>&1 | b"']]],
      [
        'tsc &> build.log',
        [
          [
            '&> build.log',
            'Replace `&> build.log` with `> build.log 2>&1`.',
            'tsc > build.log 2>&1',
          ],
        ],
      ],
      [
        'tsc &>>build.log',
        [
          [
            '&>>build.log',
            'Replace `&>>build.log` with `>> build.log 2>&1`.',
            'tsc >> build.log 2>&1',
          ],
        ],
      ],
      [
        'tsc >& build.log',
        [
          [
            '>& build.log',
            'Replace `>& build.log` with `> build.log 2>&1`.',
            'tsc > build.log 2>&1',
          ],
        ],
      ],
      ['tsc 2>| err.log', [['2>| err.log', 'Replace `>|` with `>`.', 'tsc 2> err.log']]],
      // Bash passes `2` as an argument
      ['a 2&>log', [['&>log', 'Replace `&>log` with `> log 2>&1`.', 'a 2 > log 2>&1']]],
      ['tsc > /dev/null 2>&1', [['/dev/null', 'Remove `> /dev/null`.', 'tsc 2>&1']]],
      ['>/dev/null tsc', [['/dev/null', 'Remove `>/dev/null`.', 'tsc']]],
      [
        'node a.js | node b.js > /dev/null',
        [['/dev/null', 'Remove `> /dev/null`.', 'node a.js | node b.js']],
      ],
      // Only the standard output goes into the pipe
      [
        'node a.js 2>/dev/null | node b.js',
        [['/dev/null', 'Remove `2>/dev/null`.', 'node a.js | node b.js']],
      ],
      [
        'tsc \\\n> /dev/null',
        [
          ['\n', 'Join the lines.', 'tsc > /dev/null'],
          ['/dev/null', 'Remove `> /dev/null`.', 'tsc'],
        ],
      ],
      [
        'tsc \\\n> /dev/null\nvite build',
        [
          ['\n', 'Join the lines.', 'tsc > /dev/null\nvite build'],
          ['/dev/null', 'Remove `> /dev/null`.', 'tsc\nvite build'],
        ],
      ],

      // Usage
      ['. .env', [['. .env', 'Replace `.env` with `./.env`.', '. ./.env']]],
      [
        '[ "$CI" == true ] && npm publish',
        [['[ "$CI" ==', 'Replace `==` with `=`.', '[ "$CI" = true ] && npm publish']],
      ],
      [
        'find -name "*.log" -delete',
        [['find -name', 'Add `.` before the expression.', 'find . -name "*.log" -delete']],
      ],
    ])('%j', (script, expected) => {
      expect(summarizeFixes(script)).toStrictEqual(expected);
    });

    it("replaces del-cli's `del`", () => {
      expect(summarizeFixes('del dist', {dependencies: ['del-cli']})).toStrictEqual([
        ['del', 'Replace `del` with `del-cli`.', 'del-cli dist'],
      ]);
      expect(summarizeFixes('DEL dist', {dependencies: ['del-cli']})).toStrictEqual([
        ['DEL', 'Replace `DEL` with `del-cli`.', 'del-cli dist'],
        ['DEL', 'Replace `DEL` with `del-cli`.', 'del-cli dist'],
      ]);
    });

    it('puts the name of an ignored command in lower case', () => {
      expect(summarizeFixes('RM -rf dist', {ignoreCommands: ['rm']})).toStrictEqual([
        ['RM', 'Replace `RM` with `rm`.', 'rm -rf dist'],
      ]);
    });

    it.each([
      // Options and arguments that the replacement doesn't support the same way
      'rm -rfv dist',
      'rm -rf',
      'rm -rf "$DIR"/*',
      // `rimraf` matches `**` recursively, unlike `sh`
      'rm -rf packages/**/dist',
      'env -i jest',
      'env',
      // The variables would also apply to `vite build`
      'export CI=1 && jest && vite build',
      // The shell would expand the variables before `cross-env` sets them
      'export PORT=3000 && next dev -p $PORT',
      'export PORT=3000 && next dev -p "${PORT:-1}"',
      // `exit` would skip the commands that follow
      'tsc || true && vite build',
      '(tsc || true)',
      'tsc || true &',
      'true | tsc',
      ': ${A:=b}',
      // cmd.exe's `echo` writes the double quotes into the file too
      "echo 'a b' > out.txt",
      // Double quotes would change these strings
      `node -e 'console.log("x")'`,
      "echo 'cost: $5' | tee log",
      // A double quote would end the outer string
      `concurrently "eslint 'src'"`,
      // OS utilities and other well-known programs don't expand globs themselves
      'cat src/**/*.js',
      'tar -czf a.tgz dist/**/*.js',
      'git add src/**/*.ts',
      'docker build -f docker/**/Dockerfile .',
      'python lint.py src/**/*.py',
      'node build.js src/**/*.ts',
      // POSIX shells keep the backslashes of a regex in double quotes
      String.raw`jest -t "adds\stwo\snumbers"`,
      String.raw`jest -t "v\d\.\d"`,
      String.raw`mocha --grep "User\sLogin\sTest"`,
      // `&&` would run `echo` when `tsc` fails
      'tsc; vite build || echo failed',
      'tsc; vite build &',
      // `&&` can't precede the `\` at the end of the script
      'tsc; \\',
      'tsc\n\\',
      // The file may be in `PATH`, where macOS' `sh` looks first
      '. env.sh',
      './bin/cli',
      // A command or builtin with the same name would run instead, e.g. cmd.exe's `del`
      './node_modules/.bin/del dist',
      'node_modules/.bin/copy a b',
      'node_modules/.bin/Copy a b',
      // cmd.exe's own commands treat `/` as an option prefix
      String.raw`cd .\src\lib`,
      String.raw`IF EXIST .\dist RMDIR /Q /S .\dist`,
      // A subshell keeps `cd` from changing the directory of the commands that follow
      '{ cd lib && tsc; } && jest',
      // Removing an input redirection makes the command read the terminal
      'tsc < /dev/null',
      // Removing a redirection that is a whole command leaves an incomplete pipeline
      'tsc | 2>/dev/null',
      // Without the redirection, the output would go into the pipe or the file
      'node a.js > /dev/null | node b.js',
      'node a.js 2>&1 >/dev/null | grep x',
      '(node a.js 1>/dev/null) > out.log',
      'node a.js > out.log >> /dev/null',
      // A subshell keeps `exit` and variables from affecting the commands that follow
      'test -f x || { echo missing; exit 1; }',
      '{ A=1; } && echo $A',
      // In a subshell, `exec` doesn't replace the shell that runs the commands that follow
      '{ exec node x; } && tsc',
      // `wait` doesn't wait for the jobs of a subshell
      '{ node a.js & node b.js & } && wait',
      '{ { node a.js & }; } && wait',
      // dash sets `PORT` before it expands `$PORT`, but the shell would expand the arguments of
      // `cross-env` before `cross-env` sets any of them
      'PORT=3000 URL=http://localhost:$PORT node x',
      'A=1 A=$A:2 node x',
      // `cross-env` can't run shell builtins
      'A=1 cd x',
      'A=1 B+=2 jest',
      'A=1 exec node x',
      'A=1 :',
      'export A=1 && cd x',
      // In double quotes, the placeholder would be reported as a Windows variable
      "lokalise2 file download --bundle-structure '%LANG_ISO%.json'",
      // A `-c` after a script file is the script's own argument
      'bash ./deploy.sh -c "find -name x"',
      'mkdir -p dist/{a,$B}',
      'grep -v ^$ log',
      // Positions in escaped nested scripts can't be mapped
      String.raw`sh -c "echo \"\$(a |& b)\""`,
      // Shells don't expand braces there, unlike in the arguments of `cross-env`
      'FOO={a,b} node x.js',
      'node x.js > out.{log,txt}',
      'case {a,b} in a) node x;; esac',
      'node x <<< {a,b}',
      // Bash expands the whole assignment, e.g. to `A=a A=b`
      'export A={a,b}',
    ])('%j', (script) => {
      expect(summarizeFixes(script)).toStrictEqual([]);
    });
  });

  it('truncates long snippets', () => {
    const [issue] = analyzeScript(`echo $(node -e "${'x'.repeat(50)}")`);

    expect(issue?.data.syntax).toBe(`The command substitution \`$(node -e "${'x'.repeat(26)}...\``);
  });
});
