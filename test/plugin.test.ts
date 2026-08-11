import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { mock } from 'node:test';

import { ESLint } from 'eslint';

import { runCli, runCliFromProcess } from '../src/cli.js';
import {
  clearExtractionCache,
  compileStylesheet,
  extractClasses,
  fingerprintDependencies,
  getExtractionCacheKeys,
  propertyNamesForClass,
  safeSassImporter,
} from '../src/core/extractor.js';
import { normalizeOptions } from '../src/core/options.js';
import {
  isCssModuleSpecifier,
  isInside,
  isSafeProjectFile,
  resolveStylesheet,
} from '../src/core/resolver.js';
import { findUnusedClasses, relativeUnusedClasses } from '../src/core/unused.js';
import plugin from '../src/index.js';
import { noUnknownClass } from '../src/rules/no-unknown-class.js';
import { unresolvableStylesheet } from '../src/rules/unresolvable-stylesheet.js';
import type { CssModulesOptions } from '../src/core/types.js';

type TestRule = 'no-unknown-class' | 'unresolvable-stylesheet';

const repositoryRoot = resolve(process.cwd());
const packageManifest = JSON.parse(
  readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
) as {
  author: { name: string; url: string };
  bin: Record<string, string>;
  bugs: { url: string };
  homepage: string;
  repository: { type: string; url: string };
  version: string;
};
const fixture = (...segments: string[]): string => join(repositoryRoot, 'test', 'fixtures', ...segments);

async function lint(
  code: string,
  filePath: string,
  options: CssModulesOptions = {},
  cwd = repositoryRoot,
  rule: TestRule = 'no-unknown-class',
): Promise<ESLint.LintResult['messages']> {
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*'],
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      plugins: {
        'css-modules': {
          rules: {
            'no-unknown-class': noUnknownClass,
            'unresolvable-stylesheet': unresolvableStylesheet,
          },
        },
      },
      rules: {
        [`css-modules/${rule}`]: ['error', options],
      },
    } as never,
  });
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages;
}

function filesUnder(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(next);
      } else {
        files.push(relative(directory, next));
      }
    }
  };
  visit(directory);
  return files.sort();
}

function withTemporaryProject<T>(run: (rootDir: string) => T): T {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    return run(rootDir);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function writeProjectFile(rootDir: string, fileName: string, contents: string): string {
  const filePath = join(rootDir, fileName);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  return filePath;
}

test('recommended config exposes the plugin rule', () => {
  assert.equal(plugin.meta.name, 'eslint-plugin-css-modules-guard');
  assert.equal(plugin.meta.version, packageManifest.version);
  assert.equal(plugin.configs.recommended.plugins['css-modules'], plugin);
  assert.equal(plugin.configs.recommended.rules['css-modules/no-unknown-class'], 'error');
  assert.equal(plugin.configs.recommended.rules['css-modules/unresolvable-stylesheet'], 'error');
});

test('published CLI metadata uses an npm-valid bin path', () => {
  assert.equal(packageManifest.bin['css-modules-lint'], 'dist/src/cli.js');
});

test('published package links point to the source repository', () => {
  assert.deepEqual(packageManifest.author, {
    name: 'Y4nKorzun',
    url: 'https://github.com/Y4nKorzun',
  });
  assert.deepEqual(packageManifest.repository, {
    type: 'git',
    url: 'git+https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard.git',
  });
  assert.equal(packageManifest.bugs.url, 'https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/issues');
  assert.equal(packageManifest.homepage, 'https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard#readme');
  assert.equal(
    noUnknownClass.meta.docs?.url,
    'https://www.npmjs.com/package/eslint-plugin-css-modules-guard#rule-css-modulesno-unknown-class',
  );
  assert.equal(
    unresolvableStylesheet.meta.docs?.url,
    'https://www.npmjs.com/package/eslint-plugin-css-modules-guard#rule-css-modulesunresolvable-stylesheet',
  );
});

test('reports static unknown properties with a correction', async () => {
  const messages = await lint(
    "import buttonStyles from './basic.module.css';\nbuttonStyles.primray;\nbuttonStyles['root'];",
    fixture('Component.js'),
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0]!.message, /Unknown CSS Module class "primray"/);
  assert.match(messages[0]!.message, /buttonStyles\.primary/);
  assert.equal(messages[0]!.suggestions?.length, 1);
  assert.equal(messages[0]!.suggestions?.[0]?.desc, 'Replace with "buttonStyles.primary".');
  assert.equal(messages[0]!.suggestions?.[0]?.fix.text, 'buttonStyles.primary');
});

test('skips dynamic access and shadowed bindings', async () => {
  const messages = await lint(
    "import styles from './basic.module.css';\nconst size = 'sm';\nstyles[`size_${size}`];\nfunction render(styles) { styles.missing; }",
    fixture('Component.js'),
  );

  assert.equal(messages.length, 0);
});

test('does not reject explicitly global selectors', async () => {
  const messages = await lint(
    "import styles from './basic.module.css';\nstyles.external;\nstyles['global-only'];",
    fixture('Component.js'),
  );

  assert.equal(messages.length, 0);
});

test('honors css-loader locals conventions', async () => {
  const messages = await lint(
    "import styles from './basic.module.css';\nstyles.kebabCase;\nstyles['kebab-case'];",
    fixture('Component.js'),
    { localsConvention: 'camelCaseOnly' },
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0]!.message, /kebab-case/);
});

test('compiles Sass before collecting selectors', () => {
  const options = normalizeOptions(undefined, repositoryRoot);
  const extracted = extractClasses(fixture('sass', 'features.module.scss'), options);

  assert.ok(extracted);
  assert.deepEqual(
    new Set(['root', 'root--active', 'child', 'child--deep', 'size_sm', 'space-compact']),
    extracted.classes,
  );
});

test('uses configured local Sass load paths', () => {
  const extracted = extractClasses(
    fixture('sass', 'load-path.module.scss'),
    normalizeOptions({ sassLoadPaths: ['test/fixtures/sass/load-paths'] }, repositoryRoot),
  );

  assert.ok(extracted?.classes.has('tone'));
});

test('uses referenced tsconfig aliases for nested Sass imports', async () => {
  const rootDir = fixture('sass-alias');
  const stylesheet = fixture('sass-alias', 'src', 'components', 'Aliased.module.scss');
  const extracted = extractClasses(stylesheet, normalizeOptions(undefined, rootDir));

  assert.ok(extracted?.classes.has('alias'));

  const messages = await lint([
    "import styles from './Aliased.module.scss';",
    'styles.alias;',
    'styles.alsi;',
  ].join('\n'), fixture('sass-alias', 'src', 'components', 'View.js'), {}, rootDir);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.ruleId, 'css-modules/no-unknown-class');
  assert.match(messages[0]!.message, /Unknown CSS Module class "alsi"/);
});

