import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';

import { isSafeProjectFile, resolveAliasedPathsFrom, safeLoadPaths } from './resolver.js';
import type { ExtractorOptions } from './types.js';

/**
 * Structural subset of the `less` API this plugin uses. Declared locally rather than pulled from
 * `@types/less`: `less` is an optional peer dependency, and `tsconfig.json` pins `types` to node.
 */
interface LessLoadOptions {
  ext?: string;
  mime?: string;
}

interface LessFileLoad {
  contents?: string;
  filename?: string;
  error?: Error;
}

interface LessFileManager {
  supports(): boolean;
  supportsSync(): boolean;
  loadFile(): Promise<never>;
  loadFileSync(
    filename: string,
    currentDirectory: string,
    loadOptions: LessLoadOptions,
  ): LessFileLoad;
}

interface LessPluginManager {
  addFileManager(fileManager: LessFileManager): void;
}

interface LessRenderOptions {
  filename: string;
  syncImport: boolean;
  javascriptEnabled: boolean;
  plugins: { install(less: unknown, pluginManager: LessPluginManager): void }[];
}

export interface LessModule {
  FileManager: new () => LessFileManager;
  render(
    input: string,
    options: LessRenderOptions,
    callback: (error: unknown, output?: { css: string }) => void,
  ): void;
}

export type LessLoader = (id: string) => unknown;

/**
 * `@plugin` makes Less load and execute JavaScript. This catches the common form early; the real
 * guarantee is the JavaScript refusal in `resolveLessImport`, which Less routes every plugin load
 * through regardless of where in the file the directive appears.
 */
const LESS_PLUGIN_DIRECTIVE = /^\s*@plugin\b/m;
/**
 * Only stylesheets are ever handed to Less. An allowlist rather than a `.js` denylist, because
 * Less will inline the bytes of whatever it is given - through `@import (inline)`, `data-uri()`,
 * or `image-size()` - and interpolation can then carry those bytes into a selector, which this
 * plugin reports as a class name. A denylist also misses a `*.less` symlink pointing at a secret.
 */
const STYLESHEET_EXTENSIONS = new Set(['.less', '.css']);
/** Matches a URL scheme without swallowing a Windows drive letter (`C:\...`). */
const NON_LOCAL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;
/** Less's own `AbstractFileManager.tryAppendExtension` guard. */
const HAS_EXTENSION_OR_QUERY = /(\.[a-z]*$)|([?;].*)$/;

const defaultLoader: LessLoader = createRequire(import.meta.url);

let loader: LessLoader = defaultLoader;
let loadAttempted = false;
let cachedLess: LessModule | undefined;

/** Test seam. Pass `undefined` to restore the real resolver. Not part of the public API. */
export function setLessLoader(nextLoader: LessLoader | undefined): void {
  loader = nextLoader ?? defaultLoader;
  loadAttempted = false;
  cachedLess = undefined;
}

/**
 * Resolves `less` from this plugin's own location, so a linted project cannot decide which
 * compiler runs. Memoized on the attempt, so a missing peer costs one failed resolve per process.
 */
function loadLess(): LessModule | undefined {
  if (!loadAttempted) {
    loadAttempted = true;
    try {
      cachedLess = loader('less') as LessModule;
    } catch {
      cachedLess = undefined;
    }
  }

  return cachedLess;
}

export function isLessAvailable(): boolean {
  return loadLess() !== undefined;
}

function withLessExtension(candidate: string, extension: string | undefined): string {
  return typeof extension === 'string' && !HAS_EXTENSION_OR_QUERY.test(candidate)
    ? `${candidate}${extension}`
    : candidate;
}

