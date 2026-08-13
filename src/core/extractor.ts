import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

import { compileLessStylesheet } from './less-compiler.js';
import { isSafeProjectFile, resolveStylesheet } from './resolver.js';
import { compileSassStylesheet } from './sass-compiler.js';
import type { ExtractionResult, ExtractorOptions, LocalsConvention } from './types.js';

interface Composition {
  names: string[];
  source?: string;
}

interface ParsedStylesheet {
  exportedValues: string[];
  rawClasses: string[];
  globalClasses: string[];
  hasExtend: boolean;
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
  hasExtend: boolean;
}

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
  return [filePath, options.rootDir, ...options.loadPaths, JSON.stringify(aliases)].join('\0');
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

export type StylesheetLanguage = 'css' | 'less' | 'sass';

export function stylesheetLanguage(filePath: string): StylesheetLanguage {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.scss' || extension === '.sass') {
    return 'sass';
  }
  if (extension === '.less') {
    return 'less';
  }

  return 'css';
}

function compilePlainStylesheet(
  filePath: string,
  options: ExtractorOptions,
): CompiledStylesheet | undefined {
  const dependencies = fingerprintDependencies([filePath], options.rootDir);
  return dependencies
    ? { css: readFileSync(filePath, 'utf8'), dependencies, hasExtend: false }
    : undefined;
}

function compileSassStylesheetEntry(
  filePath: string,
  options: ExtractorOptions,
): CompiledStylesheet | undefined {
  const compiled = compileSassStylesheet(filePath, options);
  if (!compiled) {
    return undefined;
  }

  const hasExtend = [...compiled.dependencies].some(
    (dependency) => /\.(?:scss|sass)$/i.test(dependency) && /@extend\b/.test(readFileSync(dependency, 'utf8')),
  );
  const fingerprints = fingerprintDependencies([...compiled.dependencies], options.rootDir);
  return fingerprints ? { css: compiled.css, dependencies: fingerprints, hasExtend } : undefined;
}

function compileLessStylesheetEntry(
  filePath: string,
  options: ExtractorOptions,
): CompiledStylesheet | undefined {
  const compiled = compileLessStylesheet(filePath, options);
  if (!compiled) {
    return undefined;
  }

  const hasExtend = [...compiled.dependencies].some(
    (dependency) => /\.less$/i.test(dependency) && /:extend\s*\(/.test(readFileSync(dependency, 'utf8')),
  );
  const fingerprints = fingerprintDependencies([...compiled.dependencies], options.rootDir);
  return fingerprints ? { css: compiled.css, dependencies: fingerprints, hasExtend } : undefined;
}

export function compileStylesheet(
  filePath: string,
  options: ExtractorOptions,
): CompiledStylesheet | undefined {
  try {
    switch (stylesheetLanguage(filePath)) {
      case 'sass':
        return compileSassStylesheetEntry(filePath, options);
      case 'less':
        return compileLessStylesheetEntry(filePath, options);
      default:
        return compilePlainStylesheet(filePath, options);
    }
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
  hasExtend: boolean,
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
      hasExtend,
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

  const parsed = parseStylesheet(compiled.css, filePath, compiled.hasExtend);
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
        hasExtend: false,
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
      hasExtend: parsed.hasExtend,
      hasSassExtend: parsed.hasExtend,
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
