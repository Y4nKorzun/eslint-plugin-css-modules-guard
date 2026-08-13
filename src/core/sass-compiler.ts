import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  isInsideOrEqual,
  isSafeProjectFile,
  resolveAliasedPaths,
  safeLoadPaths,
} from './resolver.js';
import type { ExtractorOptions } from './types.js';

/**
 * Structural subset of the `sass` API this plugin uses. Declared locally rather than imported from
 * `sass` itself: the compiler is an optional peer dependency, so nothing in the emitted `.d.ts`
 * may reference it - a consumer without `sass` installed still has to be able to typecheck.
 */
export type SassSyntax = 'css' | 'indented' | 'scss';

interface SassCanonicalizeContext {
  containingUrl?: URL | null;
}

interface SassImporterResult {
  contents: string;
  syntax: SassSyntax;
  sourceMapUrl?: URL;
}

export interface SassImporter {
  canonicalize(url: string, context: SassCanonicalizeContext): URL | null;
  load(canonicalUrl: URL): SassImporterResult | null;
}

interface SassCompileOptions {
  url: URL;
  importer: SassImporter;
  style: 'expanded';
  syntax: SassSyntax;
  /** Opaque here; only `Logger.silent` is ever handed back to Sass. */
  logger: unknown;
}

export interface SassModule {
  compileString(source: string, options: SassCompileOptions): { css: string };
  Logger: { silent: unknown };
}

export type SassLoader = (id: string) => unknown;

const SAFE_SASS_URL_SCHEME = 'css-modules-real:';
const SASS_EXTENSIONS = ['.scss', '.sass', '.css'];

const defaultLoader: SassLoader = createRequire(import.meta.url);

let loader: SassLoader = defaultLoader;
let loadAttempted = false;
let cachedSass: SassModule | undefined;

/** Test seam. Pass `undefined` to restore the real resolver. Not part of the public API. */
export function setSassLoader(nextLoader: SassLoader | undefined): void {
  loader = nextLoader ?? defaultLoader;
  loadAttempted = false;
  cachedSass = undefined;
}

/**
 * Resolves `sass` from this plugin's own location, so a linted project cannot decide which
 * compiler runs. Memoized on the attempt, so a missing peer costs one failed resolve per process.
 *
 * A copy without `compileString` is treated as absent. Dart Sass only grew the modern JS API in
 * 1.45, and now that the compiler is a peer dependency the project picks the version: an older one
 * would otherwise throw inside every compile and surface as an unexplained `Unable to compile` on
 * perfectly valid stylesheets.
 */
function loadSass(): SassModule | undefined {
  if (!loadAttempted) {
    loadAttempted = true;
    try {
      const loaded = loader('sass') as SassModule | undefined;
      cachedSass = typeof loaded?.compileString === 'function' ? loaded : undefined;
    } catch {
      cachedSass = undefined;
    }
  }

  return cachedSass;
}

export function isSassAvailable(): boolean {
  return loadSass() !== undefined;
}

export function sassSyntax(filePath: string): SassSyntax {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.sass') {
    return 'indented';
  }
  if (extension === '.css') {
    return 'css';
  }

  return 'scss';
}

function sassCandidates(candidate: string): string[] {
  const extension = extname(candidate).toLowerCase();
  const names: string[] = [];
  const addWithPartial = (filePath: string): void => {
    names.push(filePath);
    if (!basename(filePath).startsWith('_')) {
      names.push(join(dirname(filePath), `_${basename(filePath)}`));
    }
  };

  if (SASS_EXTENSIONS.includes(extension)) {
    addWithPartial(candidate);
  } else {
    for (const sassExtension of SASS_EXTENSIONS) {
      addWithPartial(`${candidate}${sassExtension}`);
      names.push(join(candidate, `index${sassExtension}`));
      names.push(join(candidate, `_index${sassExtension}`));
    }
  }

  return [...new Set(names)];
}

function resolveSafeSassFile(candidate: string, options: ExtractorOptions): string | undefined {
  const matches = sassCandidates(candidate).flatMap((filePath) => {
    const safeFile = isSafeProjectFile(filePath, options.rootDir);
    return safeFile ? [safeFile] : [];
  });

  return matches.length === 1 ? matches[0] : undefined;
}

function customSassUrl(filePath: string): URL {
  return new URL(`${SAFE_SASS_URL_SCHEME}//${pathToFileURL(filePath).pathname}`);
}

