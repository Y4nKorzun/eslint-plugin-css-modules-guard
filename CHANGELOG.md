# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.2] - 2026-08-12

### Added

- `CHANGELOG.md`, `CONTRIBUTING.md`, and GitHub issue/pull request templates.
- Migration guide from the unmaintained `eslint-plugin-css-modules`, mapping its rules and options
  onto this plugin's flat-config equivalents.
- Concrete `no-unused-class` examples for each condition that makes the rule skip a module
  (dynamic access, passing the module object elsewhere, Sass `@extend`), plus clarification that
  cross-file `composes` does not mark the composed-from class as used in its own file.

### Changed

- CI now runs the full declared support matrix: Node.js 20, 22, and 24 against ESLint 9 and 10,
  matching `engines.node` and `peerDependencies.eslint`.

## [0.8.1] - 2026-08-11

### Changed

- Improved package documentation.

## [0.8.0] - 2026-08-11

### Added

- Opt-in `css-modules/no-unused-class` rule, flagging local classes that are declared but never
  referenced from the owning source file.

### Fixed

- False positives in `no-unused-class` for classes reached through `composes`, dynamic access, and
  re-exports.

## [0.7.1] - 2026-08-11

### Fixed

- ICSS `:export` values are now resolved with the same `localsConvention` handling as regular
  classes, instead of always being matched as-is.

### Changed

- CI now runs on a Node.js runtime that supports the coverage tooling used by `test:coverage`.
- Pull requests are verified in CI.

## [0.7.0] - 2026-08-11

### Added

- Destructured CSS Module class access (`const { root } = styles`) is now checked by
  `no-unknown-class`.
- Configurable LRU cache (`cache`, `cacheLimit` options) for stylesheet extraction, shared across
  enabled rules.

### Fixed

- Cache invalidation and destructuring semantics preserved together correctly.

## [0.6.1] - 2026-08-11

### Fixed

- Documented manual CSS Module alias configuration for setups without a local `tsconfig.json`.

## [0.6.0] - 2026-08-11

### Added

- Automatic reading of `compilerOptions.paths` from the nearest local `tsconfig.json`, including
  safe local `extends` files and project references.
- ESLint 10 support.

### Changed

- Hardened CSS Module diagnostics (resolution and compilation error reporting).
- Package renamed to `eslint-plugin-css-modules-guard`.
- Trusted npm publishing via GitHub Actions OIDC.

### Fixed

- `bin` entry preserved through the package build so `css-modules-lint` resolves correctly after
  install.

## [0.4.0] - 2026-08-11

### Added

- Initial release: `css-modules/no-unknown-class` and `css-modules/unresolvable-stylesheet` rules
  for ESLint 9 flat config, reading local `.module.css`, `.module.scss`, and `.module.sass` files.

[Unreleased]: https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/compare/v0.8.2...HEAD
[0.8.2]: https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/compare/v0.4.0...v0.6.0
[0.4.0]: https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/releases/tag/v0.4.0
