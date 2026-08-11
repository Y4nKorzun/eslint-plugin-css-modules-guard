# eslint-plugin-css-modules-guard

[![npm version](https://img.shields.io/npm/v/eslint-plugin-css-modules-guard.svg)](https://www.npmjs.com/package/eslint-plugin-css-modules-guard)
[![npm downloads](https://img.shields.io/npm/dm/eslint-plugin-css-modules-guard.svg)](https://www.npmjs.com/package/eslint-plugin-css-modules-guard)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Catch CSS Modules mistakes before they reach the browser. This ESLint 9 and 10 flat-config plugin reads your local `.module.css`, `.module.scss`, and `.module.sass` files at lint time, so it can check the class names your code actually uses.

It compiles Sass before checking selectors, understands local `composes`, and reports stylesheets that cannot be resolved or compiled. Use it in the editor and in CI; it does not need generated `.d.ts` files.

## Install

Requires Node.js 20+ and ESLint 9 or 10.

```sh
npm install --save-dev eslint eslint-plugin-css-modules-guard
```

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
| `css-modules/no-unknown-class` | Yes | Static dot, bracket, template-literal, and destructured names that do not exist in the module |
| `css-modules/unresolvable-stylesheet` | Yes | A CSS Module import that is missing, outside the project, unsafe, or cannot compile |
| `css-modules/no-unused-class` | No | Local classes unused by one source file; enable only when that ownership rule is true |

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
  sassLoadPaths: ['src/styles'],
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
| `sassLoadPaths` | `[]` | Local Sass load paths, relative to the project root unless absolute |
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

## Aliases and Sass

The plugin automatically reads `compilerOptions.paths` from the nearest local `tsconfig.json`, including safe local `extends` files and project references.

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

Sass modules are compiled with Dart Sass before selector extraction. Nesting, mixins, local `@use` / `@forward`, static interpolation, and local `composes` therefore resolve to the selectors the module exposes.

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

Only local project files are followed. Paths outside the project root, symlink escapes, `node_modules` composition, remote Sass URLs, and package Sass imports are rejected.

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

Use JSON in CI or pass the same alias and Sass settings when needed:

```sh
css-modules-lint check-unused src \
  --root . \
  --format json \
  --alias '@styles/*=src/styles/*' \
  --sass-load-path src/styles \
  --locals-convention camelCase \
  --cache-limit 512
```

Available CLI options are `--root <path>`, `--format <text|json>`, repeatable `--alias <prefix=path>` and `--sass-load-path <path>`, `--locals-convention <value>`, `--no-cache`, and `--cache-limit <count>`.

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

## Scope and safety

- Checks default imports ending in `.module.css`, `.module.scss`, or `.module.sass`.
- Does not attempt to infer dynamic property names or inspect CSS-in-JS.
- Reads regular local files only; performs no writes, subprocess execution, `eval`, or configuration execution.
- Parses `tsconfig.json` as data and uses a local-only Sass importer.

See the [security policy](SECURITY.md) for reporting security issues.

## Contributing

Found a bug, edge case, or missing CSS Modules pattern? Please [open an issue](https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/issues) with a minimal reproducer.

## License

[MIT](LICENSE)
