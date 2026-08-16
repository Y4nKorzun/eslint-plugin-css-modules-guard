import { readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type ts from 'typescript';

import { extractClasses, usedLocalClasses } from './extractor.js';
import { normalizeOptions } from './options.js';
import { isCssModuleSpecifier, isInsideOrEqual, resolveStylesheet } from './resolver.js';
import { typescriptExpressionCandidates } from './typescript-candidates.js';
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
  classes: Set<string>;
}

interface ImportedBinding {
  binding: ts.Identifier;
  stylesheet: string;
}

type SourceScanResult = { complete: true } | { complete: false; reason: string };

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

function usageFor(usages: Map<string, Usage>, stylesheet: string): Usage {
  const existing = usages.get(stylesheet);
  if (existing) {
    return existing;
  }

  const created = { classes: new Set<string>() };
  usages.set(stylesheet, created);
  return created;
}

function indeterminateReason(
  source: ts.SourceFile,
  node: ts.Node,
  rootDir: string,
): string {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `Cannot determine CSS Module class access in "${relative(rootDir, source.fileName)}:${line + 1}:${character + 1}".`;
}

function bindingElementCandidates(
  typescript: TypeScriptModule,
  checker: ts.TypeChecker,
  element: ts.BindingElement,
): ReadonlySet<string> | undefined {
  if (element.dotDotDotToken || !typescript.isIdentifier(element.name)) {
    return undefined;
  }

  const property = element.propertyName ?? element.name;
  if (typescript.isIdentifier(property) || typescript.isStringLiteral(property)) {
    return new Set([property.text]);
  }
  return typescript.isComputedPropertyName(property)
    ? typescriptExpressionCandidates(typescript, checker, property.expression)
    : undefined;
}

function scanSourceFile(
  typescript: TypeScriptModule,
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  options: ExtractorOptions,
  usages: Map<string, Usage>,
): SourceScanResult {
  const imports = new Map<ts.Symbol, ImportedBinding>();
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

    const stylesheet = resolveStylesheet(source.fileName, specifier, options);
    if (!stylesheet) {
      return {
        complete: false,
        reason: `Unable to resolve CSS Module "${specifier}" imported by "${relative(options.rootDir, source.fileName)}".`,
      };
    }
    const symbol = checker.getSymbolAtLocation(defaultBinding)!;
    imports.set(symbol, { binding: defaultBinding, stylesheet: stylesheet.path });
  }

  const importedFor = (node: ts.Identifier): ImportedBinding | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol ? imports.get(symbol) : undefined;
  };

  let reason: string | undefined;
  const visit = (node: ts.Node): void => {
    if (reason) {
      return;
    }

    if (
      typescript.isVariableDeclaration(node) &&
      node.initializer &&
      typescript.isIdentifier(node.initializer) &&
      typescript.isObjectBindingPattern(node.name)
    ) {
      const imported = importedFor(node.initializer);
      if (imported) {
        const usage = usageFor(usages, imported.stylesheet);
        for (const element of node.name.elements) {
          const candidates = bindingElementCandidates(typescript, checker, element);
          if (!candidates) {
            reason = indeterminateReason(source, node, options.rootDir);
            break;
          }
          for (const className of candidates) {
            usage.classes.add(className);
          }
        }
      }
    } else if (
      typescript.isPropertyAccessExpression(node) &&
      typescript.isIdentifier(node.expression)
    ) {
      const imported = importedFor(node.expression);
      if (imported) {
        usageFor(usages, imported.stylesheet).classes.add(node.name.text);
      }
    } else if (
      typescript.isElementAccessExpression(node) &&
      typescript.isIdentifier(node.expression)
    ) {
      const imported = importedFor(node.expression);
      if (imported) {
        const candidates = typescriptExpressionCandidates(
          typescript,
          checker,
          node.argumentExpression!,
        );
        if (!candidates) {
          reason = indeterminateReason(source, node, options.rootDir);
        } else {
          const usage = usageFor(usages, imported.stylesheet);
          for (const className of candidates) {
            usage.classes.add(className);
          }
        }
      }
    } else if (typescript.isIdentifier(node)) {
      const imported = importedFor(node);
      if (imported && node !== imported.binding) {
        const parent = node.parent;
        const isPropertyObject = typescript.isPropertyAccessExpression(parent) &&
          parent.expression === node;
        const isElementObject = typescript.isElementAccessExpression(parent) &&
          parent.expression === node;
        const isDestructuringSource = typescript.isVariableDeclaration(parent) &&
          parent.initializer === node &&
          typescript.isObjectBindingPattern(parent.name);
        if (!isPropertyObject && !isElementObject && !isDestructuringSource) {
          reason = indeterminateReason(source, node, options.rootDir);
        }
      }
    }

    typescript.forEachChild(node, visit);
  };

  visit(source);
  return reason ? { complete: false, reason } : { complete: true };
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
  const sourceFiles = files.filter(isSourceFile);
  const usages = new Map<string, Usage>();
  if (collection.incomplete) {
    return { incomplete: true, unused: [] };
  }

  const program = typescript.createProgram({
    rootNames: sourceFiles,
    options: {
      allowJs: true,
      checkJs: false,
      jsx: typescript.JsxEmit.Preserve,
      noEmit: true,
      noLib: true,
      noResolve: true,
      skipLibCheck: true,
      target: typescript.ScriptTarget.Latest,
    },
  });

  const checker = program.getTypeChecker();
  for (const filePath of sourceFiles) {
    const source = program.getSourceFile(filePath);
    if (!source || program.getSyntacticDiagnostics(source).length > 0) {
      return { incomplete: true, unused: [] };
    }
    const result = scanSourceFile(typescript, checker, source, options, usages);
    if (!result.complete) {
      return { incomplete: true, unused: [], reason: result.reason };
    }
  }

  const unused: UnusedClass[] = [];
  for (const stylesheet of stylesheets) {
    const extracted = extractClasses(stylesheet, options);
    if (!extracted) {
      return { incomplete: true, unused: [] };
    }

    const usage = usages.get(stylesheet);
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
