import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type ts from 'typescript';

import { extractClasses, usedLocalClasses } from './extractor.js';
import { normalizeOptions } from './options.js';
import { isCssModuleSpecifier, isInsideOrEqual, resolveStylesheet } from './resolver.js';
import { loadTypeScript } from './typescript-loader.js';
import type { TypeScriptModule } from './typescript-loader.js';
import type { CssModulesOptions, ExtractorOptions } from './types.js';

export interface UnusedCheckOptions extends CssModulesOptions {
  rootDir: string;
  paths?: string[];
}

export interface UnusedClass {
  stylesheet: string;
  className: string;
}

export interface UnusedClassesResult {
  incomplete: boolean;
  unused: UnusedClass[];
  /** Why the scan could not finish, when that reason is worth showing instead of a generic one. */
  reason?: string;
}

interface Usage {
  all: boolean;
  classes: Set<string>;
}

interface ImportedBinding {
  binding: ts.Identifier;
  stylesheet: string;
}

interface FileCollection {
  files: string[];
  incomplete: boolean;
}

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const IGNORED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function collectFiles(
  rootDir: string,
  requestedPaths: readonly string[] | undefined,
): FileCollection {
  const files: string[] = [];
  let incomplete = false;
  const startPaths = requestedPaths?.length ? requestedPaths : [rootDir];

  const visit = (candidate: string): void => {
    let realPath: string;
    try {
      realPath = realpathSync(candidate);
    } catch {
      incomplete = true;
      return;
    }

    if (!isInsideOrEqual(rootDir, realPath)) {
      incomplete = true;
      return;
    }

    try {
      for (const entry of readdirSync(realPath, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) {
          continue;
        }

        const entryPath = join(realPath, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
        } else if (entry.isFile() && (isSourceFile(entryPath) || isCssModuleSpecifier(entryPath))) {
          files.push(entryPath);
        }
      }
    } catch {
      incomplete = true;
    }
  };

  for (const requestedPath of startPaths) {
    const candidate = isAbsolute(requestedPath)
      ? requestedPath
      : resolve(rootDir, requestedPath);
    try {
      if (isCssModuleSpecifier(candidate) || isSourceFile(candidate)) {
        const realPath = realpathSync(candidate);
        if (isInsideOrEqual(rootDir, realPath)) {
          files.push(realPath);
        } else {
          incomplete = true;
        }
      } else {
        visit(candidate);
      }
    } catch {
      incomplete = true;
    }
  }

  return { files: [...new Set(files)].sort(), incomplete };
}

function scriptKind(typescript: TypeScriptModule, filePath: string): ts.ScriptKind {
  switch (extname(filePath).toLowerCase()) {
    case '.tsx':
      return typescript.ScriptKind.TSX;
    case '.jsx':
      return typescript.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return typescript.ScriptKind.JS;
    default:
      return typescript.ScriptKind.TS;
  }
}

function usageFor(usages: Map<string, Usage>, stylesheet: string): Usage {
  const existing = usages.get(stylesheet);
  if (existing) {
    return existing;
  }

  const created = { all: false, classes: new Set<string>() };
  usages.set(stylesheet, created);
  return created;
}