function pathFromCustomSassUrl(url: URL): string | undefined {
  if (url.protocol !== SAFE_SASS_URL_SCHEME) {
    return undefined;
  }

  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

interface ResolvedSassReference {
  candidate: string;
  importer: string;
  specifier: string;
}

function resolvedSassReference(
  url: string,
  entryPath: string,
  resolvedFiles: ReadonlySet<string>,
): ResolvedSassReference | undefined {
  const parsedUrl = new URL(url);
  const candidate = parsedUrl.protocol === 'file:'
    ? fileURLToPath(parsedUrl)
    : pathFromCustomSassUrl(parsedUrl)!;

  const sourceFiles = parsedUrl.protocol === 'file:' ? [entryPath] : [...resolvedFiles];
  const importer = sourceFiles
    .filter((source) => isInsideOrEqual(dirname(source), candidate))
    .sort((left, right) => right.length - left.length)[0];
  if (!importer) {
    return undefined;
  }

  const specifier = relative(dirname(importer), candidate);
  if (!specifier || specifier === '..' || specifier.startsWith(`..${sep}`)) {
    return undefined;
  }

  return { candidate, importer, specifier };
}

export function safeSassImporter(
  entryPath: string,
  options: ExtractorOptions,
  dependencies: Set<string>,
): SassImporter {
  const loadPaths = safeLoadPaths(options);
  const resolvedFiles = new Set([entryPath]);
  const rememberSassFile = (safeFile: string): URL => {
    dependencies.add(safeFile);
    resolvedFiles.add(safeFile);
    return customSassUrl(safeFile);
  };

  return {
    canonicalize(url, context) {
      if (url.startsWith(SAFE_SASS_URL_SCHEME)) {
        const candidate = pathFromCustomSassUrl(new URL(url));
        if (!candidate || !isInsideOrEqual(options.rootDir, candidate)) {
          throw new Error('Sass imports must stay inside the project root.');
        }
        const safeFile = resolveSafeSassFile(candidate, options);
        if (safeFile) {
          return rememberSassFile(safeFile);
        }
      }

      if (url.startsWith('sass:')) {
        return null;
      }

      let localCandidate: string;
      let resolvingDirectory = dirname(entryPath);
      let resolvingFile = entryPath;
      let normalizedReference: ResolvedSassReference | undefined;
      if (url.startsWith('file:')) {
        normalizedReference = resolvedSassReference(url, entryPath, resolvedFiles);
        localCandidate = normalizedReference?.candidate ?? fileURLToPath(url);
        if (normalizedReference) {
          resolvingFile = normalizedReference.importer;
          resolvingDirectory = dirname(resolvingFile);
        }
      } else if (url.startsWith(SAFE_SASS_URL_SCHEME)) {
        normalizedReference = resolvedSassReference(url, entryPath, resolvedFiles);
        if (!normalizedReference) {
          throw new Error('Unable to resolve a local Sass import.');
        }
        localCandidate = normalizedReference.candidate;
        resolvingFile = normalizedReference.importer;
        resolvingDirectory = dirname(resolvingFile);
      } else if (context.containingUrl?.protocol === SAFE_SASS_URL_SCHEME) {
        const containingFile = pathFromCustomSassUrl(context.containingUrl);
        if (!containingFile) {
          throw new Error('Unable to resolve a Sass import.');
        }
        resolvingDirectory = dirname(containingFile);
        resolvingFile = containingFile;
        localCandidate = resolve(resolvingDirectory, url);
      } else if (context.containingUrl?.protocol === 'file:') {
        resolvingFile = fileURLToPath(context.containingUrl);
        resolvingDirectory = dirname(resolvingFile);
        localCandidate = resolve(resolvingDirectory, url);
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        throw new Error('Only local Sass imports are supported.');
      } else {
        localCandidate = resolve(dirname(entryPath), url);
      }

      if (!isInsideOrEqual(options.rootDir, localCandidate)) {
        throw new Error('Sass imports must stay inside the project root.');
      }

      const specifier = normalizedReference?.specifier ?? url;
      const aliases = !specifier.startsWith('.') && !specifier.startsWith('file:')
        ? resolveAliasedPaths(resolvingFile, specifier, options)
        : { candidates: [], dependencies: [] };
      for (const dependency of aliases.dependencies) {
        dependencies.add(dependency);
      }

      const candidates = [...aliases.candidates, localCandidate];
      const loadPathReference = relative(resolvingDirectory, localCandidate);
      if (!loadPathReference.startsWith(`..${sep}`) && loadPathReference !== '..') {
        candidates.push(...loadPaths.map((loadPath) => resolve(loadPath, loadPathReference)));
      }

      for (const candidate of new Set(candidates)) {
        const safeFile = resolveSafeSassFile(candidate, options);
        if (safeFile) {
          return rememberSassFile(safeFile);
        }
      }

      throw new Error('Unable to resolve a local Sass import.');
    },
    load(canonicalUrl) {
      const filePath = pathFromCustomSassUrl(canonicalUrl);
      const safeFile = filePath && isSafeProjectFile(filePath, options.rootDir);
      if (!safeFile) {
        throw new Error('Sass imports must stay inside the project root.');
      }

      dependencies.add(safeFile);
      return {
        contents: readFileSync(safeFile, 'utf8'),
        syntax: sassSyntax(safeFile),
        sourceMapUrl: pathToFileURL(safeFile),
      };
    },
  };
}

export function compileSassStylesheet(
  filePath: string,
  options: ExtractorOptions,
): { css: string; dependencies: Set<string> } | undefined {
  const sassModule = loadSass();
  if (!sassModule) {
    return undefined;
  }

  const dependencies = new Set([filePath]);
  const result = sassModule.compileString(readFileSync(filePath, 'utf8'), {
    url: pathToFileURL(filePath),
    importer: safeSassImporter(filePath, options, dependencies),
    style: 'expanded',
    syntax: sassSyntax(filePath),
    logger: sassModule.Logger.silent,
  });

  return { css: result.css, dependencies };
}
