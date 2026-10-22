import {type AnalyzeScriptOptions, analyzeScript, applyFix} from '../src/index.ts';

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
    .toSorted((left, right) => left.pos - right.pos)
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
const summarizeFixes = (script: string, options?: AnalyzeScriptOptions): FixSummary[] =>
  analyzeScript(script, options)
    .toSorted((left, right) => left.pos - right.pos)
    .flatMap(({end, fix, pos}): FixSummary[] =>
      fix ? [[script.slice(pos, end), fix.description, applyFix(script, fix)]] : [],
    );

const portable = {portableShell: true};
const yarnClassic = {yarnClassic: true};

const QUOTE = 'Quote it with escaped double quotes.';
const CROSS_ENV = 'Prefix the command with `cross-env`.';

describe('analyzeScript', () => {
  describe('portable scripts', () => {
    it.each([
      'node build.js',
      'tsc && vite build',
      'eslint . --max-warnings 0',
      'npm run build -- --watch',
      'cross-env NODE_ENV=production node server.js',
      'cross-env NODE_ENV=production webpack --env mode=$NODE_ENV',
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

    it('ignores commands in ignoreCommands', () => {
      expect(summarize('rm -rf dist && cp a b', {ignoreCommands: ['rm']})).toStrictEqual([
        ['unsupportedCommand', 'cp', 'win32'],
      ]);
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
      [
        'base64 -w 0 file',
        [
          ['unsupportedCommand', 'base64', 'win32'],
          ['unsupportedUsage', 'base64 -w', 'darwin'],
        ],
      ],
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
    ])('%s', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it('only considers options before --', () => {
      expect(summarize('rm -- --recursive')).toStrictEqual([['unsupportedCommand', 'rm', 'win32']]);
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
          ['unsupportedSyntax', '{fd}', 'linux,win32'],
        ],
      ],
      ['eslint @(src|test)', [['unsupportedSyntax', '@(src|test)', 'darwin,linux,win32']]],
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
      [String.raw`grep "a\.b" file`, [['unsupportedCommand', 'grep', 'win32']]],
      [String.raw`echo "done\n"`, []],
      ['node x.js %PORT%', [['unsupportedSyntax', '%PORT%', 'darwin,linux']]],
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
      [
        'copy /y a b && move a b && ren a b',
        [
          ['unsupportedCommand', 'copy', 'darwin,linux'],
          ['unsupportedCommand', 'move', 'darwin,linux'],
          ['unsupportedCommand', 'ren', 'darwin,linux'],
        ],
      ],
      ['if not exist dist mkdir dist', [['unsupportedSyntax', 'if not exist', 'darwin,linux']]],
      [
        'echo %CD% %npm_package_version%',
        [
          ['unsupportedSyntax', '%CD%', 'darwin,linux'],
          ['unsupportedSyntax', '%npm_package_version%', 'darwin,linux'],
        ],
      ],
      ['printf "%s%n%" x', [['unsupportedCommand', 'printf', 'win32']]],
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
  });

  describe('nested commands', () => {
    it.each<[string, Summary[]]>([
      ['cross-env NODE_ENV=production rm -rf dist', [['unsupportedCommand', 'rm', 'win32']]],
      ['cross-env-shell "echo $FOO && rm x"', [['unsupportedCommand', 'rm', 'win32']]],
      // It joins its arguments into a single script
      ['cross-env-shell npm install x', []],
      ['cross-env-shell rm -rf $DIR', [['unsupportedCommand', 'rm -rf $DIR', 'win32']]],
      // It expands globs of script names itself
      ['concurrently "npm run watch:*(!css)" "npm:build"', []],
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
      ['if true; then node x; fi', [['unsupportedSyntax', 'if', 'darwin,linux,win32']]],
      ['echo `date`', [['unsupportedSyntax', '`date`', 'darwin,linux,win32']]],
      ['echo ${A#b}', [['unsupportedSyntax', '${A#b}', 'darwin,linux,win32']]],
      ['eslint {src,test}/**/*.js && cp a.{js,map} dist', [['unsupportedCommand', 'cp', 'win32']]],
      [
        String.raw`node scripts\build.js`,
        [['inconsistentBehavior', String.raw`scripts\build.js`, 'darwin,linux,win32']],
      ],
      // Commands like concurrently run their arguments with the system shell
      ['concurrently "NODE_ENV=dev vite"', [['unsupportedSyntax', 'NODE_ENV=dev', 'win32']]],
    ])('%s', (script, expected) => {
      expect(summarize(script, portable)).toStrictEqual(expected);
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
      ['Rm -rf x', []],
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
      // Escapes make positions unmappable, so the whole argument is reported
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
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('regressions from real-world scripts', () => {
    it.each<[string, Summary[]]>([
      // `-c` belongs to concurrently (colors), not npx
      ['pnpx concurrently -c "#ffcf00,#3178c6" "pnpm dev:build"', []],
      [
        'npx --yes concurrently -c red,blue "tsc -w" "rm -rf x"',
        [['unsupportedCommand', 'rm', 'win32']],
      ],
      ['npm exec --package=foo -c "rm y"', [['unsupportedCommand', 'rm', 'win32']]],
      ['npm exec -- concurrently -c "#fff" "vite"', []],
      // concurrently's script shortcuts aren't shell scripts
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
      [
        'for f in {a,b}; do node $f; done',
        [
          ['unsupportedSyntax', 'for', 'win32'],
          ['unsupportedSyntax', '{a,b}', 'linux'],
        ],
      ],
      // The npm `watch` package, not procps' `watch` // cspell:disable-line
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
          ['unsupportedSyntax', '$(pwd)', 'win32'],
        ],
      ],
      [
        '[[ ! -f a && ( -d b || -e $c ) ]]',
        [['unsupportedSyntax', '[[ ! -f a && ( -d b || -e $c ) ]]', 'linux,win32']],
      ],
      ['coproc { a; }', [['unsupportedSyntax', 'coproc', 'darwin,linux,win32']]],
      ['# Only a comment', []],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it.each<[string, Summary[]]>([
      ['if exist dist del dist', [['unsupportedSyntax', 'if exist', 'darwin,linux,win32']]],
      ['echo %CD%', [['unsupportedSyntax', '%CD%', 'darwin,linux,win32']]],
      ['echo ${A:+x} ${A-x}', [['unsupportedSyntax', '${A-x}', 'darwin,linux,win32']]],
      ['node x 2>/dev/null', []],
      ['node x --out=/dev/null', [['unsupportedSyntax', '--out=/dev/null', 'win32']]],
    ])('%j in the portable shell', (script, expected) => {
      expect(summarize(script, portable)).toStrictEqual(expected);
    });
  });

  describe('platform fallbacks', () => {
    it.each<[string, Summary[]]>([
      ['rm -rf dist || rmdir /s /q dist', []],
      ['export NODE_ENV=test || set NODE_ENV=test&& mocha', []],
      [String.raw`xcopy /e /i . ..\x || rsync -r ./ ../x`, []],
      ['powershell ./cert.cmd || sh ./cert.sh', []],
      [String.raw`.\prepare.bat || ./prepare`, []],
      // Each command is paired once: `true` is still reported, as it runs on Windows when `rmdir`
      // fails
      ['rm -rf dist || rmdir /s /q dist || true', [['unsupportedCommand', 'true', 'win32']]],
      // Not an alternative for another platform
      ['rm -rf dist || echo failed', [['unsupportedCommand', 'rm', 'win32']]],
      [
        'rm -rf dist || true',
        [
          ['unsupportedCommand', 'rm', 'win32'],
          ['unsupportedCommand', 'true', 'win32'],
        ],
      ],
      [
        'open x || xdg-open x',
        [
          ['unsupportedCommand', 'open', 'linux,win32'],
          ['unsupportedCommand', 'xdg-open', 'darwin,win32'],
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

  describe('more hand-checked regressions', () => {
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
      // npm and pnpm set `HOME`
      ['cross-env CONFIG=${HOME}/.config node x.js', []],
      // Variables of the user or the package manager
      ['cross-env NODE_ENV=$NODE_ENV jest', []],
      ['cross-env VERSION=$npm_package_version jest', []],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });

    it("reports `HOME` when Yarn v1 runs the script, which doesn't set it", () => {
      expect(summarize('cross-env CONFIG=${HOME}/.config node x.js', yarnClassic)).toStrictEqual([
        ['inconsistentBehavior', '${HOME}', 'win32'],
      ]);
    });

    it("doesn't report them in Yarn's shell, which expands variables itself", () => {
      expect(summarize('cross-env NODE_PATH=$PWD/src jest', portable)).toStrictEqual([]);
    });

    it.each<[string, string, AnalyzeScriptOptions?]>([
      ['node x.js --root $PWD', 'Use a relative path or a Node.js script instead.'],
      ['node x.js --tmp $TMPDIR', 'Use a Node.js script instead.'],
      ['node x.js --home ${HOME}', 'Use `cross-env` or a Node.js script instead.'],
      ['node x.js --home ${HOME}', 'Use a Node.js script instead.', yarnClassic],
      ['node x.js --env $NODE_ENV', 'Use `cross-env` or a Node.js script instead.'],
    ])("doesn't suggest `cross-env` for them in %j", (script, suggestion, options) => {
      expect(analyzeScript(script, options).map((issue) => issue.data.suggestion)).toStrictEqual([
        suggestion,
      ]);
    });
  });

  // Checked on GitHub's Windows runners with npm, pnpm and Yarn v1
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
      // Reported once, for the outer script
      ['concurrently "tsc\nvite"', [['unsupportedSyntax', '\n', 'win32']]],
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
    ])("%j in Yarn's shell", (script, expected) => {
      expect(summarize(script, portable)).toStrictEqual(expected);
    });

    it("doesn't report carriage returns in Yarn's shell", () => {
      expect(summarize('tsc\r\nvite build', portable)).toStrictEqual([
        ['unsupportedSyntax', '\n', 'darwin,linux,win32'],
      ]);
    });

    it.each<[string, FixSummary[]]>([
      ['tsc &&\n  vite build', [['\n', 'Join the lines.', 'tsc && vite build']]],
      ['node x.js \\\n--watch', [['\n', 'Join the lines.', 'node x.js --watch']]],
    ])('fixes %j', (script, expected) => {
      expect(summarizeFixes(script)).toStrictEqual(expected);
    });

    it.each([
      // Joining the lines would comment the rest out
      'tsc && # build\nvite build',
      'node x.js "a\nb"',
      // In a word, e.g. in single quotes, where POSIX shells keep the line break
      'node x.js\\\n--watch',
    ])("doesn't fix %j", (script) => {
      expect(summarizeFixes(script)).toStrictEqual([]);
    });
  });

  // Checked on GitHub's Windows runners with npm, pnpm and Yarn v1
  describe('command paths', () => {
    it.each<[string, Summary[]]>([
      // cross-env's cross-spawn normalizes the path and reads the file's shebang
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
      ['cross-env-shell "eslint \'src/**\'"', []],
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

      expect(issue?.data.reason).toBe(
        "cmd.exe doesn't treat single quotes as quotes, so it splits the string before `cross-env` removes them",
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
        ['find . -wholename "*x*"', [['unsupportedCommand', 'find', 'win32']]], // cspell:disable-line
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
            ['inconsistentBehavior', 'trap "RC=1" ERR', 'linux'],
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
        // Escaped double quotes and backslashes mean the same to Node.js on Windows
        [String.raw`node x.js \"a\" "b\"c" a\\b`, []],
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
        ['setlocal && node x', [['unsupportedCommand', 'setlocal', 'darwin,linux']]],
      ])('%j', (script, expected) => {
        expect(summarize(script)).toStrictEqual(expected);
      });

      it.each<[string, Summary[]]>([
        [String.raw`echo \$HOME`, []],
        ['node x --seed=$RANDOM', []],
        ['npm i mobx@^5', []],
        [
          'set NODE_ENV=production&& node x',
          [['inconsistentBehavior', 'set NODE_ENV=production', 'darwin,linux,win32']],
        ],
        ['[ a == b ] && node x', [['unsupportedCommand', '[', 'win32']]],
        ['rem node build.js', [['unsupportedCommand', 'rem', 'darwin,linux,win32']]],
        [
          String.raw`node "scripts\build.js"`,
          [['inconsistentBehavior', String.raw`"scripts\build.js"`, 'darwin,linux']],
        ],
        [
          String.raw`node scripts\build.js`,
          [['inconsistentBehavior', String.raw`scripts\build.js`, 'darwin,linux,win32']],
        ],
      ])('%j in the portable shell', (script, expected) => {
        expect(summarize(script, portable)).toStrictEqual(expected);
      });
    });
  });

  describe('code review regressions', () => {
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
      ['wget https://example.com', [['unsupportedCommand', 'wget', 'darwin,win32']]],
      // Node.js resolves `/tmp` on Windows too
      ['node x /tmp/out', []],
    ])('%j', (script, expected) => {
      expect(summarize(script)).toStrictEqual(expected);
    });
  });

  describe('ignoreCommands', () => {
    it.each<[string, string[], Summary[]]>([
      ['cross-env A=1 rm x', ['rm'], []],
      ['xargs rm < files', ['xargs'], [['unsupportedCommand', 'rm', 'win32']]],
      ['sh -c "rm x"', ['sh'], [['unsupportedCommand', 'rm', 'win32']]],
      ['./scripts/build.sh', ['./scripts/build.sh'], []],
      ['sed -i x f', ['sed'], []],
    ])('%j with %j', (script, ignoreCommands, expected) => {
      expect(summarize(script, {ignoreCommands})).toStrictEqual(expected);
    });
  });

  describe('dependencies', () => {
    it("doesn't assume that commands named like a dependency are its binaries", () => {
      // e.g. the `touch` package's binary is `nodetouch` // cspell:disable-line
      expect(summarize('touch x', {dependencies: ['touch']})).toStrictEqual([
        ['unsupportedCommand', 'touch', 'win32'],
      ]);
    });

    it("reports del-cli's `del`, which cmd.exe's builtin shadows", () => {
      expect(summarize('del dist', {dependencies: ['del-cli']})).toStrictEqual([
        ['inconsistentBehavior', 'del', 'win32'],
      ]);
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
      ['env CI=1 jest', [['env', 'Replace `env` with `cross-env`.', 'cross-env CI=1 jest']]],
      [
        'export CI=1 A="b c" && jest',
        [['export', 'Replace `export ... &&` with `cross-env`.', 'cross-env CI=1 A="b c" jest']],
      ],
      ['tsc || true', [['true', 'Replace `true` with `exit 0`.', 'tsc || exit 0']]],
      ['tsc || :', [[':', 'Replace `:` with `exit 0`.', 'tsc || exit 0']]],
      ['vitest && false', [['false', 'Replace `false` with `exit 1`.', 'vitest && exit 1']]],
      [
        'concurrently "tsc || true"',
        [['true', 'Replace `true` with `exit 0`.', 'concurrently "tsc || exit 0"']],
      ],
      [
        'source .env && tsc',
        [['source', 'Replace `source .env` with `. ./.env`.', '. ./.env && tsc']],
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

      // Assignments
      [
        'CI=1 FORCE_COLOR=0 jest',
        [
          ['CI=1', CROSS_ENV, 'cross-env CI=1 FORCE_COLOR=0 jest'],
          ['FORCE_COLOR=0', CROSS_ENV, 'cross-env CI=1 FORCE_COLOR=0 jest'],
        ],
      ],

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
      [
        '{ tsc; vite build; } > log',
        [['{', 'Replace `{ ... }` with `( ... )`.', '( tsc; vite build; ) > log']],
      ],
      ['tsc # build', [['# build', 'Remove the comment.', 'tsc']]],
      ['# Build\ntsc', [['# Build', 'Remove the comment.', 'tsc']]],
      ['tsc\n# Done', [['# Done', 'Remove the comment.', 'tsc']]],
      [
        'tsc\r\n# Done',
        [
          ['\r', 'Remove the carriage return.', 'tsc\n# Done'],
          ['# Done', 'Remove the comment.', 'tsc'],
        ],
      ],
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

      // Usage
      ['. env.sh', [['. env.sh', 'Replace `env.sh` with `./env.sh`.', '. ./env.sh']]],
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
    });

    it.each([
      // Options and arguments that the replacement doesn't support the same way
      'rm -rfv dist',
      'rm -rf',
      'rm -rf "$DIR"/*',
      'env -i jest',
      'env',
      // The variables would also apply to `vite build`
      'export CI=1 && jest && vite build',
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
      // OS utilities don't expand globs themselves
      'cat src/**/*.js',
      // `&&` would run `echo` when `tsc` fails
      'tsc; vite build || echo failed',
      'tsc; vite build &',
      './bin/cli',
      // cmd.exe's own commands treat `/` as an option prefix
      String.raw`cd .\src\lib`,
      String.raw`IF EXIST .\dist RMDIR /Q /S .\dist`,
      // A subshell keeps `cd` from changing the directory of the commands that follow
      '{ cd lib && tsc; } && jest',
      // Removing an input redirection makes the command read the terminal
      'tsc < /dev/null',
      // Removing a redirection that is a whole command leaves an incomplete pipeline
      'tsc | 2>/dev/null',
      // A subshell keeps `exit` and variables from affecting the commands that follow
      'test -f x || { echo missing; exit 1; }',
      '{ A=1; } && echo $A',
      'mkdir -p dist/{a,$B}',
      'grep -v ^$ log',
      // Positions in escaped nested scripts can't be mapped
      String.raw`sh -c "echo \"\$(a |& b)\""`,
    ])('%j', (script) => {
      expect(summarizeFixes(script)).toStrictEqual([]);
    });
  });

  it('truncates long snippets', () => {
    const [issue] = analyzeScript(`echo $(node -e "${'x'.repeat(50)}")`);

    expect(issue?.data.syntax).toBe(`The command substitution \`$(node -e "${'x'.repeat(26)}...\``);
  });
});
