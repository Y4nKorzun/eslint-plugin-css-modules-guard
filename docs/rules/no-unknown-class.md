# css-modules/no-unknown-class

Disallow reading a class that the imported CSS Module does not export.

Included in `cssModules.configs.recommended` at `error`.

The rule reads the local `.module.css`, `.module.scss`, `.module.sass`, or `.module.less` file
behind a default import, compiles it when the language needs compiling, and compares the class
names it exports against the property names your code reads. No generated `.d.ts` file is involved.

## What it catches

```scss
/* Button.module.scss */
.root {}
.primary {}
```

```js
import styles from './Button.module.scss';

styles.primray;   // Unknown CSS Module class "primray". Did you mean styles.primary?
styles.root;      // ok
```

Every direct access form is checked:

```js
styles.primary;              // dot access
styles['primary'];           // static bracket access
styles[`primary`];           // template literal with no expressions
const { primary } = styles;  // destructuring
```

Finite computed keys are checked too, without TypeScript type information:

```js
const size = compact ? 'sm' : 'lg';
styles[`size_${size}`];

const tone = 'primary';
styles[tone];
```

Supported expressions are string literals, immutable `const` aliases, conditionals, template
literals, string concatenation, and TypeScript `as const` expressions. Every possible candidate is
checked. Suggestions remain limited to direct accesses because replacing an entire computed
expression would be an unsafe edit.

## What it accepts

- ICSS `:export` values.
- Classes declared inside `:global(...)`.
- Classes reached through `composes`, including `composes: base from './base.module.css'`.
- Anything a compiler produces: Sass and Less nesting, `&` concatenation, mixins, and static
  selector interpolation all resolve before selectors are read.

## What it skips

Runtime access is deliberately not guessed:

```js
const variant = readFromApi();
styles[variant];             // indeterminate, never reported as unknown
styles[`is-${state.value}`]; // indeterminate: runtime object state
```

Mutable bindings, function results, escaped module objects, cycles, and expressions above the
fixed analysis ceiling are indeterminate. They do not produce speculative errors.

## Suggestions

A near-miss produces an ESLint *suggestion*, not an autofix — the rule never rewrites your code on
its own. `suggestThreshold` caps the edit distance; `0` turns suggestions off.

## Options

Shared with every CSS Modules rule. See the
[options table](https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard#configure-the-rules)
for the full list.

```js
{
  localsConvention: 'camelCase',      // asIs | camelCase | camelCaseOnly | dashes
  aliases: { '@styles/*': 'src/styles/*' },
  loadPaths: ['src/styles'],
  suggestThreshold: 2,
  cache: true,
  cacheLimit: 256,
}
```

`localsConvention` must match your CSS loader, or correct code is reported. For `.card-title`:

| Convention | Accepted property names |
| --- | --- |
| `asIs` | `styles['card-title']` |
| `camelCase` or `dashes` | `styles['card-title']` and `styles.cardTitle` |
| `camelCaseOnly` | `styles.cardTitle` |

## When not to use it

If your components receive the module object from somewhere else rather than importing it
directly, the rule has nothing to check and stays silent — there is no cost, but no value either.

## Related

- [`unresolvable-stylesheet`](unresolvable-stylesheet.md) — reports the import this rule could not
  read, so a missing stylesheet is never mistaken for a stylesheet with no classes.
- [`no-unused-class`](no-unused-class.md) — the other direction: classes nothing reads.
