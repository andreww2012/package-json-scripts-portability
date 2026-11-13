# package-json-scripts-portability

## 0.0.2

### Patch Changes

- [`8ae723a`](https://github.com/andreww2012/package-json-scripts-portability/commit/8ae723a8dc7ee4fedaaeec5b5a3966933d9b1bc8) - Widened supported Node.js versions to `>=22`

- [`1513bbb`](https://github.com/andreww2012/package-json-scripts-portability/commit/1513bbb0cd61d454268cf20d1b7e3c4e5bf1dd00) - Improved performance for scripts checked with several runners: each one is now parsed only once

- [`8d2d988`](https://github.com/andreww2012/package-json-scripts-portability/commit/8d2d98824d75ed971fb8aa79c8db717ad4e8470f) - Fixed commands that `command` runs not being checked when they have a `-v` option, e.g. `grep -P` in `command grep -v -P`

- [`7b8ccfc`](https://github.com/andreww2012/package-json-scripts-portability/commit/7b8ccfc8ed52c409fa9daa8f9342149c270c5879) - Fixed backslash escapes not being reported after one that `cross-env` removes, e.g. `\ ` in `cross-env A=\$A\ b`

## 0.0.1

### Patch Changes

- [`e0e4afc`](https://github.com/andreww2012/package-json-scripts-portability/commit/e0e4afc288d75032f61bc6aa3e2699b87a37cd3f) - Initial release
