# Security policy

The plugin treats CSS, SCSS, Sass, and Less as untrusted input: it reads only regular files under the configured project root, resolves every Sass and Less import through a local-only file resolver, and never writes files or starts subprocesses.

Less is the one supported language that can execute code: its `@plugin` directive loads and runs JavaScript. The plugin blocks this three ways - it compiles with `javascriptEnabled: false`, its Less file manager refuses loads marked as JavaScript and any candidate resolving to a `.js`, `.cjs`, or `.mjs` file, and it refuses to compile any stylesheet whose source declares `@plugin`, including imported ones.

Please report a suspected path escape, arbitrary code execution, unintended disk write, or denial-of-service issue privately to the package maintainer before opening a public issue. Include a minimal reproducer and the installed package version.
