import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import type { ExtractorOptions, ResolvedStylesheet } from './types.js';

interface AliasMapping {
  key: string;
  target: string;
  baseDir: string;
}

interface TsconfigAliases {
  baseDir: string;
  mappings: AliasMapping[];
  dependencies: string[];
}

export interface AliasResolution {
  candidates: string[];
  dependencies: string[];
}

const CSS_MODULE_SUFFIX = /\.module\.(?:css|scss|sass)$/i;

export function isCssModuleSpecifier(specifier: string): boolean {
  return CSS_MODULE_SUFFIX.test(specifier);
}

export function isInside(rootDir: string, candidate: string): boolean {
  const pathFromRoot = relative(rootDir, candidate);
  return (
    pathFromRoot !== '' &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

export function isSafeProjectFile(candidate: string, rootDir: string): string | undefined {
  try {
    const realPath = realpathSync(candidate);

    if (
      !statSync(realPath).isFile() ||
      !isInside(rootDir, realPath) ||
      realPath.split(sep).includes('node_modules')
    ) {
      return undefined;
    }

    return realPath;
  } catch {
    return undefined;
  }
}

function findNearestTsconfig(importer: string, rootDir: string): string | undefined {
  let current = dirname(importer);

  while (current === rootDir || isInside(rootDir, current)) {
    const config = join(current, 'tsconfig.json');
    if (existsSync(config)) {
      return config;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }

  return undefined;
}

function localExtendedConfig(
  value: unknown,
  configPath: string,
  rootDir: string,
): string | undefined {
  if (typeof value !== 'string' || (!value.startsWith('.') && !isAbsolute(value))) {
    return undefined;
  }

  const candidate = resolve(dirname(configPath), value.endsWith('.json') ? value : `${value}.json`);
  return isSafeProjectFile(candidate, rootDir);
}

function localReferenceConfig(
  value: unknown,
  configPath: string,
  rootDir: string,
): string | undefined {
  if (typeof value !== 'string' || (!value.startsWith('.') && !isAbsolute(value))) {
    return undefined;
  }

  const reference = resolve(dirname(configPath), value);
  const candidate = value.endsWith('.json') ? reference : join(reference, 'tsconfig.json');
  return isSafeProjectFile(candidate, rootDir);
}

function localReferencedConfigs(
  value: unknown,
  configPath: string,
  rootDir: string,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((reference) => {
    const referencePath = typeof reference === 'object' && reference !== null
      ? (reference as { path?: unknown }).path
      : undefined;
    const localConfig = localReferenceConfig(referencePath, configPath, rootDir);
    return localConfig ? [localConfig] : [];
  });
}

function readTsconfigAliases(
  configPath: string,
  rootDir: string,
  visited = new Set<string>(),
): TsconfigAliases | undefined {
  const safeConfig = isSafeProjectFile(configPath, rootDir);
  if (!safeConfig || visited.has(safeConfig)) {
    return undefined;
  }

  try {
    const parsed = ts.parseConfigFileTextToJson(safeConfig, readFileSync(safeConfig, 'utf8'));
    const config = parsed.config as {
      extends?: unknown;
      compilerOptions?: { baseUrl?: unknown; paths?: unknown };
      references?: unknown;
    };

    const nextVisited = new Set(visited).add(safeConfig);
    const parentPath = localExtendedConfig(config.extends, safeConfig, rootDir);
    const parent = parentPath
      ? readTsconfigAliases(parentPath, rootDir, nextVisited)
      : undefined;
    const references = localReferencedConfigs(config.references, safeConfig, rootDir).flatMap(
      (referencePath) => {
        const referenced = readTsconfigAliases(referencePath, rootDir, nextVisited);
        return referenced ? [referenced] : [];
      },
    );
    const ownBaseUrl = config.compilerOptions?.baseUrl;
    const baseDir = typeof ownBaseUrl === 'string'
      ? resolve(dirname(safeConfig), ownBaseUrl)
      : parent?.baseDir ?? dirname(safeConfig);
    const rawPaths = config.compilerOptions?.paths;
    const inheritedMappings = [
      ...(parent?.mappings ?? []),
      ...references.flatMap((reference) => reference.mappings),
    ];
    const dependencies = [...new Set([
      safeConfig,
      ...(parent?.dependencies ?? []),
      ...references.flatMap((reference) => reference.dependencies),
    ])];

    if (!rawPaths || typeof rawPaths !== 'object' || Array.isArray(rawPaths)) {
      return { baseDir, mappings: inheritedMappings, dependencies };
    }

    const mappings = Object.entries(rawPaths).flatMap(([key, targets]) =>
      Array.isArray(targets)
        ? targets.flatMap((target) => typeof target === 'string' ? [{ key, target, baseDir }] : [])
        : [],
    );
    return { baseDir, mappings: [...inheritedMappings, ...mappings], dependencies };
  } catch {
    return undefined;
  }
}

function tsconfigAliases(importer: string, rootDir: string): TsconfigAliases | undefined {
  const configPath = findNearestTsconfig(importer, rootDir);
  return configPath ? readTsconfigAliases(configPath, rootDir) : undefined;
}

function explicitAliases(options: ExtractorOptions): AliasMapping[] {
  return Object.entries(options.aliases).map(([key, target]) => ({
    key,
    target,
    baseDir: options.rootDir,
  }));
}

function aliasRemainder(specifier: string, key: string): string | undefined {
  const wildcardIndex = key.indexOf('*');

  if (wildcardIndex >= 0) {
    const prefix = key.slice(0, wildcardIndex);
    const suffix = key.slice(wildcardIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
      return undefined;
    }
    return specifier.slice(prefix.length, specifier.length - suffix.length);
  }

  if (specifier === key) {
    return '';
  }

  if (specifier.startsWith(`${key}/`)) {
    return specifier.slice(key.length + 1);
  }

  return undefined;
}

function isInsideOrEqual(rootDir: string, candidate: string): boolean {
  return candidate === rootDir || isInside(rootDir, candidate);
}

function resolveAliasCandidates(
  specifier: string,
  mappings: AliasMapping[],
  rootDir: string,
): string[] {
  const orderedMappings = [...mappings].sort((left, right) => right.key.length - left.key.length);
  const candidates: string[] = [];

  for (const mapping of orderedMappings) {
    const remainder = aliasRemainder(specifier, mapping.key);
    if (remainder === undefined) {
      continue;
    }

    const target = mapping.target.replace('*', remainder);
    const candidate = remainder && !mapping.target.includes('*')
      ? join(mapping.baseDir, target, remainder)
      : resolve(mapping.baseDir, target);
    if (isInsideOrEqual(rootDir, candidate)) {
      candidates.push(candidate);
    }
  }

  return [...new Set(candidates)];
}

export function resolveAliasedPaths(
  importer: string,
  specifier: string,
  options: ExtractorOptions,
): AliasResolution {
  const tsconfig = tsconfigAliases(importer, options.rootDir);
  return {
    candidates: resolveAliasCandidates(
      specifier,
      [...explicitAliases(options), ...(tsconfig?.mappings ?? [])],
      options.rootDir,
    ),
    dependencies: tsconfig?.dependencies ?? [],
  };
}

export function resolveStylesheet(
  importer: string,
  specifier: string,
  options: ExtractorOptions,
): ResolvedStylesheet | undefined {
  if (
    !isCssModuleSpecifier(specifier) ||
    specifier.includes('\0') ||
    specifier.includes('?') ||
    specifier.includes('#')
  ) {
    return undefined;
  }

  const rootDir = options.rootDir;
  const candidates = specifier.startsWith('.')
    ? [resolve(dirname(importer), specifier)]
    : resolveAliasedPaths(importer, specifier, options).candidates;
  const candidate = candidates.flatMap((path) => {
    const safeFile = isSafeProjectFile(path, rootDir);
    return safeFile ? [safeFile] : [];
  })[0];

  return candidate ? { path: candidate } : undefined;
}
