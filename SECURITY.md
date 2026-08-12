# Security policy

The plugin treats CSS, SCSS, Sass, and Less as untrusted input: it reads only regular files under the configured project root, resolves every Sass and Less import through a local-only file resolver, and never writes files or starts subprocesses.

Less is the one supported language that can execute code: its `@plugin` directive loads and runs JavaScript, and backticks evaluate inline JavaScript. Neither is permitted. Compilation runs with `javascriptEnabled: false`, and the Less file manager refuses every load Less marks as JavaScript, which is how plugin loads arrive. A source scan additionally refuses to compile a stylesheet whose text declares `@plugin` at the start of a line, in the entry file or any imported one; it is a fast first check, not the guarantee.

The Less file manager hands Less nothing but stylesheets: a resolved file is read only if it is a `.less` or `.css` file inside the project root. This is an allowlist applied to the resolved path rather than to the requested name, because a `*.less` symlink may point at any file, and because Less inlines the bytes of whatever it is given - through `@import (inline)`, `data-uri()`, or `image-size()` - after which selector interpolation can turn those bytes into a class name this plugin reports. One consequence is deliberate: `data-uri()` and `image-size()` of images and other non-stylesheet assets do not resolve. `data-uri()` degrades to a plain `url(...)`, which does not affect class names.

Please report a suspected path escape, arbitrary code execution, unintended disk write, or denial-of-service issue privately to the package maintainer before opening a public issue. Include a minimal reproducer and the installed package version.
