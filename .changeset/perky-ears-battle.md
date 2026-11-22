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