test('validates Sass and CSS Module semantics without false positives', async () => {
  const messages = await lint([
    "import sassStyles from './semantic.module.scss';",
    "import composedStyles from './composition.module.css';",
    "import flatStyles from './flat.module.css';",
    'const size = readSize();',
    'const key = readKey();',
    'sassStyles.button;',
    'sassStyles.buttonActive;',
    'sassStyles.icon;',
    'sassStyles.base;',
    'sassStyles.notice;',
    'sassStyles.sizeSm;',
    'sassStyles.sizeLg;',
    'composedStyles.localBase;',
    'composedStyles.localComposed;',
    'composedStyles.fromFile;',
    'composedStyles.vendor;',
    'composedStyles.externallyOwned;',
    'composedStyles.kebabCase;',
    'flatStyles.flatClass;',
    "sassStyles[`size_${size}`];",
    'flatStyles[key];',
    'sassStyles.buttno;',
  ].join('\n'), fixture('semantics', 'View.js'), {
    localsConvention: 'camelCase',
    cacheLimit: 2,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.ruleId, 'css-modules/no-unknown-class');
  assert.match(messages[0]!.message, /Unknown CSS Module class "buttno"/);
});

test('uses manual aliases for Sass without a tsconfig', async () => {
  const rootDir = fixture('manual-alias');
  const options = { aliases: { '~styles': 'src/styles' } };
  const messages = await lint([
    "import styles from './Aliased.module.scss';",
    'styles.manual;',
    'styles.maual;',
  ].join('\n'), fixture('manual-alias', 'src', 'View.js'), options, rootDir);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.ruleId, 'css-modules/no-unknown-class');
  assert.match(messages[0]!.message, /Unknown CSS Module class "maual"/);

  const unresolvableMessages = await lint(
    "import styles from './Aliased.module.scss';\nstyles.manual;",
    fixture('manual-alias', 'src', 'View.js'),
    options,
    rootDir,
    'unresolvable-stylesheet',
  );
  assert.deepEqual(unresolvableMessages, []);
});

test('recognizes ICSS exports without treating imports as module properties', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    const source = writeProjectFile(rootDir, 'View.js', 'export {};');
    const stylesheet = writeProjectFile(rootDir, 'vars.module.scss', [
      '$brand: #0070f3;',
      '$bp-md: 768px;',
      ':export {',
      '  brandColor: $brand;',
      '  brand-color: $brand;',
      '  accent-color: $brand;',
      '  breakpointMd: $bp-md;',
      '}',
      '.root { color: red; }',
    ].join('\n'));
    const options = normalizeOptions(undefined, rootDir);
    const extracted = extractClasses(stylesheet, options);

    assert.deepEqual(extracted?.localClasses, new Set(['root']));
    assert.equal(extracted?.classes.has('brandColor'), true);
    assert.equal(extracted?.classes.has('brand-color'), true);
    assert.equal(extracted?.classes.has('breakpointMd'), true);

    const messages = await lint([
      "import styles from './vars.module.scss';",
      'styles.brandColor;',
      'styles.breakpointMd;',
      'styles.missing;',
    ].join('\n'), source, {}, rootDir);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.message, /Unknown CSS Module class "missing"/);

    const camelCaseMessages = await lint([
      "import styles from './vars.module.scss';",
      'styles.accentColor;',
    ].join('\n'), source, { localsConvention: 'camelCaseOnly' }, rootDir);
    assert.deepEqual(camelCaseMessages, []);

    writeProjectFile(rootDir, 'imports.module.css', [
      ':import("./tokens.css") {',
      '  importedColor: importedColor;',
      '}',
      ':export {',
      '  exportedColor: red;',
      '}',
    ].join('\n'));
    const importedMessages = await lint([
      "import styles from './imports.module.css';",
      'styles.exportedColor;',
      'styles.importedColor;',
    ].join('\n'), source, {}, rootDir);
    assert.equal(importedMessages.length, 1);
    assert.match(importedMessages[0]!.message, /Unknown CSS Module class "importedColor"/);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('skips an unresolvable Sass interpolation instead of reporting a false positive', async () => {
  const messages = await lint(
    "import styles from './sass/dynamic.module.scss';\nstyles.anything;",
    fixture('Component.js'),
  );

  assert.equal(messages.length, 0);
});

test('reports unresolved and uncompilable CSS Modules separately', async () => {
  const messages = await lint([
    "import styles from './basic.module.css';",
    "import missing from './missing.module.scss';",
    "import broken from './sass/dynamic.module.scss';",
    "import ordinary from './ordinary.js';",
    "import * as namespace from './basic.module.css';",
    "import { root } from './basic.module.css';",
    "import './basic.module.css';",
    'styles.root;',
  ].join('\n'), fixture('Component.js'), { cacheLimit: 2 }, repositoryRoot, 'unresolvable-stylesheet');

  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.ruleId, 'css-modules/unresolvable-stylesheet');
  assert.match(messages[0]!.message, /Unable to resolve CSS Module "\.\/missing\.module\.scss"/);
  assert.match(messages[1]!.message, /Unable to compile CSS Module "\.\/sass\/dynamic\.module\.scss"/);
});

test('resolves tsconfig path aliases and composition dependencies', async () => {
  const aliasMessages = await lint(
    "import styles from '@styles/buttons/primary.module.scss';\nstyles.button;\nstyles.missing;",
    fixture('alias', 'src', 'components', 'View.js'),
  );
  const composed = extractClasses(
    fixture('composition', 'composed.module.css'),
    normalizeOptions(undefined, repositoryRoot),
  );

  assert.equal(aliasMessages.length, 1);
  assert.ok(composed);
  assert.deepEqual(
    new Set(['local-base', 'local', 'global-local', 'nested', 'base', 'vendor']),
    composed.classes,
  );
});

test('does not write fixture files while linting', async () => {
  const before = filesUnder(fixture());

  await lint(
    "import styles from './basic.module.css';\nstyles.root;",
    fixture('Component.js'),
  );

  assert.deepEqual(filesUnder(fixture()), before);
});

test('rejects stylesheet traversal outside the configured project root', () => {
  const rootDir = fixture('security', 'project');
  const options = normalizeOptions(undefined, rootDir);

  assert.equal(
    resolveStylesheet(fixture('security', 'project', 'src', 'View.js'), '../../outside.module.css', options),
    undefined,
  );
  assert.equal(
    extractClasses(fixture('security', 'project', 'src', 'escape.module.scss'), options),
    undefined,
  );
});

