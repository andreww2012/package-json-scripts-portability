---
"package-json-scripts-portability": patch
---

Fixed backslash escapes not being reported after one that `cross-env` removes, e.g. `\ ` in `cross-env A=\$A\ b`
