import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { extractClasses } from './extractor.js';
import { normalizeOptions } from './options.js';
import { isCssModuleSpecifier, isInside, resolveStylesheet } from './resolver.js';
import type { CssModulesOptions, ExtractorOptions } from './types.js';

export interface UnusedCheckOptions extends CssModulesOptions {
  rootDir: string;
  paths?: string[];
}

export interface UnusedClass {
  stylesheet: string;
  className: string;
}

interface Usage {
  all: boolean;
  classes: Set<string>;
}

interface ImportedBinding {
  binding: ts.Identifier;
  stylesheet: string;
}

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const IGNORED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isCssModuleFile(filePath: string): boolean {
  return /\.module\.(?:css|scss|sass)$/i.test(filePath);
}

function isInsideOrEqual(rootDir: string, candidate: string): boolean {
  return candidate === rootDir || isInside(rootDir, candidate);
}

function collectFiles(
  rootDir: string,
  requestedPaths: readonly string[] | undefined,
): string[] {
  const files: string[] = [];
  const startPaths = requestedPaths?.length ? requestedPaths : [rootDir];

  const visit = (candidate: string): void => {
    let realPath: string;
    try {
      realPath = realpathSync(candidate);
    } catch {
      return;
    }

    if (!isInsideOrEqual(rootDir, realPath)) {
      return;
    }

    const entries = readdirSync(realPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) {
        continue;
      }

      const entryPath = join(realPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && (isSourceFile(entryPath) || isCssModuleFile(entryPath))) {
        files.push(entryPath);
      }
    }
  };

  for (const requestedPath of startPaths) {
    const candidate = isAbsolute(requestedPath)
      ? requestedPath
      : resolve(rootDir, requestedPath);
    try {
      if (isCssModuleFile(candidate) || isSourceFile(candidate)) {
        const realPath = realpathSync(candidate);
        if (isInsideOrEqual(rootDir, realPath)) {
          files.push(realPath);
        }
      } else {
        visit(candidate);
      }
    } catch {
      // A missing path does not make a lint run unsafe or crash the CLI.
    }
  }

  return [...new Set(files)].sort();
}

function scriptKind(filePath: string): ts.ScriptKind {
  switch (extname(filePath).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
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

function staticElementName(node: ts.ElementAccessExpression): string | undefined {
  const argument = node.argumentExpression;
  return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function scanSourceFile(
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

  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    return false;
  }

  const imports = new Map<string, ImportedBinding>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
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
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const imported = imports.get(node.expression.text);
      if (imported) {
        usageFor(usages, imported.stylesheet).classes.add(node.name.text);
      }
    } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const imported = imports.get(node.expression.text);
      if (imported) {
        const className = staticElementName(node);
        const usage = usageFor(usages, imported.stylesheet);
        if (className) {
          usage.classes.add(className);
        } else {
          usage.all = true;
        }
      }
    } else if (ts.isIdentifier(node)) {
      const imported = imports.get(node.text);
      if (imported && node !== imported.binding) {
        const parent = node.parent;
        const isPropertyObject = ts.isPropertyAccessExpression(parent) && parent.expression === node;
        const isElementObject = ts.isElementAccessExpression(parent) && parent.expression === node;
        if (!isPropertyObject && !isElementObject) {
          usageFor(usages, imported.stylesheet).all = true;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return true;
}

export function findUnusedClasses(input: UnusedCheckOptions): UnusedClass[] {
  const rootDir = realpathSync(input.rootDir);
  const { rootDir: _rootDir, paths, ...ruleOptions } = input;
  const options = normalizeOptions(ruleOptions, rootDir);
  const files = collectFiles(rootDir, paths);
  const stylesheets = files.filter(isCssModuleFile);
  const usages = new Map<string, Usage>();
  let scanWasIncomplete = false;

  for (const filePath of files) {
    if (isSourceFile(filePath) && !scanSourceFile(filePath, options, usages)) {
      scanWasIncomplete = true;
    }
  }

  if (scanWasIncomplete) {
    return [];
  }

  const unused: UnusedClass[] = [];
  for (const stylesheet of stylesheets) {
    const extracted = extractClasses(stylesheet, options);
    if (!extracted) {
      continue;
    }

    const usage = usages.get(stylesheet);
    if (usage?.all) {
      continue;
    }

    for (const className of extracted.localClasses) {
      if (!usage?.classes.has(className)) {
        unused.push({ stylesheet, className });
      }
    }
  }

  return unused.sort((left, right) =>
    left.stylesheet.localeCompare(right.stylesheet) || left.className.localeCompare(right.className),
  );
}

export function relativeUnusedClasses(rootDir: string, unused: readonly UnusedClass[]): UnusedClass[] {
  return unused.map((entry) => ({
    ...entry,
    stylesheet: relative(rootDir, entry.stylesheet),
  }));
}