function staticElementName(
  typescript: TypeScriptModule,
  node: ts.ElementAccessExpression,
): string | undefined {
  const argument = node.argumentExpression;
  return argument &&
    (typescript.isStringLiteral(argument) || typescript.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function scanSourceFile(
  typescript: TypeScriptModule,
  filePath: string,
  options: ExtractorOptions,
  usages: Map<string, Usage>,
): boolean {
  let sourceText: string;
  try {
    sourceText = readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }

  const source = typescript.createSourceFile(
    filePath,
    sourceText,
    typescript.ScriptTarget.Latest,
    true,
    scriptKind(typescript, filePath),
  );
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    return false;
  }

  const imports = new Map<string, ImportedBinding>();
  for (const statement of source.statements) {
    if (
      !typescript.isImportDeclaration(statement) ||
      !typescript.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    const defaultBinding = statement.importClause?.name;
    const specifier = statement.moduleSpecifier.text;
    if (!defaultBinding || !isCssModuleSpecifier(specifier)) {
      continue;
    }

    const stylesheet = resolveStylesheet(filePath, specifier, options);
    if (stylesheet) {
      imports.set(defaultBinding.text, { binding: defaultBinding, stylesheet: stylesheet.path });
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      typescript.isPropertyAccessExpression(node) &&
      typescript.isIdentifier(node.expression)
    ) {
      const imported = imports.get(node.expression.text);
      if (imported) {
        usageFor(usages, imported.stylesheet).classes.add(node.name.text);
      }
    } else if (
      typescript.isElementAccessExpression(node) &&
      typescript.isIdentifier(node.expression)
    ) {
      const imported = imports.get(node.expression.text);
      if (imported) {
        const className = staticElementName(typescript, node);
        const usage = usageFor(usages, imported.stylesheet);
        if (className) {
          usage.classes.add(className);
        } else {
          usage.all = true;
        }
      }
    } else if (typescript.isIdentifier(node)) {
      const imported = imports.get(node.text);
      if (imported && node !== imported.binding) {
        const parent = node.parent;
        const isPropertyObject = typescript.isPropertyAccessExpression(parent) &&
          parent.expression === node;
        const isElementObject = typescript.isElementAccessExpression(parent) &&
          parent.expression === node;
        if (!isPropertyObject && !isElementObject) {
          usageFor(usages, imported.stylesheet).all = true;
        }
      }
    }

    typescript.forEachChild(node, visit);
  };

  visit(source);
  return true;
}

export function findUnusedClasses(input: UnusedCheckOptions): UnusedClassesResult {
  // Every class looks unused when no source file can be read, so a missing parser has to fail the
  // whole scan rather than degrade it into a wall of false positives.
  const typescript = loadTypeScript();
  if (!typescript) {
    return {
      incomplete: true,
      unused: [],
      reason: 'Install the optional peer dependency "typescript" to scan source files.',
    };
  }

  const rootDir = realpathSync(input.rootDir);
  const { rootDir: _rootDir, paths, ...ruleOptions } = input;
  const options = normalizeOptions(ruleOptions, rootDir);
  const collection = collectFiles(rootDir, paths);
  const { files } = collection;
  const stylesheets = files.filter(isCssModuleSpecifier);
  const usages = new Map<string, Usage>();
  let scanWasIncomplete = collection.incomplete;

  for (const filePath of files) {
    if (isSourceFile(filePath) && !scanSourceFile(typescript, filePath, options, usages)) {
      scanWasIncomplete = true;
    }
  }

  if (scanWasIncomplete) {
    return { incomplete: true, unused: [] };
  }

  const unused: UnusedClass[] = [];
  for (const stylesheet of stylesheets) {
    const extracted = extractClasses(stylesheet, options);
    if (!extracted) {
      return { incomplete: true, unused: [] };
    }

    const usage = usages.get(stylesheet);
    if (usage?.all) {
      continue;
    }
    if (extracted.hasExtend) {
      return { incomplete: true, unused: [] };
    }

    const usedClasses = usedLocalClasses(extracted, usage?.classes ?? new Set(), options.localsConvention);
    for (const className of extracted.localClasses) {
      if (!usedClasses.has(className)) {
        unused.push({ stylesheet, className });
      }
    }
  }

  return {
    incomplete: false,
    unused: unused.sort((left, right) =>
      left.stylesheet.localeCompare(right.stylesheet) || left.className.localeCompare(right.className),
    ),
  };
}

export function relativeUnusedClasses(rootDir: string, unused: readonly UnusedClass[]): UnusedClass[] {
  return unused.map((entry) => ({
    ...entry,
    stylesheet: relative(rootDir, entry.stylesheet),
  }));
}
