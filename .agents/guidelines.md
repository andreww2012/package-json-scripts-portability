# Guidelines

Source: <https://github.com/andreww2012/ai-guidelines/blob/@andreww2012/ai-guidelines@0.2.11/.agents/guidelines.md>

These are generic guidelines that might be copied or linked from a different repository.
If anything stated here conflicts with the current project's rules or the prompt, those win.

Headings only group rules and don't limit where they apply, unless the text says so.
For example, "Communication and writing" rules apply to your output, docs and code alike.

## Meta

Don't report how extensively you've verified/tested your work - if you feel the need to say it, say it *very* briefly.

Don't mention that you followed these guidelines or any other instruction unless it's very important: that is implied.

If someone points out that you violated the guidelines, explain why you deviated and suggest how to improve them, so that it's less likely to happen again.

## Communication and writing

**CRITICAL:** Use plain/simple English for your output, while still respecting the language and prose style used in the current project for generated code.
Most likely you'll be read by people who are not native or C2-level speakers, so adapt accordingly.
Avoid:

- long dashes (like —, U+2014), the ellipsis character (…, U+2026), or quotation marks other than the plain `"` and `'` (like “ and ’, U+201C and U+2019, and others);
- terms and phrases like "load-bearing", "byte-identical", "it's not x; it's y", "earn its place" and similar;
- complex metaphors and jargon;
- mannered prose;
- advanced, fancy or rarely used words.

If something can be said shorter and simpler without losing meaning, do it: people shouldn't waste energy just to understand you.
In general, avoid verbosity and redundancy.
Sound human.
None of the above is a hard ban: use anything if it actually fits.
This applies to all languages, not only English.

Avoid British variants of words like *behaviour* or *organisation* unless the project allows them.

In Russian, prefer `ё` over `е`.

In comments and docs, don't name symbols (variables), commands, files, etc. unless the reader needs the name: if the entity is renamed, the reference becomes stale.

Code, comments, docs and other work artifacts must make sense without the session context: don't write anything that can't be understood without it, like `// as requested`, `// now uses X instead of Y` or mentions of earlier attempts.

Wrap all technical names, code snippets and the like in backticks.

Never put a full stop at the very end of a comment, a commit body or a changeset.

## Code

Always challenge your implementation for performance, ergonomics and code length issues and find ways to improve it.
Adhere to **DRY**, **KISS**, **YAGNI**, **Rule of three**, **high cohesion and low coupling** and other principles/rules of writing clean and maintainable code.
Don't over-engineer or over-optimize things though - in most situations, that is not required.

If a file you change gets big (usually more than 1000 lines), look closely for ways to refactor or reorganize it, like splitting it into smaller files.
Suggest these changes to the user instead of making them on your own.

Make sure the code works on all common platforms (usually Windows, Linux and macOS), unless that's not needed.

If you need a utility or a utility type, first look for it in the project's own code and its direct dependencies (common candidates: `utilery`, `es-toolkit`, `type-fest`).

- Use `const` instead of `let` whenever possible.
- Use arrow functions whenever possible.
- Use full words instead of shorthands:
  - ❌ `str`, `arr`, `cls`, `brk`, `err`, `val`, `pkg`, `dir`, etc.

  Exceptions:
  - ✅ `acc`, `char`, `coeff`, `ctx`, `dev`, `dict`, `env`, `fn`, `impl`, `param`, `w/(o)`
  - ✅ `docs` (when it's shorthand for "documentation", not "documents")
  - ✅ index variables like `i`/`j`/etc.

  The full word must mean the same thing: for example, `arguments` can't be a variable name in strict mode code, but `parameters` is not a valid substitute for `args`, because it means something else.
  Add, say, a trailing underscore (`arguments_`) instead.
- Never omit curly braces around blocks (like `if`, `else`, etc.).
- Let the type system infer types whenever possible: prefer implicit/inferred return types.
  Especially avoid having both an explicit return type and an unsafe cast of the return value in the same function.

  But:
  - An explicit return type is fine when it saves casting other returned values.
  - A type annotation is fine when it gives useful IDE autocomplete.
    The most common case: a variable that is later assigned to a property with a complex type (like an object) should get a type annotation, even though the assignment is type-checked without it.
- Don't `export` symbols that are neither used in other files nor part of the public API.
- Hoist symbols and literals (like regexes, functions, constants, arrays, `Set`, etc.) as high as possible.
- Prefer non-strict equality for `null` and `undefined` comparisons (`== null`, `!= null`) unless it would actually change the existing logic.
- Prefer "direct" conditions over negated ones:
  - ✅ `a ? b : c`, `if (a) { ... } else { ... }`
  - ❌ `!a ? c : b`, `if (!a) { ... } else { ... }`
- If the `||` and `??` operators work the same, prefer using `||`.
- Use `CONSTANT_CASE` only for constants holding a primitive, a read-only array/object, a `Set`/`Map` typed as `ReadonlySet`/`ReadonlyMap` or a `RegExp`, no matter how their values are computed:
  - ✅ `const FOO = 'bar'`
  - ✅ `const FOO = ['bar', 1 + 2, Math.random()] as const`
  - ❌ `const FOO = [1, 2, 3]`
  - ❌ `const COLLATOR = new Intl.Collator('ru')`

  Prefer making values read-only with types (`: Readonly<T>` if possible, otherwise `as const`, or JSDoc in type-checked JS files), not with runtime calls like `Object.freeze`, unless there is no other simple way.
  In JS files that are not type-checked, the read-only requirement doesn't apply.
- Prefer `Array#reduce` over creating an object and modifying its properties in a loop.
- When a symbol is only used once, prefer to inline it unless it is non-trivial or its name conveys meaning the value alone doesn't (e.g. don't inline `const DEFAULT_SORTING = 'rank'` even if `DEFAULT_SORTING` is only used once).
  This also applies to things like Vue's `computed`s.
  If inlining would re-create the value on every call, hoisting wins.
