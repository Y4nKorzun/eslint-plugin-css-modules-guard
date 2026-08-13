import { createRequire } from 'node:module';

import type ts from 'typescript';

/**
 * `typescript` is an optional peer dependency, loaded lazily for two unrelated jobs: reading
 * `compilerOptions.paths` out of a `tsconfig.json`, and parsing source files for the CLI's
 * project-wide scan. The import above is type-only, so nothing here reaches the emitted JavaScript
 * and no exported signature in this package's public `.d.ts` can name the module.
 */
export type TypeScriptModule = typeof ts;

export type TypeScriptLoader = (id: string) => unknown;

const defaultLoader: TypeScriptLoader = createRequire(import.meta.url);

let loader: TypeScriptLoader = defaultLoader;
let loadAttempted = false;
let cachedTypeScript: TypeScriptModule | undefined;

/** Test seam. Pass `undefined` to restore the real resolver. Not part of the public API. */
export function setTypeScriptLoader(nextLoader: TypeScriptLoader | undefined): void {
  loader = nextLoader ?? defaultLoader;
  loadAttempted = false;
  cachedTypeScript = undefined;
}

/**
 * Resolves `typescript` from this plugin's own location, so a linted project cannot decide which
 * parser runs. Memoized on the attempt, so a missing peer costs one failed resolve per process.
 */
export function loadTypeScript(): TypeScriptModule | undefined {
  if (!loadAttempted) {
    loadAttempted = true;
    try {
      cachedTypeScript = loader('typescript') as TypeScriptModule;
    } catch {
      cachedTypeScript = undefined;
    }
  }

  return cachedTypeScript;
}

export function isTypeScriptAvailable(): boolean {
  return loadTypeScript() !== undefined;
}
