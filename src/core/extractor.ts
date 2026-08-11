import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import * as sass from 'sass';

import { isInside, isSafeProjectFile, resolveStylesheet } from './resolver.js';
import type { ExtractionResult, ExtractorOptions, LocalsConvention } from './types.js';

interface Composition {
  names: string[];
  source?: string;
}

interface ParsedStylesheet {
  rawClasses: string[];
  globalClasses: string[];
  compositions: Map<string, Composition[]>;
}

interface ExtractionDetails {
  result: ExtractionResult;
  exports: ReadonlyMap<string, ReadonlySet<string>>;
}

interface CacheEntry {
  dependencies: Map<string, string>;
  parsed: ParsedStylesheet;
}

interface CompiledStylesheet {
  css: string;
  dependencies: Map<string, string>;
}

const CACHE_LIMIT = 256;
const SAFE_SASS_URL_SCHEME = 'css-modules-real:';
const SASS_EXTENSIONS = ['.scss', '.sass', '.css'];
const extractionCache = new Map<string, CacheEntry>();

function hashFile(filePath: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}

function isCacheValid(entry: CacheEntry): boolean {
  for (const [filePath, expectedHash] of entry.dependencies) {
    if (hashFile(filePath) !== expectedHash) {
      return false;
    }
  }

  return true;
}

function cacheKey(filePath: string, options: ExtractorOptions): string {
  return [filePath, options.rootDir, ...options.sassLoadPaths].join('\0');
}

function remember(key: string, entry: CacheEntry): void {
  extractionCache.set(key, entry);

  if (extractionCache.size > CACHE_LIMIT) {
    const oldestKey = extractionCache.keys().next().value;
    if (oldestKey) {
      extractionCache.delete(oldestKey);
    }
  }
}

function safeLoadPaths(options: ExtractorOptions): string[] {
  return options.sassLoadPaths.flatMap((loadPath) => {
    try {
      const candidate = isAbsolute(loadPath)
        ? loadPath
        : resolve(options.rootDir, loadPath);
      const realPath = realpathSync(candidate);

      if (
        !statSync(realPath).isDirectory() ||
        (realPath !== options.rootDir && !isInside(options.rootDir, realPath)) ||
        realPath.split(sep).includes('node_modules')
      ) {
        return [];
      }

      return [realPath];
    } catch {
      return [];
    }
  });
}

function isInsideOrEqual(rootDir: string, candidate: string): boolean {
  return candidate === rootDir || isInside(rootDir, candidate);
}

