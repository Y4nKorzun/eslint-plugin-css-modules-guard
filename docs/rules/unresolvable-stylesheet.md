# css-modules/unresolvable-stylesheet

Require a CSS Module import to resolve and compile before its classes are checked.

Included in `cssModules.configs.recommended` at `error`.

This rule is what keeps [`no-unknown-class`](no-unknown-class.md) honest. A stylesheet that cannot
be read exports no classes, which is indistinguishable from a stylesheet with no classes. Rather
than let the other rules go quiet, this one reports the import itself.

## What it catches

```js
import styles from './Buton.module.css';   // typo in the path
import theme from '@styles/theme.module.scss';   // alias nothing maps
import vendor from 'some-package/x.module.css';  // outside the project
```

An import is reported when the file is missing, resolves outside the project root, escapes through
a symlink, fails to compile, or needs a compiler that is not installed.

## Messages

| Message | Meaning |
| --- | --- |
| `Unable to resolve CSS Module "…"` | No local file matched the specifier |
| `Unable to compile CSS Module "…"` | The file exists, but Sass or Less rejected it |
| `… Install the optional peer dependency "sass" …` | A `.module.scss` or `.module.sass` import with no `sass` installed |
| `… Install the optional peer dependency "less" …` | A `.module.less` import with no `less` installed |
| `… Install the optional peer dependency "typescript" …` | An alias-shaped specifier did not resolve, and a `tsconfig.json` sits nearby that no parser could read |

The install hints only fire for a genuinely absent compiler. A real compile error still gets the
plain `Unable to compile` message, so a broken stylesheet is never mistaken for a missing package.

`.module.css` needs no compiler at all and never produces an install hint.

## Optional compilers

Only what a project actually uses has to be installed:

```sh
npm install --save-dev sass          # ^1.45.0 - .module.scss and .module.sass
npm install --save-dev less          # ^4.0.0  - .module.less
npm install --save-dev typescript    # aliases read from compilerOptions.paths
```

The Sass floor is `1.45.0`, the release that introduced the modern JavaScript API this plugin
compiles through. An older copy is treated as absent and earns the install hint, rather than
failing every stylesheet with an unexplained compile error.

Without `typescript`, `compilerOptions.paths` is not read. Explicit `aliases` in the rule options
keep working and are the supported fallback:

```js
{
  aliases: { '@styles/*': 'src/styles/*' },
}
```

## Safety

Resolution is local-only by design. Paths outside the project root, symlink escapes,
`node_modules`, remote URLs, and package imports are all rejected — for Sass and Less alike. Less
`@plugin` directives and inline JavaScript are refused, and only `.less` and `.css` files are ever
handed to the Less compiler, checked after symlink resolution.

See the [security policy](https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/blob/main/SECURITY.md).

## Options

Identical to the other CSS Modules rules; see [`no-unknown-class`](no-unknown-class.md#options).
`aliases` and `loadPaths` are the ones that matter here.

## When not to use it

If some CSS Module imports are resolved by a bundler alias you cannot mirror in `aliases` or
`tsconfig.json`, this rule reports them. Either add the mapping or disable the rule for those
files — but prefer adding the mapping, since `no-unknown-class` cannot check what it cannot read.
