# css-modules/no-unused-class

Disallow local CSS Module classes that the importing source file never reads.

**Not** included in `cssModules.configs.recommended`. Enable it only when each CSS Module belongs
to exactly one source file.

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

## Why it is opt-in

The rule analyzes one source file at a time. It reports a class as unused when the file that
imports the stylesheet does not read it — which is wrong whenever a second file imports the same
stylesheet and uses the rest. For stylesheets with several consumers, use the project-wide CLI
instead:

```sh
css-modules-lint check-unused src
```

## What counts as use

```js
import styles from './Button.module.scss';

styles.root;                 // dot access
styles['root'];              // static bracket access
const { icon } = styles;     // destructuring
```

A local `composes` dependency counts too, even with no direct JS reference:

```scss
/* Card.module.scss */
.base {}
.card {
  composes: base;  /* .base is used, because .card composes it */
}
```

## When the rule skips a module

Anything that makes usage unknowable skips the **whole** stylesheet — not just the line involved —
because after it the rule can no longer tell used from unused:

```js
styles[iconVariant];   // dynamic access
applyTheme(styles);    // the module object passed elsewhere
```

```scss
.card {
  @extend .panel;      /* any Sass @extend, or Less :extend(), skips the file */
}
```

Classes inside `:global(...)` are a module's public surface and are never reported, in either
direction.

Because the skip is whole-module, a single report almost never means "the rule missed a use case".
It means every usage found in that file was static and this class was not among them. The usual
cause is a class used only from a *different* source file.

## Cross-file `composes`

```css
/* Card.module.css */
.card {
  composes: base from './base.module.css';
}
```

This makes `base` resolve as part of `Card`'s exported properties for
[`no-unknown-class`](no-unknown-class.md). It does **not** mark `.base` as used inside
`base.module.css` — usage there still has to come from a JS reference in the file that imports
`base.module.css`.

## Options

Identical to the other CSS Modules rules; see
[`no-unknown-class`](no-unknown-class.md#options). Keep `cacheLimit` consistent across enabled
rules — they share one in-memory cache.

## When not to use it

Turn it off when a stylesheet is shared between components, when class names are built dynamically,
or when a design system exposes classes for consumers outside the repository.