test('invalidates the in-memory cache when the stylesheet content changes', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const stylesheet = join(temporaryRoot, 'test.module.css');

  try {
    clearExtractionCache();
    writeFileSync(stylesheet, '.first {}');
    const options = normalizeOptions(undefined, temporaryRoot);
    assert.ok(extractClasses(stylesheet, options)?.classes.has('first'));

    writeFileSync(stylesheet, '.second {}');
    const extracted = extractClasses(stylesheet, options);
    assert.ok(extracted?.classes.has('second'));
    assert.equal(extracted?.classes.has('first'), false);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('invalidates the Sass cache when a tsconfig alias changes', () => {
  withTemporaryProject((rootDir) => {
    clearExtractionCache();
    const stylesheet = writeProjectFile(rootDir, 'src/entry.module.scss', [
      "@use '@theme' as theme;",
      '.entry-#{theme.$name} { color: red; }',
    ].join('\n'));
    writeProjectFile(rootDir, 'src/first/_theme.scss', '$name: first;');
    writeProjectFile(rootDir, 'src/second/_theme.scss', '$name: second;');
    writeProjectFile(rootDir, 'tsconfig.json', JSON.stringify({
      references: [{ path: './config/tsconfig.app.json' }],
    }));
    writeProjectFile(rootDir, 'config/tsconfig.app.json', JSON.stringify({
      compilerOptions: { baseUrl: '..', paths: { '@theme': ['src/first/theme'] } },
    }));

    const options = normalizeOptions(undefined, rootDir);
    assert.equal(extractClasses(stylesheet, options)?.classes.has('entry-first'), true);

    writeProjectFile(rootDir, 'config/tsconfig.app.json', JSON.stringify({
      compilerOptions: { baseUrl: '..', paths: { '@theme': ['src/second/theme'] } },
    }));
    const extracted = extractClasses(stylesheet, options);
    assert.equal(extracted?.classes.has('entry-first'), false);
    assert.equal(extracted?.classes.has('entry-second'), true);
  });
});

test('isolates Sass cache entries by explicit aliases', () => {
  withTemporaryProject((rootDir) => {
    clearExtractionCache();
    const stylesheet = writeProjectFile(rootDir, 'src/entry.module.scss', [
      "@use '@theme' as theme;",
      '.entry-#{theme.$name} { color: red; }',
    ].join('\n'));
    writeProjectFile(rootDir, 'src/first/_theme.scss', '$name: first;');
    writeProjectFile(rootDir, 'src/second/_theme.scss', '$name: second;');

    const first = normalizeOptions({
      aliases: { '@unused': 'src/unused', '@theme': 'src/first/theme' },
    }, rootDir);
    const second = normalizeOptions({
      aliases: { '@unused': 'src/unused', '@theme': 'src/second/theme' },
    }, rootDir);

    assert.equal(extractClasses(stylesheet, first)?.classes.has('entry-first'), true);
    assert.equal(extractClasses(stylesheet, second)?.classes.has('entry-first'), false);
    assert.equal(extractClasses(stylesheet, second)?.classes.has('entry-second'), true);
  });
});

test('keeps equal-priority Sass alias order in the cache key', () => {
  withTemporaryProject((rootDir) => {
    clearExtractionCache();
    const stylesheet = writeProjectFile(rootDir, 'src/entry.module.scss', [
      "@use '@a/x' as theme;",
      '.entry-#{theme.$name} { color: red; }',
    ].join('\n'));
    writeProjectFile(rootDir, 'src/one/_x.scss', '$name: first;');
    writeProjectFile(rootDir, 'src/two/_a.scss', '$name: second;');

    const first = normalizeOptions({
      aliases: { '@a/*': 'src/one/*', '@*/x': 'src/two/*' },
    }, rootDir);
    const second = normalizeOptions({
      aliases: { '@*/x': 'src/two/*', '@a/*': 'src/one/*' },
    }, rootDir);

    assert.equal(extractClasses(stylesheet, first)?.classes.has('entry-first'), true);
    assert.equal(extractClasses(stylesheet, second)?.classes.has('entry-first'), false);
    assert.equal(extractClasses(stylesheet, second)?.classes.has('entry-second'), true);
  });
});

test('finds unused local classes and preserves dynamic module access', () => {
  const rootDir = fixture('unused');
  const result = findUnusedClasses({ rootDir });

  assert.equal(result.incomplete, false);
  assert.deepEqual(relativeUnusedClasses(rootDir, result.unused), [
    { stylesheet: 'orphan.module.scss', className: 'orphan' },
    { stylesheet: 'used.module.css', className: 'unused' },
  ]);
});

test('CLI emits CI-friendly JSON and exits nonzero for unused classes', () => {
  const output: string[] = [];
  const exitCode = runCli(
    ['check-unused', '--root', fixture('unused'), '--format', 'json'],
    (line) => output.push(line),
  );

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(output.join('\n')), {
    unused: [
      { stylesheet: 'orphan.module.scss', className: 'orphan' },
      { stylesheet: 'used.module.css', className: 'unused' },
    ],
  });
});

test('resolves only safe local and configured stylesheet paths', () => {
  withTemporaryProject((rootDir) => {
    const importer = writeProjectFile(rootDir, 'src/View.ts', 'export {};');
    const local = writeProjectFile(rootDir, 'src/local.module.css', '.local {}');
    const aliased = writeProjectFile(rootDir, 'styles/aliased.module.css', '.aliased {}');
    const exact = writeProjectFile(rootDir, 'styles/exact.module.css', '.exact {}');
    const directory = join(rootDir, 'styles');
    const ignored = writeProjectFile(rootDir, 'node_modules/ignored.module.css', '.ignored {}');
    const outsideDir = mkdtempSync(join(tmpdir(), 'css-modules-real-outside-'));
    const outside = writeProjectFile(outsideDir, 'outside.module.css', '.outside {}');

    try {
      const options = normalizeOptions({
        aliases: {
          '@exact.module.css': 'styles/exact.module.css',
          '@styles': 'styles',
          '@wild/*': 'styles/*',
        },
      }, rootDir);

      assert.equal(isCssModuleSpecifier('./local.module.css'), true);
      assert.equal(isCssModuleSpecifier('./plain.css'), false);
      assert.equal(isInside(rootDir, local), true);
      assert.equal(isInside(rootDir, rootDir), false);
      assert.equal(isInside(rootDir, outside), false);
      assert.equal(isSafeProjectFile(local, rootDir), local);
      assert.equal(isSafeProjectFile(directory, rootDir), undefined);
      assert.equal(isSafeProjectFile(ignored, rootDir), undefined);
      assert.equal(isSafeProjectFile(outside, rootDir), undefined);
      assert.equal(isSafeProjectFile(join(rootDir, 'missing.module.css'), rootDir), undefined);

      assert.equal(resolveStylesheet(importer, './local.module.css', options)?.path, local);
      assert.equal(resolveStylesheet(importer, '@styles/aliased.module.css', options)?.path, aliased);
      assert.equal(resolveStylesheet(importer, '@wild/aliased.module.css', options)?.path, aliased);
      assert.equal(resolveStylesheet(importer, '@exact.module.css', options)?.path, exact);
      assert.equal(resolveStylesheet(importer, '@missing.module.css', options), undefined);
      assert.equal(resolveStylesheet(importer, './local.css', options), undefined);
      assert.equal(resolveStylesheet(importer, './local.module.css?raw', options), undefined);
      assert.equal(resolveStylesheet(importer, './local.module.css#hash', options), undefined);
      assert.equal(resolveStylesheet(importer, `./local\0.module.css`, options), undefined);

      const virtualRoot = join(rootDir, 'virtual-root');
      assert.equal(normalizeOptions(undefined, virtualRoot).rootDir, virtualRoot);
    } finally {
      rmSync(outsideDir, { force: true, recursive: true });
    }
  });
});

test('reads local tsconfig aliases defensively', () => {
  withTemporaryProject((rootDir) => {
    const importer = writeProjectFile(rootDir, 'src/View.ts', 'export {};');
    const stylesheet = writeProjectFile(rootDir, 'styles/aliased.module.css', '.aliased {}');
    writeProjectFile(rootDir, 'base.json', JSON.stringify({
      extends: './tsconfig',
      compilerOptions: { baseUrl: '.', paths: [] },
    }));
    writeProjectFile(rootDir, 'tsconfig.json', JSON.stringify({
      extends: './base',
      compilerOptions: {
        paths: {
          '@invalid/*': 'styles/*',
          '@local/*': ['styles/*', 1],
        },
      },
    }));

    const options = normalizeOptions(undefined, rootDir);
    assert.equal(resolveStylesheet(importer, '@local/aliased.module.css', options)?.path, stylesheet);
    assert.equal(resolveStylesheet(importer, '@invalid/aliased.module.css', options), undefined);

    writeProjectFile(rootDir, 'tsconfig.json', JSON.stringify({
      extends: 'external-package',
      compilerOptions: { paths: { '@local/*': ['styles/*'] } },
    }));
    assert.equal(resolveStylesheet(importer, '@local/aliased.module.css', options)?.path, stylesheet);

    const configPath = join(rootDir, 'tsconfig.json');
    chmodSync(configPath, 0);
    try {
      assert.equal(resolveStylesheet(importer, '@local/aliased.module.css', options), undefined);
    } finally {
      chmodSync(configPath, 0o644);
    }
  });
});

test('resolves relative stylesheets and aliases from local project references', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  const outsideDir = mkdtempSync(join(tmpdir(), 'css-modules-real-outside-'));

  try {
    const importer = writeProjectFile(rootDir, 'src/View.js', 'export {};');
    const relativeStylesheet = writeProjectFile(rootDir, 'src/relative.module.css', '.relative {}');
    const aliasedStylesheet = writeProjectFile(rootDir, 'src/aliased.module.css', '.aliased {}');
    const outsideConfig = writeProjectFile(outsideDir, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@outside/*': ['*'] } },
    }));
    writeProjectFile(rootDir, 'config/tsconfig.app.json', JSON.stringify({
      compilerOptions: { baseUrl: '..', paths: { '@/*': ['src/*'] } },
    }));
    writeProjectFile(rootDir, 'config-directory/tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '..', paths: { '@directory/*': ['src/*'] } },
    }));
    writeProjectFile(rootDir, 'config/invalid.json', '{');
    writeProjectFile(rootDir, 'tsconfig.json', JSON.stringify({
      references: [
        { path: './config/tsconfig.app.json' },
        { path: './config-directory' },
        { path: './config/invalid.json' },
        { path: './tsconfig.json' },
        { path: outsideConfig },
        { path: 'external-package' },
        null,
        [],
        'not-an-object',
      ],
    }));

    const options = normalizeOptions(undefined, rootDir);
    assert.equal(resolveStylesheet(importer, './relative.module.css', options)?.path, relativeStylesheet);
    assert.equal(resolveStylesheet(importer, '@/aliased.module.css', options)?.path, aliasedStylesheet);
    assert.equal(resolveStylesheet(importer, '@directory/aliased.module.css', options)?.path, aliasedStylesheet);
    assert.equal(resolveStylesheet(importer, '@outside/tsconfig.json', options), undefined);

    const messages = await lint([
      "import relativeStyles from './relative.module.css';",
      "import aliasStyles from '@/aliased.module.css';",
      'relativeStyles.missing;',
      'aliasStyles.missing;',
    ].join('\n'), importer, {}, rootDir);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((message) => message.messageId), ['unknownClass', 'unknownClass']);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }
});

test('stops tsconfig discovery at the filesystem root', () => {
  const options = normalizeOptions(undefined, '/');
  assert.equal(resolveStylesheet('/css-modules-real/Component.ts', '@missing.module.css', options), undefined);
});

test('extracts compositions and Sass variants without escaping the project', () => {
  withTemporaryProject((rootDir) => {
    clearExtractionCache();
    const options = normalizeOptions({ cache: false }, rootDir);
    const composed = writeProjectFile(rootDir, 'composed.module.css', [
      '.base {}',
      '.with-global { composes: global(vendor-one vendor-two); }',
      '.with-global-from { composes: vendor-three from global; }',
      '.with-local { composes: base; }',
      '.double { composes: base base; }',
      '.empty { composes: ; }',
      '.missing-local { composes: unknown; }',
      '.missing-external { composes: unknown from "./missing.module.css"; }',
    ].join('\n'));
    const extracted = extractClasses(composed, options);

    assert.ok(extracted);
    assert.equal(extracted.classes.has('vendor-one'), true);
    assert.equal(extracted.classes.has('vendor-two'), true);
    assert.equal(extracted.classes.has('vendor-three'), true);
    assert.equal(extracted.classes.has('base'), true);
    assert.equal(extracted.classes.has('missing-local'), true);
    assert.deepEqual(propertyNamesForClass('kebab-case', 'asIs'), new Set(['kebab-case']));
    assert.deepEqual(propertyNamesForClass('kebab-case', 'camelCase'), new Set(['kebab-case', 'kebabCase']));
    assert.deepEqual(propertyNamesForClass('kebab-case', 'camelCaseOnly'), new Set(['kebabCase']));
    assert.deepEqual(propertyNamesForClass('kebab-case', 'dashes'), new Set(['kebab-case', 'kebabCase']));

    const localCycle = writeProjectFile(rootDir, 'local-cycle.module.css', [
      '.a { composes: b; }',
      '.b { composes: a; }',
    ].join('\n'));
    assert.deepEqual(extractClasses(localCycle, options)?.classes, new Set(['a', 'b']));

    const externalA = writeProjectFile(rootDir, 'external-a.module.css',
      '.a { composes: b from "./external-b.module.css"; }');
    writeProjectFile(rootDir, 'external-b.module.css',
      '.b { composes: a from "./external-a.module.css"; }');
    assert.deepEqual(extractClasses(externalA, options)?.classes, new Set(['a', 'b']));

    const indented = writeProjectFile(rootDir, 'indented.module.sass', '.indented\n  color: red\n');
    writeProjectFile(rootDir, 'explicit-target.scss', '$color: red;');
    const explicit = writeProjectFile(rootDir, 'explicit.module.scss', [
      "@use 'explicit-target.scss' as target;",
      '.explicit { color: target.$color; }',
    ].join('\n'));
    const builtin = writeProjectFile(rootDir, 'builtin.module.scss', [
      "@use 'sass:math';",
      '.builtin { width: math.div(2px, 1px); }',
    ].join('\n'));
    writeProjectFile(rootDir, 'part.css', '.from-css { color: red; }');
    const cssImport = writeProjectFile(rootDir, 'css-import.module.scss', [
      "@use 'part';",
      '.css-import {}',
    ].join('\n'));
    assert.equal(extractClasses(indented, options)?.classes.has('indented'), true);
    assert.equal(extractClasses(explicit, options)?.classes.has('explicit'), true);
    assert.equal(extractClasses(builtin, options)?.classes.has('builtin'), true);
    assert.equal(extractClasses(cssImport, options)?.classes.has('from-css'), true);

    const cacheEntry = writeProjectFile(rootDir, 'cache.module.scss', [
      "@use 'dependency';",
      '.cached { color: dependency.$color; }',
    ].join('\n'));
    const dependency = writeProjectFile(rootDir, '_dependency.scss', '$color: red;');
    const cachedOptions = normalizeOptions(undefined, rootDir);
    assert.equal(extractClasses(cacheEntry, cachedOptions)?.classes.has('cached'), true);
    unlinkSync(dependency);
    assert.equal(extractClasses(cacheEntry, cachedOptions), undefined);

    writeProjectFile(rootDir, 'not-a-directory', 'text');
    mkdirSync(join(rootDir, 'node_modules', 'sass-load-path'), { recursive: true });
    const guardedLoadPaths = normalizeOptions({
      sassLoadPaths: [rootDir, '.', 'missing', 'not-a-directory', 'node_modules/sass-load-path', '../outside'],
    }, rootDir);
    const plainSass = writeProjectFile(rootDir, 'plain.module.scss', '.plain { color: red; }');
    assert.equal(extractClasses(plainSass, guardedLoadPaths)?.classes.has('plain'), true);

    const missingSass = writeProjectFile(rootDir, 'missing.module.scss', "@use 'missing';");
    const externalSass = writeProjectFile(rootDir, 'external.module.scss', "@use 'pkg:outside';");
    const malformedSass = writeProjectFile(rootDir, 'malformed.module.scss', "@use 'css-modules-real:///%E0%A4%A';");
    const invalidCss = writeProjectFile(rootDir, 'invalid.module.css', '.broken[');
    assert.equal(extractClasses(missingSass, options), undefined);
    assert.equal(extractClasses(externalSass, options), undefined);
    assert.equal(extractClasses(malformedSass, options), undefined);
    assert.equal(extractClasses(invalidCss, options), undefined);
    assert.equal(extractClasses(join(rootDir, 'missing.module.css'), options), undefined);
  });
});

test('rejects unsafe Sass importer URLs before reading files', () => {
  withTemporaryProject((rootDir) => {
    const entry = writeProjectFile(rootDir, 'entry.module.scss', '.entry { color: red; }');
    const nested = writeProjectFile(rootDir, 'nested.scss', '$color: red;');
    const aliased = writeProjectFile(rootDir, 'src/_aliased.scss', '$color: green;');
    const configPath = writeProjectFile(rootDir, 'tsconfig.json', JSON.stringify({
      compilerOptions: {
        paths: {
          '@/*': ['src/*'],
          '@outside/*': ['../outside/*'],
          theme: ['src/aliased'],
        },
      },
    }));
    writeProjectFile(rootDir, 'child.scss', '$color: blue;');
    writeProjectFile(rootDir, 'theme.scss', '$color: blue;');
    const options = normalizeOptions(undefined, rootDir);
    const dependencies = new Set<string>();
    const importer = safeSassImporter(entry, options, dependencies) as unknown as {
      canonicalize(url: string, context: { containingUrl?: URL }): URL | null;
      load(url: URL): { contents: string; syntax: string };
    };
    const customUrl = (filePath: string) => new URL(
      `css-modules-real://${pathToFileURL(filePath).pathname}`,
    );

    assert.equal(importer.canonicalize('sass:math', {}), null);
    assert.ok(importer.canonicalize('nested', {}) instanceof URL);
    assert.ok(importer.canonicalize('@/aliased', {}) instanceof URL);
    assert.equal(importer.canonicalize('theme', {})?.href, customUrl(aliased).href);
    assert.ok(importer.canonicalize(customUrl(nested).href, {}) instanceof URL);
    assert.ok(importer.canonicalize('child', { containingUrl: customUrl(nested) }) instanceof URL);
    assert.ok(importer.canonicalize('./child', { containingUrl: customUrl(nested) }) instanceof URL);
    assert.ok(importer.canonicalize('child', { containingUrl: pathToFileURL(nested) }) instanceof URL);
    assert.equal(importer.load(customUrl(nested)).contents, '$color: red;');
    assert.equal(dependencies.has(nested), true);
    assert.equal(dependencies.has(aliased), true);
    assert.equal(dependencies.has(configPath), true);

    assert.throws(() => importer.canonicalize('pkg:outside', {}));
    assert.throws(() => importer.canonicalize('@/../../outside', {}));
    assert.throws(() => importer.canonicalize('@outside/secret', {}));
    assert.throws(() => importer.canonicalize(
      `css-modules-real://${pathToFileURL(join(rootDir, 'missing.scss')).pathname}`,
      {},
    ));
    assert.throws(() => importer.canonicalize(
      `css-modules-real://${pathToFileURL(join(dirname(rootDir), 'outside.scss')).pathname}`,
      {},
    ));
    assert.throws(() => importer.canonicalize(customUrl(rootDir).href, {}));
    assert.throws(() => importer.canonicalize('css-modules-real:///%E0%A4%A', {}));
    assert.throws(() => importer.canonicalize('child', {
      containingUrl: new URL('css-modules-real:///%E0%A4%A'),
    }));
    assert.throws(() => importer.load(pathToFileURL(entry)));
    assert.throws(() => importer.load(new URL('css-modules-real:///%E0%A4%A')));
  });
});

test('fingerprints only safe, still-present stylesheet dependencies', () => {
  withTemporaryProject((rootDir) => {
    const stylesheet = writeProjectFile(rootDir, 'safe.module.css', '.safe {}');
    const outsideDir = mkdtempSync(join(tmpdir(), 'css-modules-real-outside-'));
    const outside = writeProjectFile(outsideDir, 'outside.module.css', '.outside {}');

    try {
      assert.equal(fingerprintDependencies([stylesheet], rootDir)?.has(stylesheet), true);
      assert.equal(fingerprintDependencies([join(rootDir, 'missing.module.css')], rootDir), undefined);
      assert.equal(fingerprintDependencies([outside], rootDir), undefined);
      assert.equal(compileStylesheet(join(rootDir, 'missing.module.css'), normalizeOptions(undefined, rootDir)), undefined);
      const outsideSass = writeProjectFile(outsideDir, 'outside.module.scss', '.outside { color: red; }');
      assert.equal(compileStylesheet(outsideSass, normalizeOptions(undefined, rootDir)), undefined);
    } finally {
      rmSync(outsideDir, { force: true, recursive: true });
    }
  });
});

test('bounds the extraction cache by default and configured limit', () => {
  withTemporaryProject((rootDir) => {
    clearExtractionCache();
    const defaultOptions = normalizeOptions(undefined, rootDir);
    assert.equal(defaultOptions.cacheLimit, 256);

    for (let index = 0; index <= 256; index += 1) {
      const stylesheet = writeProjectFile(rootDir, `cache/${index}.module.css`, `.item-${index} {}`);
      assert.equal(extractClasses(stylesheet, defaultOptions)?.classes.has(`item-${index}`), true);
    }

    assert.equal(getExtractionCacheKeys().length, 256);

    const smallOptions = normalizeOptions({ cacheLimit: 2 }, rootDir);
    assert.equal(smallOptions.cacheLimit, 2);
    const cachedStylesheet = join(rootDir, 'cache/256.module.css');
    assert.equal(extractClasses(cachedStylesheet, smallOptions)?.classes.has('item-256'), true);
    assert.equal(getExtractionCacheKeys().length, 2);

    for (let index = 0; index < 3; index += 1) {
      const stylesheet = writeProjectFile(rootDir, `small-cache/${index}.module.css`, `.item-${index} {}`);
      assert.equal(extractClasses(stylesheet, smallOptions)?.classes.has(`item-${index}`), true);
    }

    assert.equal(getExtractionCacheKeys().length, 2);
    assert.equal(normalizeOptions({ cacheLimit: 0 }, rootDir).cacheLimit, 256);
    assert.equal(normalizeOptions({ cacheLimit: 1.5 }, rootDir).cacheLimit, 256);
  });
});

test('retains recently used stylesheets in the extraction cache', () => {
  withTemporaryProject((rootDir) => {
    clearExtractionCache();
    const options = normalizeOptions({ cacheLimit: 2 }, rootDir);
    const first = writeProjectFile(rootDir, 'first.module.css', '.first {}');
    const second = writeProjectFile(rootDir, 'second.module.css', '.second {}');
    const third = writeProjectFile(rootDir, 'third.module.css', '.third {}');

    assert.equal(extractClasses(first, options)?.classes.has('first'), true);
    assert.equal(extractClasses(second, options)?.classes.has('second'), true);
    assert.equal(extractClasses(first, options)?.classes.has('first'), true);
    assert.equal(extractClasses(third, options)?.classes.has('third'), true);

    const cacheKeys = getExtractionCacheKeys();
    assert.equal(cacheKeys.length, 2);
    assert.equal(cacheKeys.some((key) => key.startsWith(`${first}\0`)), true);
    assert.equal(cacheKeys.some((key) => key.startsWith(`${second}\0`)), false);
    assert.equal(cacheKeys.some((key) => key.startsWith(`${third}\0`)), true);
  });
});

test('refreshes invalidated stylesheets in the extraction cache', () => {
  withTemporaryProject((rootDir) => {
    clearExtractionCache();
    const options = normalizeOptions({ cacheLimit: 2 }, rootDir);
    const first = writeProjectFile(rootDir, 'first.module.css', '.first {}');
    const second = writeProjectFile(rootDir, 'second.module.css', '.second {}');
    const third = writeProjectFile(rootDir, 'third.module.css', '.third {}');

    assert.equal(extractClasses(first, options)?.classes.has('first'), true);
    assert.equal(extractClasses(second, options)?.classes.has('second'), true);
    writeProjectFile(rootDir, 'first.module.css', '.first-updated {}');
    assert.equal(extractClasses(first, options)?.classes.has('first-updated'), true);
    assert.equal(extractClasses(third, options)?.classes.has('third'), true);

    const cacheKeys = getExtractionCacheKeys();
    assert.equal(cacheKeys.length, 2);
    assert.equal(cacheKeys.some((key) => key.startsWith(`${first}\0`)), true);
    assert.equal(cacheKeys.some((key) => key.startsWith(`${second}\0`)), false);
    assert.equal(cacheKeys.some((key) => key.startsWith(`${third}\0`)), true);
  });
});

test('scans supported source files conservatively and ignores unsafe paths', () => {
  withTemporaryProject((rootDir) => {
    const extensionStyles = writeProjectFile(rootDir, 'extension.module.css', '.used {}');
    for (const extension of ['ts', 'tsx', 'jsx', 'js', 'mjs', 'cjs', 'mts', 'cts']) {
      writeProjectFile(
        rootDir,
        `sources/component.${extension}`,
        "import styles from '../extension.module.css';\nstyles.used;",
      );
    }

    const staticStyles = writeProjectFile(rootDir, 'static.module.css', '.used {}\n.unused {}');
    writeProjectFile(rootDir, 'static.ts', [
      "import styles from './static.module.css';",
      'styles.used;',
      'styles[`used`];',
    ].join('\n'));
    writeProjectFile(rootDir, 'dynamic.module.css', '.first {}\n.second {}');
    writeProjectFile(rootDir, 'dynamic.js', [
      "import styles from './dynamic.module.css';",
      'const key = readKey();',
      'styles[key];',
    ].join('\n'));
    writeProjectFile(rootDir, 'identifier.module.css', '.first {}\n.second {}');
    writeProjectFile(rootDir, 'identifier.mjs', [
      "import styles from './identifier.module.css';",
      'consume(styles);',
    ].join('\n'));
    writeProjectFile(rootDir, 'named.ts', "import { named } from './static.module.css';\nnamed;");
    writeProjectFile(rootDir, 'side-effect.ts', "import './static.module.css';");
    writeProjectFile(rootDir, 'node_modules/ignored.module.css', '.ignored {}');
    writeProjectFile(rootDir, 'dist/ignored.module.css', '.ignored {}');
    writeProjectFile(rootDir, 'coverage/ignored.module.css', '.ignored {}');
    writeProjectFile(rootDir, '.git/ignored.module.css', '.ignored {}');
    writeProjectFile(rootDir, 'invalid.module.css', '.broken[');
    const outsideDir = mkdtempSync(join(tmpdir(), 'css-modules-real-outside-'));
    const outside = writeProjectFile(outsideDir, 'outside.module.css', '.outside {}');
    symlinkSync(outside, join(rootDir, 'linked.module.css'));

    try {
      assert.deepEqual(findUnusedClasses({ rootDir }), { incomplete: true, unused: [] });
      const selected = findUnusedClasses({
        rootDir,
        paths: ['static.module.css'],
      });
      assert.equal(selected.incomplete, false);
      assert.deepEqual(relativeUnusedClasses(rootDir, selected.unused), [
        { stylesheet: 'static.module.css', className: 'unused' },
        { stylesheet: 'static.module.css', className: 'used' },
      ]);
      assert.deepEqual(findUnusedClasses({ rootDir, paths: ['static.ts'] }), { incomplete: false, unused: [] });
      assert.deepEqual(findUnusedClasses({ rootDir, paths: ['missing'] }), { incomplete: true, unused: [] });
      assert.deepEqual(findUnusedClasses({ rootDir, paths: ['missing.module.css'] }), { incomplete: true, unused: [] });
      assert.deepEqual(findUnusedClasses({ rootDir, paths: [outsideDir] }), { incomplete: true, unused: [] });
      assert.deepEqual(findUnusedClasses({ rootDir, paths: [outside] }), { incomplete: true, unused: [] });
      writeProjectFile(rootDir, 'not-a-directory', 'not a source file');
      assert.deepEqual(findUnusedClasses({ rootDir, paths: ['not-a-directory'] }), {
        incomplete: true,
        unused: [],
      });

      const unreadable = writeProjectFile(rootDir, 'unreadable.ts', 'export const value = 1;');
      chmodSync(unreadable, 0);
      try {
        assert.deepEqual(findUnusedClasses({ rootDir, paths: [unreadable, staticStyles] }), {
          incomplete: true,
          unused: [],
        });
      } finally {
        chmodSync(unreadable, 0o644);
      }

      writeProjectFile(rootDir, 'broken.ts', 'const = ;');
      assert.deepEqual(findUnusedClasses({ rootDir }), { incomplete: true, unused: [] });
      assert.equal(extensionStyles.startsWith(rootDir), true);
    } finally {
      rmSync(outsideDir, { force: true, recursive: true });
    }
  });
});

test('handles every static CSS Module access form and bounded suggestions', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    const source = writeProjectFile(rootDir, 'Component.js', 'export {};');
    writeProjectFile(rootDir, 'classes.module.css', '.root {}\n.primary {}\n.kebab-case {}');

    const ignored = await lint([
      "import styles from './classes.module.css';",
      "import * as namespace from './classes.module.css';",
      "import { root } from './classes.module.css';",
      "import './classes.module.css';",
      "import absent from './absent.module.css';",
      'const key = readKey();',
      'styles.root;',
      "styles['root'];",
      'styles[`root`];',
      'styles[0];',
      'styles[`${key}`];',
      '[styles].missing;',
      'namespace.missing;',
      'absent.missing;',
    ].join('\n'), source, {}, rootDir);
    assert.deepEqual(ignored, []);

    const hyphenSuggestion = await lint(
      "import styles from './classes.module.css';\nstyles['kebab-cas'];",
      source,
      {},
      rootDir,
    );
    assert.equal(hyphenSuggestion.length, 1);
    assert.match(hyphenSuggestion[0]!.message, /styles\["kebab-case"\]/);

    const noSuggestion = await lint(
      "import styles from './classes.module.css';\nstyles.missing;",
      source,
      { suggestThreshold: 0 },
      rootDir,
    );
    assert.equal(noSuggestion.length, 1);
    assert.doesNotMatch(noSuggestion[0]!.message, /Did you mean/);

    const longName = 'x'.repeat(257);
    const bounded = await lint(
      `import styles from './classes.module.css';\nstyles['${longName}'];`,
      source,
      {},
      rootDir,
    );
    assert.equal(bounded.length, 1);

    writeProjectFile(
      rootDir,
      'many.module.css',
      Array.from({ length: 5_001 }, (_, index) => `.item-${index} {}`).join('\n'),
    );
    const manyCandidates = await lint(
      "import styles from './many.module.css';\nstyles.missing;",
      source,
      { suggestThreshold: 10 },
      rootDir,
    );
    assert.equal(manyCandidates.length, 1);
    assert.doesNotMatch(manyCandidates[0]!.message, /Did you mean/);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('reports unknown CSS Module classes in static destructuring', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    const source = writeProjectFile(rootDir, 'Component.js', 'export {};');
    writeProjectFile(rootDir, 'classes.module.css', '.root {}\n.primary {}\n.kebab-case {}');

    const messages = await lint([
      "import styles from './classes.module.css';",
      'const key = readKey();',
      "const { root, primary: renamed, ['kebab-case']: kebab, [key]: dynamic, ...rest } = styles;",
      'const { primray } = styles;',
      'let assigned;',
      '({ primray: assigned } = styles);',
      'const { missing: directMissing } = styles;',
      'const { root: { ignored } } = styles;',
      'const { root: { nestedIgnored } = fallback } = styles;',
      'const { ignored: ignoredFromCall } = getStyles();',
      'function render({ primray } = styles) {}',
      'const renderArrow = ({ primray } = styles) => {};',
      'const renderExpression = function ({ primray } = styles) {};',
      'function renderShadow(styles) { const { missing } = styles; }',
      'const { missing } = another;',
    ].join('\n'), source, {}, rootDir);

    assert.equal(messages.length, 6);
    assert.deepEqual(messages.map((message) => message.messageId), [
      'unknownClass',
      'unknownClass',
      'unknownClass',
      'unknownClass',
      'unknownClass',
      'unknownClass',
    ]);
    assert.equal(messages.filter((message) => /Unknown CSS Module class "primray"/.test(message.message)).length, 5);
    assert.equal(messages.filter((message) => /Did you mean styles\.primary\?/.test(message.message)).length, 5);
    assert.ok(messages.some((message) => /Unknown CSS Module class "missing"/.test(message.message)));
    assert.ok(messages.some((message) => !/Did you mean/.test(message.message)));
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('fails closed when ESLint cannot resolve the imported binding scope', () => {
  withTemporaryProject((rootDir) => {
    const source = writeProjectFile(rootDir, 'Component.js', 'export {};');
    writeProjectFile(rootDir, 'classes.module.css', '.known {}');
    const reports: unknown[] = [];
    const visitors = noUnknownClass.create({
      cwd: rootDir,
      options: [{}],
      physicalFilename: source,
      report: (report: unknown) => reports.push(report),
      sourceCode: { getScope: () => ({ set: new Map(), upper: null }) },
    } as never) as unknown as {
      MemberExpression(node: unknown): void;
      Program(node: unknown): void;
    };
    const binding = { name: 'styles' };

    visitors.Program({
      body: [
        {
          source: { value: './classes.module.css' },
          specifiers: [{ local: binding, type: 'ImportDefaultSpecifier' }],
          type: 'ImportDeclaration',
        },
        {
          source: { value: 1 },
          specifiers: [{ local: binding, type: 'ImportDefaultSpecifier' }],
          type: 'ImportDeclaration',
        },
      ],
    });
    visitors.MemberExpression({
      computed: false,
      object: { name: 'styles', type: 'Identifier' },
      property: { name: 'missing', type: 'Identifier' },
    });

    assert.deepEqual(reports, []);
  });
});

test('uses the raw template text when ESLint does not provide a cooked value', () => {
  withTemporaryProject((rootDir) => {
    const source = writeProjectFile(rootDir, 'Component.js', 'export {};');
    writeProjectFile(rootDir, 'classes.module.css', '.raw-name {}');
    const reports: unknown[] = [];
    const binding = { name: 'styles' };
    const scope = {
      set: new Map([['styles', { identifiers: [binding] }]]),
      upper: null,
    };
    const visitors = noUnknownClass.create({
      cwd: rootDir,
      options: [{}],
      physicalFilename: source,
      report: (report: unknown) => reports.push(report),
      sourceCode: { getScope: () => scope },
    } as never) as unknown as {
      MemberExpression(node: unknown): void;
      Program(node: unknown): void;
    };

    visitors.Program({
      body: [{
        source: { value: './classes.module.css' },
        specifiers: [{ local: binding, type: 'ImportDefaultSpecifier' }],
        type: 'ImportDeclaration',
      }],
    });
    visitors.MemberExpression({
      computed: true,
      object: { name: 'styles', type: 'Identifier' },
      property: {
        expressions: [],
        quasis: [{ value: { cooked: null, raw: 'raw-name' } }],
        type: 'TemplateLiteral',
      },
    });

    assert.deepEqual(reports, []);
  });
});

test('CLI covers valid flags, text output, and invalid input safely', () => {
  withTemporaryProject((rootDir) => {
    const emptyRoot = join(rootDir, 'empty');
    mkdirSync(emptyRoot);
    mkdirSync(join(rootDir, 'sass'));
    writeProjectFile(rootDir, 'unused.module.css', '.unused {}');
    const output: string[] = [];

    assert.equal(runCli(['check-unused', '--root', emptyRoot], (line) => output.push(line)), 0);
    assert.deepEqual(output, ['No unused CSS Module classes found.']);

    output.length = 0;
    assert.equal(runCli([
      'check-unused',
      'unused.module.css',
      '--root', rootDir,
      '--format', 'text',
      '--alias', '@styles=styles',
      '--sass-load-path', 'sass',
      '--locals-convention', 'camelCase',
      '--no-cache',
      '--cache-limit', '2',
    ], (line) => output.push(line)), 1);
    assert.deepEqual(output, ['unused.module.css: unused']);

    writeProjectFile(rootDir, 'broken.ts', 'const = ;');
    output.length = 0;
    assert.equal(runCli(['check-unused', '--root', rootDir], (line) => output.push(line)), 2);
    assert.deepEqual(output, ['Unable to complete unused CSS Module class scan.']);

    output.length = 0;
    assert.equal(runCli([
      'check-unused',
      '--root', rootDir,
      '--format', 'json',
    ], (line) => output.push(line)), 2);
    assert.deepEqual(JSON.parse(output.join('\n')), { unused: [], incomplete: true });

    for (const args of [
      ['unknown-command'],
      ['check-unused', '--root'],
      ['check-unused', '--root', '--format', 'json'],
      ['check-unused', '--format', 'xml'],
      ['check-unused', '--alias', 'broken'],
      ['check-unused', '--alias', '=target'],
      ['check-unused', '--alias', 'key='],
      ['check-unused', '--alias', 'key\0=target'],
      ['check-unused', '--alias', 'key=target\0'],
      ['check-unused', '--locals-convention', 'invalid'],
      ['check-unused', '--cache-limit'],
      ['check-unused', '--cache-limit', '0'],
      ['check-unused', '--cache-limit', '1.5'],
      ['check-unused', '--cache-limit', 'invalid'],
      ['check-unused', '--unknown'],
      ['check-unused', '--root', join(rootDir, 'missing')],
    ]) {
      const messages: string[] = [];
      assert.equal(runCli(args, (line) => messages.push(line)), 2);
      assert.equal(messages.length, 1);
    }

    const consoleOutput: string[] = [];
    const consoleMock = mock.method(console, 'log', (line: string) => consoleOutput.push(line));
    try {
      assert.equal(runCli(['unknown-command']), 2);
    } finally {
      consoleMock.mock.restore();
    }
    assert.equal(consoleOutput.length, 1);

    let writes = 0;
    assert.equal(runCli(['check-unused', '--root', emptyRoot], () => {
      writes += 1;
      if (writes === 1) {
        throw 'writer failure';
      }
    }), 2);
    assert.equal(writes, 2);
  });
});

test('runs the CLI process bridge only for its own entrypoint', () => {
  withTemporaryProject((rootDir) => {
    const moduleUrl = new URL('../src/cli.js', import.meta.url).href;
    const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const cliLink = join(rootDir, 'css-modules-lint');
    const originalExitCode = process.exitCode;
    const output: string[] = [];

    try {
      symlinkSync(cliPath, cliLink);
      runCliFromProcess(moduleUrl, [process.execPath, 'not-the-cli'], (line) => output.push(line));
      assert.equal(output.length, 0);

      runCliFromProcess(
        moduleUrl,
        [process.execPath, cliLink, 'check-unused', '--root', rootDir],
        (line) => output.push(line),
      );
      assert.deepEqual(output, ['No unused CSS Module classes found.']);
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
