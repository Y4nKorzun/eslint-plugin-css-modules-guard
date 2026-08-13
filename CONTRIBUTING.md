# Contributing

## Setup

```sh
npm ci
```

Requires Node.js 20.19+ (the floor the `sass` dependency itself declares). `npm run test:coverage` additionally requires **Node.js 22.5+**: it passes
`--test-coverage-exclude` (added in Node v22.5.0) to keep the test file itself out of the
function-coverage numbers, and Node 20 rejects the unknown flag outright. On Node 20 run
`npm test`; CI enforces the coverage gate on Node 24.

## Workflow

```sh
npm run build          # compile TypeScript to dist/
npm test               # build, then run the test suite
npm run test:coverage  # build, then run tests with 100% line/branch/function coverage enforced
npm run pack:check     # dry-run the npm tarball to check `files` and package layout
```

`npm run check` is an alias for `npm test` and is what CI runs alongside `test:coverage` and
`pack:check`. All three must pass before a pull request can merge.

Coverage is enforced at 100%; new code needs tests that exercise it, including error paths (a
missing stylesheet, an unresolvable alias, invalid Sass, and similar edge cases already covered in
`test/fixtures`).

## Making changes

- Source lives in `src/`; tests live in `test/` and read fixtures from `test/fixtures/`. Add a
  fixture alongside existing ones rather than inlining large CSS/SCSS strings in the test file.
- Keep rule behavior conservative: when in doubt, skip a check rather than risk a false positive
  (`no-unused-class` deliberately skips modules it can't fully account for; follow that precedent).
- `less` is an **optional peer dependency**, kept as a devDependency so the tests can compile
  Less. It must never move into `dependencies`: projects that do not use Less should not
  download a Less compiler. Import it only through the loader in `src/core/less-compiler.ts`.
- Rules must stay read-only — no writing files, running subprocesses, or executing `eval`. See
  [`SECURITY.md`](SECURITY.md) for the threat model this plugin operates under.
- Update `README.md` when you change an option, a rule's behavior, or the CLI, and add an entry to
  [`CHANGELOG.md`](CHANGELOG.md) under an `[Unreleased]` heading.

## Pull requests

1. Fork and branch from `main`.
2. Make your change with tests.
3. Run `npm run test:coverage` and `npm run pack:check` locally.
4. Open a PR describing the behavior change and, for bug fixes, the minimal case that used to fail.

## Reporting bugs

Open an issue with a minimal reproducer: the relevant CSS/SCSS, the source file accessing it, your
plugin options, and the ESLint version. For suspected security issues, follow
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.
