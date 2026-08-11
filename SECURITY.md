# Security policy

The plugin treats CSS and SCSS as untrusted input: it reads only regular files under the configured project root, uses a local-only Sass importer, and never writes files or starts subprocesses.

Please report a suspected path escape, arbitrary code execution, unintended disk write, or denial-of-service issue privately to the package maintainer before opening a public issue. Include a minimal reproducer and the installed package version.
