import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import * as sass from 'sass';

import { isInside, isSafeProjectFile, resolveAliasedPaths, resolveStylesheet } from './resolver.js';
import type { ExtractionResult, ExtractorOptions, LocalsConvention } from './types.js';

interface Composition {
  names: string[];
  source?: string;
}

interface ParsedStylesheet {
  exportedValues: string[];
  rawClasses: string[];
  globalClasses: string[];
  hasSassExtend: boolean;
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
  hasSassExtend: boolean;
}

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
  const aliases = Object.entries(options.aliases);
  return [filePath, options.rootDir, ...options.sassLoadPaths, JSON.stringify(aliases)].join('\0');
}

function trimCache(cacheLimit: number): void {
  while (extractionCache.size > cacheLimit) {
    const oldestKey = extractionCache.keys().next().value;
    extractionCache.delete(oldestKey!);
  }
}

function remember(key: string, entry: CacheEntry, cacheLimit: number): void {
  extractionCache.delete(key);
  extractionCache.set(key, entry);
  trimCache(cacheLimit);
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
): sass.Importer<'sync'> {
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

export function compileStylesheet(
  filePath: string,
  options: ExtractorOptions,
): CompiledStylesheet | undefined {
  try {
    if (!/\.(?:scss|sass)$/i.test(filePath)) {
      const dependencies = fingerprintDependencies([filePath], options.rootDir);
      return dependencies ? { css: readFileSync(filePath, 'utf8'), dependencies, hasSassExtend: false } : undefined;
    }

    const dependencies = new Set([filePath]);
    const result = sass.compileString(readFileSync(filePath, 'utf8'), {
      url: pathToFileURL(filePath),
      importer: safeSassImporter(filePath, options, dependencies),
      style: 'expanded',
      syntax: sassSyntax(filePath),
      logger: sass.Logger.silent,
    });

    const hasSassExtend = [...dependencies].some(
      (dependency) => /\.(?:scss|sass)$/i.test(dependency) && /@extend\b/.test(readFileSync(dependency, 'utf8')),
    );
    const fingerprints = fingerprintDependencies([...dependencies], options.rootDir);
    return fingerprints ? { css: result.css, dependencies: fingerprints, hasSassExtend } : undefined;
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

function parseStylesheet(
  css: string,
  filePath: string,
  hasSassExtend: boolean,
): ParsedStylesheet | undefined {
  try {
    const root = postcss.parse(css, { from: filePath });
    const rawClasses = new Set<string>();
    const globalClasses = new Set<string>();
    const exportedValues = new Set<string>();
    const compositions = new Map<string, Composition[]>();

    root.walkRules((rule) => {
      if (rule.selector.trim() === ':export') {
        rule.walkDecls((declaration) => {
          exportedValues.add(declaration.prop);
        });
        return;
      }

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

    return {
      rawClasses: [...rawClasses],
      globalClasses: [...globalClasses],
      exportedValues: [...exportedValues],
      hasSassExtend,
      compositions,
    };
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
  if (options.cache) {
    trimCache(options.cacheLimit);
  }
  const cached = options.cache ? extractionCache.get(key) : undefined;

  if (cached && isCacheValid(cached)) {
    extractionCache.delete(key);
    extractionCache.set(key, cached);
    return cached.parsed;
  }

  const compiled = compileStylesheet(filePath, options);
  if (!compiled) {
    return undefined;
  }

  const parsed = parseStylesheet(compiled.css, filePath, compiled.hasSassExtend);
  if (!parsed) {
    return undefined;
  }

  if (options.cache) {
    remember(key, { dependencies: compiled.dependencies, parsed }, options.cacheLimit);
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
      result: {
        classes: new Set(),
        localClasses: new Set(),
        localCompositions: new Map(),
        hasSassExtend: false,
      },
      exports: new Map(),
    };
  }

  const parsed = loadParsedStylesheet(filePath, options);
  if (!parsed) {
    return undefined;
  }

  const localClasses = new Set(parsed.rawClasses);
  const localCompositions = new Map<string, Set<string>>();
  for (const className of parsed.rawClasses) {
    const dependencies = new Set<string>();
    for (const composition of parsed.compositions.get(className) ?? []) {
      if (composition.source) {
        continue;
      }
      for (const composedClass of composition.names) {
        if (localClasses.has(composedClass)) {
          dependencies.add(composedClass);
        }
      }
    }
    if (dependencies.size > 0) {
      localCompositions.set(className, dependencies);
    }
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
          if (localClasses.has(composedClass)) {
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
  for (const exportedValue of parsed.exportedValues) {
    addClassNames(classes, exportedValue, options.localsConvention);
  }
  for (const className of parsed.globalClasses) {
    addClassNames(classes, className, options.localsConvention);
  }
  for (const className of parsed.rawClasses) {
    for (const propertyName of resolveExport(className)) {
      classes.add(propertyName);
    }
  }

  return {
    result: {
      classes,
      localClasses,
      localCompositions,
      hasSassExtend: parsed.hasSassExtend,
    },
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

export function usedLocalClasses(
  extracted: ExtractionResult,
  usedProperties: ReadonlySet<string>,
  convention: LocalsConvention,
): Set<string> {
  const used = new Set<string>();
  const pending = [...extracted.localClasses].filter((className) =>
    [...propertyNamesForClass(className, convention)]
      .some((propertyName) => usedProperties.has(propertyName)),
  );

  while (pending.length > 0) {
    const className = pending.pop()!;
    if (used.has(className)) {
      continue;
    }
    used.add(className);
    for (const dependency of extracted.localCompositions?.get(className) ?? []) {
      pending.push(dependency);
    }
  }

  return used;
}

export function clearExtractionCache(): void {
  extractionCache.clear();
}

export function getExtractionCacheKeys(): readonly string[] {
  return [...extractionCache.keys()];
}
