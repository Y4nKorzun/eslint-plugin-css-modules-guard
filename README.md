# eslint-plugin-css-modules-guard

An ESLint 9 and 10 flat-config plugin that reads local CSS Modules at lint time and reports unknown `styles.foo` properties. SCSS and Sass are compiled with Dart Sass first, so nesting, mixins, `@extend`, and static interpolation resolve to their real selectors.

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
    }],
  },
}
```

The plugin reads `compilerOptions.paths` automatically from the nearest local `tsconfig.json`, including safe local project references. `camelCase` and `dashes` expose both the original and camel-cased property name; `camelCaseOnly` exposes only the latter.

## Unused classes CLI

`no-unused-class` needs a project-wide view, so it is a CLI pass rather than an ESLint rule.

```sh
css-modules-lint check-unused src --format json
```

It exits `1` when unused classes are found and `0` otherwise. A dynamic module access marks that module as used, and a source-file parse failure produces no findings rather than a false positive.

## Safety model

- Reads regular local files only, rooted at ESLint's current working directory.
- Rejects paths outside that root, symlink escapes, `node_modules` composition, remote Sass URLs, and package Sass imports.
- Sass uses a local-only importer; configured load paths must also be under the project root.
- Performs no writes, subprocess execution, `eval`, or configuration execution. `tsconfig.json` is parsed as data.
- Keeps at most 256 content-hash-validated entries in memory; it never creates a cache file.

CSS-in-JS, webpack-loader integration, and composition from npm packages are intentionally out of scope.
