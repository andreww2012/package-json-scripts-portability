---
"package-json-scripts-portability": patch
---

Fixed commands that `command` runs not being checked when they have a `-v` option, e.g. `grep -P` in `command grep -v -P`
