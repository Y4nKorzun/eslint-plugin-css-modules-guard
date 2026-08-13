# eslint-plugin-css-modules-guard

[![npm version](https://img.shields.io/npm/v/eslint-plugin-css-modules-guard.svg)](https://www.npmjs.com/package/eslint-plugin-css-modules-guard)
[![npm downloads](https://img.shields.io/npm/dm/eslint-plugin-css-modules-guard.svg)](https://www.npmjs.com/package/eslint-plugin-css-modules-guard)
[![CI](https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Catch CSS Modules mistakes before they reach the browser. This ESLint 9 and 10 flat-config plugin reads your local `.module.css`, `.module.scss`, `.module.sass`, and `.module.less` files at lint time, so it can check the class names your code actually uses.

It compiles Sass and Less before checking selectors, understands local `composes`, and reports stylesheets that cannot be resolved or compiled. Use it in the editor and in CI; it does not need generated `.d.ts` files.

## Install

Requires Node.js 20.19+ and ESLint 9 or 10.

```sh
npm install --save-dev eslint eslint-plugin-css-modules-guard
```

That is everything `.module.css` needs. Compilers are **optional peer dependencies**, so a project
only pays for the ones it actually uses:

| Install | Enables | Range |
| --- | --- | --- |
| `npm install --save-dev sass` | `.module.scss` and `.module.sass` | `^1.45.0` |
| `npm install --save-dev less` | `.module.less` | `^4.0.0` |
| `npm install --save-dev typescript` | Aliases read from `compilerOptions.paths` in `tsconfig.json` | `>=4.8.4 <6.1.0` |

Sass is `1.45.0` and up because that is where Dart Sass introduced the modern JavaScript API this
plugin compiles through.

Most projects already have `typescript` in the tree: `@typescript-eslint/utils` requires it.

Nothing fails quietly when a compiler is absent. The import is reported by
`unresolvable-stylesheet` with the exact package to install, and `no-unknown-class` stays silent on
that module rather than inventing unknown classes:

```text
Unable to compile CSS Module "./Card.module.scss". Install the optional peer dependency "sass" to lint .module.scss and .module.sass files
```

A real compile error still gets the plain `Unable to compile` message, so a broken stylesheet is
never mistaken for a missing package.

## Quick start

Add the recommended rules to your flat config:

```js
// eslint.config.mjs
import cssModules from 'eslint-plugin-css-modules-guard';

export default [cssModules.configs.recommended];
```

Now a typo is caught where it happens:

```scss
/* Button.module.scss */
.root {}
.primary {}
```

```js
// Button.js
import styles from './Button.module.scss';

styles.primray;
```

```text
Unknown CSS Module class "primray" in "./Button.module.scss". Did you mean styles.primary?
```

ESLint exposes that correction as a suggestion; the plugin never changes source code automatically.

## What the recommended config checks

| Rule | Included | What it catches |
| --- | --- | --- |
| [`css-modules/no-unknown-class`](docs/rules/no-unknown-class.md) | Yes | Static dot, bracket, template-literal, and destructured names that do not exist in the module |
| [`css-modules/unresolvable-stylesheet`](docs/rules/unresolvable-stylesheet.md) | Yes | A CSS Module import that is missing, outside the project, unsafe, cannot compile, or needs a compiler that is not installed |
| [`css-modules/no-unused-class`](docs/rules/no-unused-class.md) | No | Local classes unused by one source file; enable only when that ownership rule is true |

`no-unknown-class` also accepts ICSS `:export` values, classes composed from local modules, and classes declared inside `:global()`. Dynamic access such as `styles[variant]` is deliberately skipped rather than guessed.

## Configure the rules

The recommended config is enough for relative imports. Add the same options to every enabled CSS Modules rule when your project uses aliases, Sass load paths, or a different class-name convention.

```js
// eslint.config.mjs
import cssModules from 'eslint-plugin-css-modules-guard';

const cssModulesOptions = {
  localsConvention: 'camelCase',
  aliases: {
    '@styles/*': 'src/styles/*',
  },
  loadPaths: ['src/styles'],
  suggestThreshold: 2,
  cache: true,
  cacheLimit: 512,
};

export default [
  cssModules.configs.recommended,
  {
    rules: {
      'css-modules/no-unknown-class': ['error', cssModulesOptions],
      'css-modules/unresolvable-stylesheet': ['error', cssModulesOptions],
      'css-modules/no-unused-class': ['warn', cssModulesOptions],
    },
  },
];
```

| Option | Default | Meaning |
| --- | --- | --- |
| `localsConvention` | `'asIs'` | CSS-loader-style property names: `asIs`, `camelCase`, `camelCaseOnly`, or `dashes` |
| `aliases` | `{}` | Local, project-root-relative mappings for CSS Module and Sass imports |
| `loadPaths` | `[]` | Local compiler load paths, relative to the project root unless absolute |
| `sassLoadPaths` | `[]` | Deprecated alias for `loadPaths`; both are honored and merged |
| `suggestThreshold` | `2` | Maximum edit distance for unknown-class suggestions (`0` disables suggestions) |
| `cache` | `true` | Enables the in-memory stylesheet extraction cache |
| `cacheLimit` | `256` | Maximum number of recently used stylesheets held in that cache |

The cache is content-hash validated and never creates cache files. Keep `cacheLimit` consistent across enabled CSS Modules rules: they share the in-memory cache.

### Class-name conventions

Use `localsConvention` to match your CSS loader. For a class named `.card-title`:

| Convention | Accepted property names |
| --- | --- |
| `asIs` | `styles['card-title']` |
| `camelCase` or `dashes` | `styles['card-title']` and `styles.cardTitle` |
| `camelCaseOnly` | `styles.cardTitle` |

## Aliases, Sass, and Less

The plugin automatically reads `compilerOptions.paths` from the nearest local `tsconfig.json`, including safe local `extends` files and project references. This uses the optional `typescript` peer dependency; without it, tsconfig aliases simply do not contribute and `aliases` below is the supported fallback.

```json
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@styles/*": ["src/styles/*"]
    }
  }
}
```

With that configuration, this import is checked without extra ESLint options:

```js
import styles from '@styles/Button.module.scss';
```

Vite and webpack configuration is intentionally not read or executed. If an alias exists only there, repeat its local mapping in `aliases` as shown in the configuration example above.

Sass modules are compiled with Dart Sass (the optional `sass` peer dependency) before selector extraction. Nesting, mixins, local `@use` / `@forward`, static interpolation, and local `composes` therefore resolve to the selectors the module exposes.

```scss
/* Card.module.scss */
.card {
  &--active {
    display: block;
  }
}
```

```js
import styles from './Card.module.scss';

styles['card--active'];
```

Less modules are compiled the same way, so nesting, `&` concatenation, mixins, selector
interpolation, and local `@import` all resolve before selectors are read.

```less
/* Card.module.less */
@import 'tokens';

.card {
  &--active {
    display: block;
  }
}
```

```js
import styles from './Card.module.less';

styles['card--active'];
```

Less can execute JavaScript through its `@plugin` directive and inline backticks. Both are
refused, and only `.less` and `.css` files inside the project are ever handed to the compiler:
Less inlines the bytes of whatever it reads, and selector interpolation can turn them into a class
name, so a stylesheet must not be able to read `.env` or a `.js` file.

That has one visible cost. `data-uri()` no longer inlines an image and degrades to a plain
`url(...)`, which is harmless — the stylesheet still compiles and exposes the same class names.
`image-size()` has no such fallback in Less, so a stylesheet that calls it does not compile and is
reported by `unresolvable-stylesheet`. If you need it, keep those rules out of `.module.less` files
and in a plain stylesheet your build compiles.

Only local project files are followed. Paths outside the project root, symlink escapes,
`node_modules` composition, remote URLs, and package imports are rejected, for Sass and Less
alike.

## Find unused classes

`css-modules/no-unused-class` is opt-in because it analyzes one source file at a time. Enable it when each CSS Module belongs to one component or source file:

```js
export default [
  cssModules.configs.recommended,
  {
    rules: {
      'css-modules/no-unused-class': 'warn',
    },
  },
];
```

Static dot access, static bracket access, and object destructuring count as use. Local `composes` dependencies count as use too. Dynamic access, passing the module object elsewhere, or Sass `@extend` makes the rule skip that module instead of issuing a risky false positive.

When the rule skips a module, it skips it entirely — no classes from that stylesheet are reported, even ones that really are unused, because the rule can no longer tell:

```js
import styles from './Button.module.scss';

styles.root;               // counted as use
const { icon } = styles;   // counted as use
styles[iconVariant];       // dynamic: the whole module is skipped, not just this line
applyTheme(styles);        // passed elsewhere: the whole module is skipped too
```

```scss
/* Card.module.scss */
.card {
  @extend .panel; // any Sass @extend in the file skips the whole module, regardless of usage
}
```

```scss
/* Card.module.scss */
.base {}
.card {
  composes: base; // .base is used because .card composes it, even without a direct JS reference
}
```

Cross-file `composes: base from './base.module.css'` is different: it makes `.base` resolve as
part of `Card`'s exported properties for `no-unknown-class`, but it does not mark `.base` as used
inside `base.module.css` — usage there still has to come from a JS reference in the same file that
imports `base.module.css`.

Because the skip is whole-module, a single stray report almost never means "the rule missed one
use case" — it means every usage found in that file was static, and the class in question
genuinely wasn't one of them. The most common cause: the class is only ever used from a *different*
source file. The rule only looks at the file that does the `import`, by design (see above); classes
inside `:global()` are a local module's public API surface and are never checked by this rule at
all, in either direction.

For stylesheets with several consumers, use the project-wide CLI instead:

```sh
css-modules-lint check-unused src
```

It exits with:

| Code | Meaning |
| --- | --- |
| `0` | No unused classes found |
| `1` | Unused classes found |
| `2` | The scan was incomplete or its input was invalid; no clean result is claimed |

The CLI parses source files with the optional `typescript` peer dependency. Without it every class
would look unused, so the scan exits `2` and says why instead of reporting false positives. When
the cause can be named it is printed, and `--format json` carries it in a `reason` field that
appears only in that case.

Use JSON in CI or pass the same alias and Sass settings when needed:

```sh
css-modules-lint check-unused src \
  --root . \
  --format json \
  --alias '@styles/*=src/styles/*' \
  --load-path src/styles \
  --locals-convention camelCase \
  --cache-limit 512
```

Available CLI options are `--root <path>`, `--format <text|json>`, repeatable `--alias <prefix=path>` and `--load-path <path>` (`--sass-load-path` is a deprecated alias), `--locals-convention <value>`, `--no-cache`, and `--cache-limit <count>`.

## Editor autocomplete

This package validates code in ESLint and CI. For CSS Module completion and type hints in TypeScript editors, pair it with [`typescript-plugin-css-modules`](https://www.npmjs.com/package/typescript-plugin-css-modules):

```sh
npm install --save-dev typescript-plugin-css-modules
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "plugins": [{ "name": "typescript-plugin-css-modules" }]
  }
}
```

The TypeScript plugin improves editor experience, but it does not run during `tsc`; keep this ESLint plugin for a repeatable local and CI check.

## Coming from eslint-plugin-css-modules

[`eslint-plugin-css-modules`](https://github.com/atfzl/eslint-plugin-css-modules) is marked **not maintained** and only supports the legacy `.eslintrc` format, so it cannot be configured under ESLint 9/10 flat config at all. This package is a from-scratch flat-config replacement; it does not share code or a config format with it.

| `eslint-plugin-css-modules` | This package | Notes |
| --- | --- | --- |
| `css-modules/no-undef-class` | `css-modules/no-unknown-class` | Also understands destructuring and template literals, and offers typo suggestions |
| `css-modules/no-unused-class` | `css-modules/no-unused-class` | Same intent; opt-in here because it assumes one file owns the module |
| `{ camelCase: true }` rule option | `localsConvention: 'camelCase'` plugin option | Shared across every enabled rule instead of set per rule |
| `settings['css-modules'].basePath` | `aliases` / automatic `tsconfig.json` reading | No global base path; aliases are explicit or derived from `compilerOptions.paths` |
| `.eslintrc` `plugins` + `extends` | flat config `cssModules.configs.recommended` | See [Quick start](#quick-start) |

To migrate: remove `eslint-plugin-css-modules` and its `.eslintrc` entries, install this package, and add `cssModules.configs.recommended` to your flat config as shown above. There is no automated codemod; the rule behavior is close enough that most projects only need to re-tune `suggestThreshold` and `localsConvention` after switching.

## Scope and safety

- Checks default imports ending in `.module.css`, `.module.scss`, `.module.sass`, or `.module.less`.
- Does not attempt to infer dynamic property names or inspect CSS-in-JS.
- Reads regular local files only; performs no writes, subprocess execution, `eval`, or configuration execution.
- Parses `tsconfig.json` as data and uses local-only Sass and Less file resolution.
- Refuses Less `@plugin` directives and inline JavaScript, so a stylesheet cannot run code.
- Reads only `.less` and `.css` files for Less, checked after symlink resolution.

See the [security policy](SECURITY.md) for reporting security issues.

## Contributing

Found a bug, edge case, or missing CSS Modules pattern? Please [open an issue](https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/issues) with a minimal reproducer. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and pull request checklist.

## License

[MIT](LICENSE)
