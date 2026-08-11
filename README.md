# eslint-plugin-css-modules-guard

An ESLint 9 and 10 flat-config plugin that reads local CSS Modules at lint time. It reports unknown `styles.foo` properties and CSS Modules that cannot be resolved or compiled. SCSS and Sass are compiled with Dart Sass first, so nesting, mixins, `@extend`, and static interpolation resolve to their real selectors.

```sh
npm install --save-dev eslint-plugin-css-modules-guard eslint
```

```js
// eslint.config.js
import cssModules from 'eslint-plugin-css-modules-guard';

export default [cssModules.configs.recommended];
```

```js
import styles from './Button.module.scss';

styles.primray; // Unknown CSS Module class "primray". Did you mean styles.primary?
```

## Rule: `css-modules/no-unknown-class`

The rule checks default imports ending in `.module.css`, `.module.scss`, and `.module.sass`. It validates dot access and static bracket access. Dynamic computed keys are intentionally skipped; classes named in `:global()` are also allowed because they are outside the plugin's authority.

```js
{
  rules: {
    'css-modules/no-unknown-class': ['error', {
      localsConvention: 'camelCase',
      sassLoadPaths: ['src/styles'],
      suggestThreshold: 2,
      cache: true,
      cacheLimit: 512,
    }],
  },
}
```

The plugin reads `compilerOptions.paths` automatically from the nearest local `tsconfig.json`, including safe local project references, for CSS Module imports and local Sass `@use` / `@forward` paths. `camelCase` and `dashes` expose both the original and camel-cased property name; `camelCaseOnly` exposes only the latter.

`cacheLimit` defaults to `256` and only bounds the in-memory extraction cache. When overriding `configs.recommended`, apply the same limit to both rules so either rule does not lower the shared cache limit.

### Aliases from Vite or webpack

The plugin intentionally does not read or execute Vite or webpack configuration. If an alias exists only there, repeat its local, project-root-relative mapping with the existing `aliases` option on both rules:

```js
// eslint.config.js
import cssModules from 'eslint-plugin-css-modules-guard';

const aliases = {
  '~styles': 'src/styles',
};

export default [
  cssModules.configs.recommended,
  {
    rules: {
      'css-modules/no-unknown-class': ['error', { aliases }],
      'css-modules/unresolvable-stylesheet': ['error', { aliases }],
    },
  },
];
```

Without that mapping, `css-modules/unresolvable-stylesheet` correctly reports an aliased stylesheet or Sass import that cannot be resolved or compiled. This is a configuration gap, not a Sass false positive.

When a close class name exists, ESLint receives a suggestion that replaces the whole access expression. Editors can apply it in one click; the plugin never applies the change automatically.

## Rule: `css-modules/unresolvable-stylesheet`

The recommended config enables this rule. It reports a default CSS Module import when the stylesheet is missing, unsafe, or fails to compile. This prevents an unsupported Sass construct from looking like a successful lint run.

## Unused classes CLI

`no-unused-class` needs a project-wide view, so it is a CLI pass rather than an ESLint rule.

```sh
css-modules-lint check-unused src --format json
css-modules-lint check-unused src --cache-limit 512
```

It exits `1` when unused classes are found and `0` otherwise. A dynamic module access marks that module as used. If any source file cannot be parsed or a CSS Module cannot be read, it exits `2` instead of claiming that no classes are unused; JSON output then contains `"incomplete": true`.

## Safety model

- Reads regular local files only, rooted at ESLint's current working directory.
- Rejects paths outside that root, symlink escapes, `node_modules` composition, remote Sass URLs, and package Sass imports.
- Sass uses a local-only importer; configured load paths must also be under the project root.
- Performs no writes, subprocess execution, `eval`, or configuration execution. `tsconfig.json` is parsed as data.
- Keeps at most 256 content-hash-validated, recently used entries in memory by default; set `cacheLimit` (or CLI `--cache-limit`) for larger projects. It never creates a cache file.

CSS-in-JS, automatic Vite/webpack configuration parsing, webpack-loader integration, and composition from npm packages are intentionally out of scope.