- Prefer `Array#forEach` over `for` loops, unless a loop is better by a meaningful metric (performance, ergonomics, etc.).
- Prefer `...(condition && {property: ...})` over `...(condition ? {property: ...} : {})` or `property: condition ? ... : undefined` (use the last form only when the key must exist even if its value is `undefined`).
- If `!== ''`/`=== ''` work the same as `.length > 0`/`.length === 0`, prefer the latter.
- Put units in names: `MAX_SIZE_BYTES` or `DURATION_MS`, not `MAX_SIZE` or `DURATION`.
- Prefer reading `.json` files with a static `import` rather than with file system utilities, unless the path is only known at runtime.
- If `.toSorted()` and `.sort()` work the same, prefer `.sort()`, even if an ESLint rule like `unicorn/no-array-sort` requires the former: it's overly strict.
  The same goes for the other copying methods, like `.toReversed()`.
  Don't disable such lint rules globally though: they are still useful.

### Performance

- Run independent consecutive `await`s concurrently (`Promise.all` or similar), unless the order or a concurrency limit matters.
- If you need a map that is initially empty and will be mutated, use `Map` instead of a plain object whenever possible: adding or removing object properties is often slower than with `Map`.

### TypeScript

- Do your best to avoid `any` and type casting (`as ...`) in favor of `unknown` or other clever workarounds.
  Safe type casting exceptions: `as unknown`, `as const`, `satisfies T as T`.
- Prefer `Record<string, unknown>` over the `object` type as the former is usually simpler to reason about.
- Don't use `satisfies T` if the regular type annotation (`: T`) would work the same.
- Use `as const` sparingly, only when really necessary.
- Use descriptive names for type parameters: `Value`, `Key`, `Item`, `Element`, `Length`, etc. - NOT `T`, `U`, `V`, `K` and the like.
- Beware that a type guard (`value is T`) also narrows the `false` branch.
  If a value that already has the type `T` fails the check, it becomes `never` there - this is likely not intended.

### Style

- Sort symbols in `export {...}` statements alphabetically, unless it makes sense to do something else (likely group exports, but they must be sorted within each group too).
  Always sort symbols in `import {...}` statements and sort import statements themselves in the [`sort-imports`](https://eslint.org/docs/latest/rules/sort-imports) and [`import/order`](https://raw.githubusercontent.com/un-ts/eslint-plugin-import-x/refs/tags/v4.18.0/docs/rules/order.md) order respectively.
  Unless the used linter's config says otherwise, assume these `import/order` options: `{groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'], alphabetize: {order: 'asc'}}`.
  If the project doesn't enforce this order with a tool like ESLint, suggest doing so at the end of your work.
- In general, in *large* lists prefer keeping things alphabetical, if it makes sense and you're not told otherwise.
- Keep each sentence in Markdown or JSDoc on a separate line, exactly like in this document.
  Exception: text that ends up where each line break is shown as a real one, as GitHub and some other platforms (not GitLab!) do in issues, PRs, discussions, comments and release notes.
  This includes drafts of such content and files copied there, most commonly `.changeset/*.md` files and issue/PR templates.
- Use `kebab-case` for file and directory names, unless they should be called differently by convention (like `README.md`, `AGENTS.md`, etc.).

### Comments

- Only write comments that add real value, such as explaining *truly* non-obvious choices or behavior that are very hard to understand from code alone.
  Never repeat what the code already says: if someone reading the code for the first time wouldn't learn anything new from the comment, drop it.
- Keep comments short and clear, but don't lose their value.
- Wrap comments to fit the max line length (usually set in `.editorconfig` or the formatter config).
  In block comments (like `<!-- ... -->` or `/* ... */`, but not JSDoc), keep the opening marker on the first line of the text and the closing marker on the last one.

### Documentation

If you need to link to an npm package, prefer `https://npmx.dev/<package-name>` links over `npmjs.com` ones or direct repo links.