function resolveLessImport(
  specifier: string,
  currentDirectory: string,
  loadOptions: LessLoadOptions,
  entryPath: string,
  options: ExtractorOptions,
  loadPaths: readonly string[],
  dependencies: Set<string>,
): string | undefined {
  // `@plugin` arrives here marked as JavaScript. Refusing it is what stops Less executing code.
  if (loadOptions.mime === 'application/javascript' || NON_LOCAL_SCHEME.test(specifier)) {
    return undefined;
  }

  // Less reports a directory (with a trailing separator); an absolute one wins, an empty one
  // falls back to the entry file's directory, all without an extra branch.
  const baseDirectory = resolve(dirname(entryPath), currentDirectory);
  const candidates: string[] = [];

  if (!specifier.startsWith('.')) {
    const aliased = resolveAliasedPathsFrom(baseDirectory, specifier, options);
    for (const dependency of aliased.dependencies) {
      dependencies.add(dependency);
    }
    candidates.push(...aliased.candidates);
  }

  candidates.push(resolve(baseDirectory, specifier));
  candidates.push(...loadPaths.map((loadPath) => resolve(loadPath, specifier)));

  for (const candidate of candidates) {
    const safeFile = isSafeProjectFile(withLessExtension(candidate, loadOptions.ext), options.rootDir);
    // Checked on the resolved path, never the requested name: a `*.less` symlink can point at any
    // file in the project, and the requested name says nothing about what is actually on disk.
    if (safeFile && STYLESHEET_EXTENSIONS.has(extname(safeFile).toLowerCase())) {
      return safeFile;
    }
  }

  return undefined;
}

export function safeLessFileManager(
  entryPath: string,
  options: ExtractorOptions,
  dependencies: Set<string>,
  lessModule: LessModule,
): LessFileManager {
  const loadPaths = safeLoadPaths(options);

  return new (class extends lessModule.FileManager {
    /**
     * Always true, for both of these. Less consults file managers from the end of its list and
     * falls back to its own node file manager - which happily reads `node_modules` and anything
     * else on disk - for whatever we decline here. Every refusal must therefore happen inside
     * loadFileSync, never by declining support.
     */
    supports(): boolean {
      return true;
    }

    supportsSync(): boolean {
      return true;
    }

    /** Never reached under `syncImport`; fails closed if Less ever takes the async path. */
    loadFile(): Promise<never> {
      return Promise.reject(new Error('Less imports must resolve synchronously.'));
    }

    loadFileSync(
      filename: string,
      currentDirectory: string,
      loadOptions: LessLoadOptions,
    ): LessFileLoad {
      const resolved = resolveLessImport(
        filename,
        currentDirectory,
        loadOptions,
        entryPath,
        options,
        loadPaths,
        dependencies,
      );
      if (!resolved) {
        return { error: new Error('Unable to resolve a local Less import.') };
      }

      const contents = readFileSync(resolved, 'utf8');
      if (LESS_PLUGIN_DIRECTIVE.test(contents)) {
        return { error: new Error('Less @plugin directives are not supported.') };
      }

      dependencies.add(resolved);
      return { contents, filename: resolved };
    }
  })();
}

export function compileLessStylesheet(
  filePath: string,
  options: ExtractorOptions,
): { css: string; dependencies: Set<string> } | undefined {
  const lessModule = loadLess();
  if (!lessModule) {
    return undefined;
  }

  const source = readFileSync(filePath, 'utf8');
  if (LESS_PLUGIN_DIRECTIVE.test(source)) {
    return undefined;
  }

  const dependencies = new Set([filePath]);
  const fileManager = safeLessFileManager(filePath, options, dependencies, lessModule);
  let css: string | undefined;

  lessModule.render(source, {
    filename: filePath,
    syncImport: true,
    javascriptEnabled: false,
    plugins: [{
      install(_less, pluginManager) {
        pluginManager.addFileManager(fileManager);
      },
    }],
  }, (_error, output) => {
    if (output) {
      css = output.css;
    }
  });

  // Covers a compile error, an empty result, and a callback that never ran synchronously.
  return css === undefined ? undefined : { css, dependencies };
}
