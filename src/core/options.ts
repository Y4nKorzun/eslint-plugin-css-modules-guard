import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CssModulesOptions, ExtractorOptions } from './types.js';

const DEFAULTS: Required<CssModulesOptions> = {
  localsConvention: 'asIs',
  aliases: {},
  sassLoadPaths: [],
  suggestThreshold: 2,
  cache: true,
  cacheLimit: 256,
};

export function normalizeOptions(
  options: CssModulesOptions | undefined,
  rootDir: string,
): ExtractorOptions {
  let safeRoot = resolve(rootDir);
  const cacheLimit = options?.cacheLimit ?? DEFAULTS.cacheLimit;

  try {
    safeRoot = realpathSync(safeRoot);
  } catch {
    // ESLint can provide a virtual filename. Falling back to its cwd is safe.
  }

  return {
    rootDir: safeRoot,
    localsConvention: options?.localsConvention ?? DEFAULTS.localsConvention,
    aliases: options?.aliases ?? DEFAULTS.aliases,
    sassLoadPaths: options?.sassLoadPaths ?? DEFAULTS.sassLoadPaths,
    suggestThreshold: options?.suggestThreshold ?? DEFAULTS.suggestThreshold,
    cache: options?.cache ?? DEFAULTS.cache,
    cacheLimit: Number.isSafeInteger(cacheLimit) && cacheLimit > 0
      ? cacheLimit
      : DEFAULTS.cacheLimit,
  };
}
