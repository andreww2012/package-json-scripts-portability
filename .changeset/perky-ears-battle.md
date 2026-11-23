---
"package-json-scripts-portability": patch
---

Fixed several wrong fixes and reports:

- Stopped fixes from breaking here-documents and `export A=1 && cmd $A`
- Started reporting uppercase cmd.exe `IF EXIST`, line breaks after `&` (and after `;` in Yarn's shell), every comment between commands, and quoted `echo` output that a group sends to a file
- Stopped reporting `echo 'a' >&2`, version ranges like `~1.2.3`, and comment-only scripts with a trailing line break
- Stopped treating `sed -e` as `sed -E`
- Stopped platform fallbacks like `a || b` from hiding issues in the arguments of their commands
- Made `getRunner` check whole version ranges: `^9 || ^11` gives `pnpm`, and Yarn ranges that allow both v1 and v2+, like `>=1`, give `undefined`
- Fixed a stack overflow on deeply nested scripts
- Stopped reporting what `cross-env` handles behind another command, like `$B` in `npx cross-env A=1 x $B`, and arguments of a script file, like `-c` in `bash build.sh -c x`
- Started reporting operators in single-quoted `echo` strings, like `echo 'a > b'`, double-quoted `echo` output that goes into a pipe, and the commands that GNU `timeout` runs
- Stopped fixes from putting `cross-env` before shell builtins, like `cd` and `exec`, and from joining `;# comment` to the word before it
- Stopped reporting comment-only scripts with several lines, and an escaped backslash in `sed` patterns, like `\\b`
- Stopped fixes and messages in nested scripts from showing underscores instead of the outer shell's expansions, like `$OUT` in `sh -c "tsc &> $OUT"`, and from treating such words as plain text
- Stopped reporting braces and `**/` globs where shells don't expand them, like `A={a,b} node x.js`, and replaced the wrong fix for braces in a redirection, like `> out.{log,txt}`, with a report for macOS, where Bash fails
- Stopped fixes from leaving a carriage return after a removed comment in CRLF scripts, and a `\` line continuation before a removed comment or `> /dev/null`
- Started reporting commands that other commands start in Yarn's shell, like `sleep` in `cross-env A=1 sleep 5`
- Started reporting a line break before the first command, and line breaks, comments and a trailing `;` in `( ... )` and `{ ... }`
- Started reporting `timeout /nobreak`, `exit /b`, Bash-only assignments like `export A=(1 2)`, Bash-only `case` patterns, and the scripts of `pnpm -c exec` and `pnpm -rc exec`
- Started reporting commands in the wrong case on Linux, like `MKDIR`, `ECHO` and `DIR`, with a fix that puts them in lower case where that's safe
- Stopped reporting the same issue twice in nested scripts, like the path in `concurrently "mocha --spec=test\unit\a.js"` and `~/x` in `cross-env-shell ls ~/x`
- Stopped reporting the text of a here-string as a path, like `/dev/null` in `node x <<< /dev/null`
- Stopped reporting `function_a() { ... }` as the `function` keyword, `cd` in `(cd a && x) > log`, and `base64 -w` on macOS
- Stopped throwing on unknown runners, which are now ignored
- Started reporting shell builtins in the wrong case on macOS too, like `EXIT 0` and `CD src`
- Started reporting variables that `cross-env` sets and its command uses, like `$A` in `cross-env A=1 node x $A`, which POSIX shells expand before `cross-env` runs
- Started checking the commands after npm's `-w` and `--workspace <name>`, like `rm` in `npm exec -w pkg -- rm -rf x`, and after `cross-env A=$B`
- Stopped reporting del-cli's `del` in Yarn's shell, which can't run cmd.exe's builtins
- Stopped fixes from putting `cross-env` before assignments that use each other, like `PORT=3000 URL=http://localhost:$PORT node x`, and from removing `> /dev/null` before a pipe, like in `a > /dev/null | b`
