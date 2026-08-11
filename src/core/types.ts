export type LocalsConvention = 'asIs' | 'camelCase' | 'camelCaseOnly' | 'dashes';

export interface CssModulesOptions {
  localsConvention?: LocalsConvention;
  aliases?: Record<string, string>;
  sassLoadPaths?: string[];
  suggestThreshold?: number;
  cache?: boolean;
  cacheLimit?: number;
}

export interface ExtractorOptions {
  rootDir: string;
  localsConvention: LocalsConvention;
  aliases: Record<string, string>;
  sassLoadPaths: string[];
  suggestThreshold: number;
  cache: boolean;
  cacheLimit: number;
}

export interface ExtractionResult {
  /** Every property that can be read from the module object. */
  classes: ReadonlySet<string>;
  /** CSS class selectors defined by this stylesheet, excluding composed dependencies. */
  localClasses: ReadonlySet<string>;
  /** Direct local CSS class dependencies created by `composes`. */
  localCompositions?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Sass `@extend` prevents a complete unused-class analysis. */
  hasSassExtend?: boolean;
}

export interface ResolvedStylesheet {
  path: string;
}
