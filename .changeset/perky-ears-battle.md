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
- Stopped reporting what `cross-env` handles behind another command, like `$A` in `npx cross-env A=1 x $A`, and arguments of a script file, like `-c` in `bash build.sh -c x`
- Started reporting operators in single-quoted `echo` strings, like `echo 'a > b'`, double-quoted `echo` output that goes into a pipe, and the commands that GNU `timeout` runs
- Stopped fixes from putting `cross-env` before shell builtins, like `cd` and `exec`, and from joining `;# comment` to the word before it
- Stopped reporting comment-only scripts with several lines, and an escaped backslash in `sed` patterns, like `\\b`