function sassSyntax(filePath: string): sass.Syntax {
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
  const directory = dirname(candidate);
  const baseName = basename(candidate);
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

export function safeSassImporter(
  entryPath: string,
  options: ExtractorOptions,
  dependencies: Set<string>,
): sass.Importer<'sync'> {
  const loadPaths = safeLoadPaths(options);

  return {
    canonicalize(url, context) {
      if (url.startsWith(SAFE_SASS_URL_SCHEME)) {
        const candidate = pathFromCustomSassUrl(new URL(url));
        if (!candidate || !isInsideOrEqual(options.rootDir, candidate)) {
          throw new Error('Sass imports must stay inside the project root.');
        }
        const safeFile = resolveSafeSassFile(candidate, options);
        if (!safeFile) {
          throw new Error('Unable to resolve a local Sass import.');
        }
        dependencies.add(safeFile);
        return customSassUrl(safeFile);
      }

      if (url.startsWith('sass:')) {
        return null;
      }

      let localCandidate: string;
      let resolvingDirectory = dirname(entryPath);
      if (url.startsWith('file:')) {
        localCandidate = fileURLToPath(url);
      } else if (context.containingUrl?.protocol === SAFE_SASS_URL_SCHEME) {
        const containingFile = pathFromCustomSassUrl(context.containingUrl);
        if (!containingFile) {
          throw new Error('Unable to resolve a Sass import.');
        }
        resolvingDirectory = dirname(containingFile);
        localCandidate = resolve(resolvingDirectory, url);
      } else if (context.containingUrl?.protocol === 'file:') {
        resolvingDirectory = dirname(fileURLToPath(context.containingUrl));
        localCandidate = resolve(resolvingDirectory, url);
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        throw new Error('Only local Sass imports are supported.');
      } else {
        localCandidate = resolve(dirname(entryPath), url);
      }

      if (!isInsideOrEqual(options.rootDir, localCandidate)) {
        throw new Error('Sass imports must stay inside the project root.');
      }

      const candidates = [localCandidate];
      const loadPathReference = relative(resolvingDirectory, localCandidate);
      if (!loadPathReference.startsWith(`..${sep}`) && loadPathReference !== '..') {
        candidates.push(...loadPaths.map((loadPath) => resolve(loadPath, loadPathReference)));
      }

      for (const candidate of candidates) {
        const safeFile = resolveSafeSassFile(candidate, options);
        if (safeFile) {
          dependencies.add(safeFile);
          return customSassUrl(safeFile);
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

export function compileStylesheet(
  filePath: string,
  options: ExtractorOptions,
): CompiledStylesheet | undefined {
  try {
    if (!/\.(?:scss|sass)$/i.test(filePath)) {
      const dependencies = fingerprintDependencies([filePath], options.rootDir);
      return dependencies ? { css: readFileSync(filePath, 'utf8'), dependencies } : undefined;
    }

    const dependencies = new Set([filePath]);
    const result = sass.compileString(readFileSync(filePath, 'utf8'), {
      url: pathToFileURL(filePath),
      importer: safeSassImporter(filePath, options, dependencies),
      style: 'expanded',
      syntax: sassSyntax(filePath),
      logger: sass.Logger.silent,
    });

    const fingerprints = fingerprintDependencies([...dependencies], options.rootDir);
    return fingerprints ? { css: result.css, dependencies: fingerprints } : undefined;
  } catch {
    return undefined;
  }
}

function isGlobalClass(node: selectorParser.ClassName): boolean {
  let parent = node.parent;

  while (parent) {
    if (parent.type === 'pseudo' && parent.value.toLowerCase() === ':global') {
      return true;
    }
    parent = parent.parent;
  }

  return false;
}

function parseComposition(value: string): Composition | undefined {
  const fromMatch = value.match(/\s+from\s+(?:(['"])(.*?)\1|(global))\s*$/);
  const declaration = fromMatch ? value.slice(0, fromMatch.index).trim() : value.trim();
  const globalMatch = declaration.match(/^global\(([^)]+)\)$/);
  const names = (globalMatch?.[1] ?? declaration)
    .split(/\s+/)
    .map((name) => name.trim())
    .filter(Boolean);

  if (names.length === 0) {
    return undefined;
  }

  if (globalMatch || fromMatch?.[3] === 'global') {
    return { names, source: 'global' };
  }

  if (fromMatch?.[2]) {
    return { names, source: fromMatch[2] };
  }

  return { names };
}

function parseStylesheet(css: string, filePath: string): ParsedStylesheet | undefined {
  try {
    const root = postcss.parse(css, { from: filePath });
    const rawClasses = new Set<string>();
    const globalClasses = new Set<string>();
    const compositions = new Map<string, Composition[]>();

    root.walkRules((rule) => {
      const ruleClasses = new Set<string>();
      selectorParser((selectors) => {
        selectors.walkClasses((node) => {
          if (isGlobalClass(node)) {
            globalClasses.add(node.value);
          } else {
            rawClasses.add(node.value);
            ruleClasses.add(node.value);
          }
        });
      }).processSync(rule.selector);

      for (const declaration of rule.nodes!) {
        if (declaration.type !== 'decl' || declaration.prop !== 'composes') {
          continue;
        }
        const composition = parseComposition(declaration.value);
        if (composition) {
          for (const className of ruleClasses) {
            const classCompositions = compositions.get(className) ?? [];
            classCompositions.push(composition);
            compositions.set(className, classCompositions);
          }
        }
      }
    });

    return { rawClasses: [...rawClasses], globalClasses: [...globalClasses], compositions };
  } catch {
    return undefined;
  }
}

export function fingerprintDependencies(
  compiledDependencies: readonly string[],
  rootDir: string,
): Map<string, string> | undefined {
  const dependencies = new Map<string, string>();
  for (const dependency of compiledDependencies) {
    const safeDependency = isSafeProjectFile(dependency, rootDir);
    const fingerprint = safeDependency && hashFile(safeDependency);
    if (!safeDependency || !fingerprint) {
      return undefined;
    }
    dependencies.set(safeDependency, fingerprint);
  }

  return dependencies;
}

function loadParsedStylesheet(
  filePath: string,
  options: ExtractorOptions,
): ParsedStylesheet | undefined {
  const key = cacheKey(filePath, options);
  const cached = options.cache ? extractionCache.get(key) : undefined;

  if (cached && isCacheValid(cached)) {
    return cached.parsed;
  }

  const compiled = compileStylesheet(filePath, options);
  if (!compiled) {
    return undefined;
  }

  const parsed = parseStylesheet(compiled.css, filePath);
  if (!parsed) {
    return undefined;
  }

  if (options.cache) {
    remember(key, { dependencies: compiled.dependencies, parsed });
  }

  return parsed;
}

function camelCase(name: string): string {
  return name.replace(/-+([a-zA-Z0-9])/g, (_, character: string) => character.toUpperCase());
}

export function propertyNamesForClass(
  className: string,
  convention: LocalsConvention,
): Set<string> {
  const transformed = camelCase(className);

  switch (convention) {
    case 'camelCaseOnly':
      return new Set([transformed]);
    case 'camelCase':
    case 'dashes':
      return new Set([className, transformed]);
    case 'asIs':
      return new Set([className]);
  }
}

function addClassNames(
  target: Set<string>,
  className: string,
  convention: LocalsConvention,
): void {
  for (const propertyName of propertyNamesForClass(className, convention)) {
    target.add(propertyName);
  }
}

function extractCssModule(
  filePath: string,
  options: ExtractorOptions,
  ancestors: ReadonlySet<string>,
): ExtractionDetails | undefined {
  if (ancestors.has(filePath)) {
    return {
      result: { classes: new Set(), localClasses: new Set() },
      exports: new Map(),
    };
  }

  const parsed = loadParsedStylesheet(filePath, options);
  if (!parsed) {
    return undefined;
  }

  const localClasses = new Set<string>();
  for (const className of parsed.rawClasses) {
    addClassNames(localClasses, className, options.localsConvention);
  }

  const nextAncestors = new Set(ancestors).add(filePath);
  const exportedClasses = new Map<string, Set<string>>();
  const resolving = new Set<string>();

  const resolveExport = (className: string): Set<string> => {
    const cached = exportedClasses.get(className);
    if (cached) {
      return cached;
    }
    if (resolving.has(className)) {
      return new Set();
    }

    resolving.add(className);
    const exported = propertyNamesForClass(className, options.localsConvention);

    for (const composition of parsed.compositions.get(className) ?? []) {
      if (composition.source === 'global') {
        for (const composedClass of composition.names) {
          addClassNames(exported, composedClass, options.localsConvention);
        }
        continue;
      }

      if (!composition.source) {
        for (const composedClass of composition.names) {
          if (parsed.rawClasses.includes(composedClass)) {
            for (const propertyName of resolveExport(composedClass)) {
              exported.add(propertyName);
            }
          }
        }
        continue;
      }

      const composedStylesheet = resolveStylesheet(filePath, composition.source, options);
      const composed = composedStylesheet && extractCssModule(
        composedStylesheet.path,
        options,
        nextAncestors,
      );
      if (!composed) {
        continue;
      }

      for (const composedClass of composition.names) {
        for (const propertyName of composed.exports.get(composedClass) ?? []) {
          exported.add(propertyName);
        }
      }
    }

    resolving.delete(className);
    exportedClasses.set(className, exported);
    return exported;
  };

  const classes = new Set<string>();
  for (const className of parsed.globalClasses) {
    addClassNames(classes, className, options.localsConvention);
  }
  for (const className of parsed.rawClasses) {
    for (const propertyName of resolveExport(className)) {
      classes.add(propertyName);
    }
  }

  return {
    result: { classes, localClasses },
    exports: exportedClasses,
  };
}

export function extractClasses(
  filePath: string,
  options: ExtractorOptions,
): ExtractionResult | undefined {
  const safeFile = isSafeProjectFile(filePath, options.rootDir);
  return safeFile ? extractCssModule(safeFile, options, new Set())?.result : undefined;
}

export function clearExtractionCache(): void {
  extractionCache.clear();
}
