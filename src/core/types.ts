export type LocalsConvention = 'asIs' | 'camelCase' | 'camelCaseOnly' | 'dashes';

export interface CssModulesOptions {
  localsConvention?: LocalsConvention;
  aliases?: Record<string, string>;
  sassLoadPaths?: string[];
  suggestThreshold?: number;
  cache?: boolean;
}

export interface ExtractorOptions {
  rootDir: string;
  localsConvention: LocalsConvention;
  aliases: Record<string, string>;
  sassLoadPaths: string[];
  suggestThreshold: number;
  cache: boolean;
}

export interface ExtractionResult {
  /** Every property that can be read from the module object. */
  classes: ReadonlySet<string>;
  /** Properties defined by this stylesheet, excluding composed dependencies. */
  localClasses: ReadonlySet<string>;
}

export interface ResolvedStylesheet {
  path: string;
}