### Frontend

Web UIs must adhere to the [Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22) standard, level AA.

On catalog and search pages, sync filter values and the search query with URL query parameters.
Prefer `q` as the name of the search query parameter.
Prefer `snake_case` for query parameter names.
If a modal, sidebar, etc. is worth sharing by link, give it its own URL.

For containers with dynamic text, use `overflow-wrap: anywhere` unless you genuinely need something else, and test them with very long words and links.

Keep Tailwind classes in markup, not in script strings: tools usually can't lint, sort or check them there.

#### Vue

- Move static variables into a separate non-setup `<script>` block in Vue SFCs for performance (if there are only type declarations to move, this won't change anything).
- Do use inline composables: <https://alexop.dev/posts/inline-vue-composables-refactoring>
- Prefer `shallowRef` over `ref`, but only when that actually makes a difference (for example, `shallowRef(false)` does not).
- Avoid `reactive`; only use it when strictly necessary.
- Don't add `| null` as a possible type for refs for no reason - usually implicit `undefined` works just fine.
- Prefer `useTemplateRef` if it's available, and prefer not to add an explicit type parameter to it.
- Don't end an element's text with whitespace, including a line break before the closing tag: Vue keeps it as a space, which some browsers show when the text is selected.
  The same goes for whitespace before an element that may not render or be visible (`v-if`, `v-show`, etc.): move the space inside it, like `{{ label }}<span v-if="..."> (optional)</span>`.
  If the element has nothing but text, also start the text right after the opening tag.
- In runtime props declarations (not type-based), always set `required: true|false` explicitly.
- Don't put HTML comments at the root of `<template>`: Vue keeps them only in dev mode, where they make the component a fragment.

## Workflow

### General

Before implementing anything, check the repo's `.{agents,claude}` directories for relevant instructions/skills.

If someone points out a mistake you made, *proactively* check your changes and the related code for similar or related mistakes.

For every bug you fix, write regression tests if the project has tests.

If you create a package patch, always add comments explaining all the changes.
Some package managers, for example pnpm, allow free text before the diff in a patch file.
This is a good place for these comments.

If you find likely bugs in dependencies, mention them at the end of your work.
If the user asks you to draft an issue, draft it in the same session (NEVER send it to the Internet):

- in raw Markdown, with the issue title and body in separate code blocks;
- with *minimal* text and a *minimal* reproduction;
- with the "Writing on the hosting platform" rules applied;
- with a direct link where the issue can be reported.

Before running any non-trivial command, check the machine's free resources, primarily RAM and CPU.
Based on that, decide how to run such commands: in parallel, one by one, etc.

Run all commands through the project's package manager, including one-off binaries: e.g. in a pnpm project, use `pnpm why` and `pnpm (exec|dlx)` instead of `npm why` and `npx`, unless the equivalent is missing.
If [`@antfu/ni` commands](https://raw.githubusercontent.com/antfu-collective/ni/refs/heads/main/README.md) are available, prefer them over package manager native ones (e.g. `ni` instead of `(p)npm i(nstall)`, `nr` instead of `(p)npm run` and so on).

Avoid editing generated files, including package managers' lockfiles, unless there's a good reason to do otherwise.

Prefer not to use your memory: save anything that may help other people working on this repo to `AGENTS.md` instead.
Keep what you add there as generic and short as reasonably possible: for example, don't name specific commands, files, etc. unless strictly necessary.

### Version control

NEVER stage/unstage or commit changes unless explicitly asked to, not even as a side effect: e.g. use `mv`/`rm`, not `git mv`/`git rm`.
So never ask whether to commit when, judging by these rules, the answer would likely be "no".
Assume your change may be staged or committed by a user (most likely) or another agent at any point.

At the end of your work, *suggest* commit message(s) that follow the project's commit style.
Put each one in its own full-width code block.
If a message has a body, give two code blocks for it: one with only the header and one with the full message (header and body).
Check them with the project's commit linter (e.g. `commitlint`), if there is one.

Always use the imperative mood in commit headers.
Unless you're allowed/asked to, never add yourself as a co-author.

Use `git stash` only if there's no other way: prefer git worktrees or throwaway repos.

### Writing on the hosting platform

These rules apply when you are asked to write content on the platform that hosts the repository (issues/discussions/comments/etc. on GitHub/GitLab/etc.).

The main rule: use a more casual, less formal writing style.

#### AI disclosure

- Before you write, read the project's contribution rules (`CONTRIBUTING.md`, README, issue templates, AI policy, etc.).
- If the project does not accept AI-generated contributions, do not write the content.
  Tell the user why.
- If the project has its own rules for marking AI content, follow them.
  Otherwise, start the content with this preamble:
  ```md
  > [!NOTE]
  > This <issue|discussion|comment|...> was written by AI (<model name>, <harness>), <any additional relevant info>.
  ```

#### Audience

Write for the people who will read the content.
Find out:

- The technical level of the maintainers and other readers.
- Their attitude to AI-generated content.
- Their expectations for issues: format, level of detail, what they think is noise.

Use the contribution rules, issue templates, recent issues, and maintainer replies as sources.
If you cannot find this information, assume maintainers are busy people who do not trust AI content: be short and specific, and include only facts you verified.

#### Environment details

If you have to describe the environment (issue templates often ask for it), leave out sensitive details like the OS name/version, unless they actually matter.

### Updating dependencies

If you're asked to update dependencies, update them one by one, but group closely related ones (like `vitest` and `@vitest/*`).
With each update, remove dependency rules that the new version no longer needs, like minimum release age exceptions, overrides, patches, etc.
If there are several updates, you may commit each one, *but only them* - this is a deliberate exception to the rule against committing without being asked.

Start the commit header of each update, including the ones you only suggest, with ``chore(deps): update `package-name` to v<version>`` (unless a different commit style is used).
You may use another conventional commit type, like `fix`, `feat`, etc., if it makes more sense, and say what has changed in the commit header.

## Testing tools, linters and other QA tools

When the task is done, run *all* the available tools on *all changed* files - take the list of changed files from version control, e.g. `git status`.
Ignore pre-existing unrelated issues.
Prefer the tool's `package.json` script if you can limit it to the changed files (usually by passing their paths).
Otherwise, call the tool directly on the changed files, with the same options the script uses.

The commonly used tools are as follows (may and will vary depending on the project): `tsc`, `vue-tsc`, `eslint`, `oxlint`, `prettier`, `oxfmt`, `vitest`, `knip`, `cspell` (use `--no-progress --no-summary`), a dependency vulnerability checker (if the lockfile was modified), for example `pnpm audit --audit-level high` (usually only high+ vulnerabilities are important to fix).
Some tools may only run in CI (for example, the `lychee` link checker), so check its config too.
Run them locally anyway, unless it's impossible (not installed, wrong platform) or takes too much time, memory or CPU.
If you skip a tool, say so.

Note: TypeScript checkers don't report type errors in files with a `@ts-nocheck` comment, so check such files in other ways.

Don't treat a linter rule as a source of truth: quite often it is wrong (rules have false positives or may be misconfigured).
So before fixing a linter report, always weigh all options INCLUDING disabling the rule for this line (or, much more rarely, for the entire file): that may be more correct than changing the code.

It's strictly forbidden to end up with ``toMatchInlineSnapshot(`undefined`)`` when using testing frameworks.

### Tool-specific comments

These are comments like `eslint-disable-next-line <rule> -- <reason>`, `cspell:ignore <words>`, `@ts-expect-error` and others.

- Always include that `<reason>` in ESLint, TypeScript and other tool comments wherever that makes sense.
  Start it with an uppercase letter.
- `--` between the directive and the reason is an ESLint requirement, not a general one: other tools have their own syntax.
  If the tool doesn't require a delimiter, don't invent one: separate them with a plain space.
- They don't have to satisfy the max line length requirement if that is impossible.
- Put them in comments of their own.
  Never add them to an existing comment, and never put them into content like strings or commands, unless there is clearly no other way of using them.
- Make these comments cover exactly the code that causes the report, so that they don't hide other problems.
  For example, an `eslint-disable(-next)-line` comment covers the whole (next) line, which might have other code without issues.
  In that case, break (re-format) the code so that the reported part is the only code on its line, unless the syntax or the formatter doesn't allow it.
  To do that, put an argument, an array item, an object property's value, a chained call or the value after `=` on a new line.
  If the reported part is nested, for example in a call that is itself an argument, break each enclosing call too.
  Try not to move code into a new variable just for that.
  Linters don't check this, so before you finish, look at what else is on the lines that these comments cover.

#### CSpell

If a word to ignore is only found in a single file, use the inline comment `cspell:disable(-next)-line`.
Use a top-level `cspell:ignore <words>` comment instead if the word occurs more than once in the file or the inline comment can't be used.

## Other

To write a CLI, prefer `cleye`, unless a new dependency is unwanted or another tool was suggested.
Always set `strictFlags: true` when using it.

### Changesets

- If you're asked to create a changeset, always use its underlying name generator, `human-id`, for file names.
- Don't use the imperative mood in changesets, i.e. the "Add `foo`" form should never be used.
  Prefer writing them in the past tense.
- Keep changesets short: go straight to the main point and skip details most readers don't need.
  Assume no one has time to read changelogs closely and figure out what each change is about.