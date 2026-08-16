import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { mock } from 'node:test';

import { ESLint } from 'eslint';
import * as typescriptParser from '@typescript-eslint/parser';

import { runCli, runCliFromProcess } from '../src/cli.js';
import { concatenateCandidates, unionCandidates } from '../src/core/candidates.js';
import {
  clearExtractionCache,
  compileStylesheet,
  extractClasses,
  fingerprintDependencies,
  getExtractionCacheKeys,
  propertyNamesForClass,
  stylesheetLanguage,
} from '../src/core/extractor.js';
import { safeLessFileManager, setLessLoader } from '../src/core/less-compiler.js';
import { normalizeOptions } from '../src/core/options.js';
import {
  isCssModuleSpecifier,
  isInside,
  isSafeProjectFile,
  resolveStylesheet,
} from '../src/core/resolver.js';
import { isSassAvailable, safeSassImporter, setSassLoader } from '../src/core/sass-compiler.js';
import { typescriptExpressionCandidates } from '../src/core/typescript-candidates.js';
import { isTypeScriptAvailable, loadTypeScript, setTypeScriptLoader } from '../src/core/typescript-loader.js';
import { findUnusedClasses, relativeUnusedClasses } from '../src/core/unused.js';
import plugin from '../src/index.js';
import { propertyCandidates } from '../src/rules/candidates.js';
import { noUnknownClass } from '../src/rules/no-unknown-class.js';
import { noUnusedClass } from '../src/rules/no-unused-class.js';
import { unresolvableStylesheet } from '../src/rules/unresolvable-stylesheet.js';
import type { LessModule } from '../src/core/less-compiler.js';
import type { CssModulesOptions } from '../src/core/types.js';

type TestRule = 'no-unknown-class' | 'no-unused-class' | 'unresolvable-stylesheet';

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
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};
const DOCS_BASE_URL =
  'https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/blob/main/docs/rules';
const fixture = (...segments: string[]): string => join(repositoryRoot, 'test', 'fixtures', ...segments);
const installedLess = createRequire(import.meta.url)('less') as LessModule;

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
      files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ...(/\.(?:ts|tsx|mts|cts)$/.test(filePath) ? { parser: typescriptParser } : {}),
      },
      plugins: {
        'css-modules': {
          rules: {
            'no-unknown-class': noUnknownClass,
            'no-unused-class': noUnusedClass,
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
  assert.equal(plugin.rules['no-unused-class'], noUnusedClass);
  assert.equal(plugin.configs.recommended.plugins['css-modules'], plugin);
  assert.equal(plugin.configs.recommended.rules['css-modules/no-unknown-class'], 'error');
  assert.equal(plugin.configs.recommended.rules['css-modules/unresolvable-stylesheet'], 'error');
  assert.equal(
    Object.hasOwn(plugin.configs.recommended.rules, 'css-modules/no-unused-class'),
    false,
  );
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
});

// The URL this replaced pointed at a README anchor that never existed, so asserting the shape is
// not enough: the file it names has to be on disk.
test('every rule documentation link points at a file that exists', () => {
  for (const [name, rule] of Object.entries(plugin.rules)) {
    const url = rule.meta.docs?.url;
    assert.ok(url, `${name} has no documentation URL`);
    assert.equal(url, `${DOCS_BASE_URL}/${name}.md`);
    assert.ok(
      existsSync(join(repositoryRoot, 'docs', 'rules', `${name}.md`)),
      `docs/rules/${name}.md is missing`,
    );
  }
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
    "import styles from './basic.module.css';\nconst size = readSize();\nstyles[`size_${size}`];\nfunction render(styles) { styles.missing; }",
    fixture('Component.js'),
  );

  assert.equal(messages.length, 0);
});

test('checks finite computed CSS Module class candidates', async () => {
  const messages = await lint([
    "import styles from './basic.module.css';",
    "const direct = 'primray';",
    "const choice = enabled ? 'root' : 'missing';",
    "const prefix = 'kebab';",
    "const suffix = compact ? '-case' : '-missing';",
    'styles[direct];',
    'styles[choice];',
    'styles[prefix + suffix];',
  ].join('\n'), fixture('Component.js'));

  assert.deepEqual(
    messages.map((message) => message.message.match(/class "([^"]+)"/)?.[1]),
    ['primray', 'missing', 'kebab-missing'],
  );
  assert.equal(messages.every((message) => message.suggestions === undefined), true);
});

test('checks TypeScript const assertions without type information', async () => {
  const messages = await lint([
    "import styles from './basic.module.css';",
    'declare const enabled: boolean;',
    "const key = enabled ? ('root' as const) : ('primray' as const);",
    "const asserted = <const>'primary';",
    'styles[key];',
    'styles[asserted];',
    "styles['kebab-case'];",
  ].join('\n'), fixture('Component.ts'));

  assert.equal(messages.length, 1);
  assert.match(messages[0]!.message, /Unknown CSS Module class "primray"/);
  assert.equal(messages[0]!.suggestions, undefined);
});

test('keeps unproven ESLint candidate expressions indeterminate and bounded', async () => {
  const bits = Array.from(
    { length: 9 },
    (_, index) => `const bit${index} = enabled ? '${index}a' : '${index}b';`,
  );
  const depth = ["const depth34 = 'root';"];
  for (let index = 33; index >= 0; index -= 1) {
    depth.push(`const depth${index} = depth${index + 1};`);
  }

  const messages = await lint([
    "import styles from './basic.module.css';",
    'declare const enabled: boolean;',
    'declare const declared: string;',
    "let mutable = 'root';",
    "const { pattern } = sourceValue;",
    "var repeated = 'root';",
    "var repeated = 'primary';",
    "const changed = 'root';",
    "changed = 'primary';",
    ...bits,
    ...depth,
    'styles[globalKey];',
    'styles[styles];',
    'styles[declared];',
    'styles[mutable];',
    'styles[pattern];',
    'styles[repeated];',
    'styles[changed];',
    'styles[1];',
    'styles[readKey()];',
    "styles[enabled ? readKey() : 'root'];",
    "styles[enabled ? 'root' : readKey()];",
    "styles['root' - 'primary'];",
    "styles[readKey() + 'root'];",
    "styles['root' + readKey()];",
    'styles[`root_${readKey()}`];',
    'styles[depth0];',
    `styles[\`${Array.from({ length: 9 }, (_, index) => `\${bit${index}}`).join('')}\`];`,
  ].join('\n'), fixture('Component.ts'));

  assert.deepEqual(messages, []);
});

test('bounds candidate-set expansion and rejects unsupported property shapes', () => {
  const tooMany = new Set(Array.from({ length: 257 }, (_, index) => `item-${index}`));
  assert.equal(unionCandidates(new Set(), tooMany), undefined);
  assert.equal(
    concatenateCandidates(
      new Set(Array.from({ length: 17 }, (_, index) => `left-${index}`)),
      new Set(Array.from({ length: 17 }, (_, index) => `right-${index}`)),
    ),
    undefined,
  );
  assert.deepEqual([...unionCandidates(new Set(['root']), new Set(['primary']))!], [
    'root',
    'primary',
  ]);
  assert.deepEqual([...concatenateCandidates(new Set(['size_']), new Set(['sm', 'lg']))!], [
    'size_sm',
    'size_lg',
  ]);

  const emptyScope = () => ({ set: new Map(), upper: null }) as never;
  assert.equal(propertyCandidates({ type: 'PrivateIdentifier', name: 'secret' } as never, true, emptyScope), undefined);
  assert.equal(propertyCandidates({
    expressions: [],
    quasis: [{ value: { cooked: 'root', raw: 'root' } }],
    type: 'TemplateLiteral',
  } as never, false, emptyScope), undefined);
  assert.deepEqual([...propertyCandidates({
    expressions: [{ type: 'Literal', value: '-' }],
    quasis: [
      { value: { cooked: 'root', raw: 'root' } },
      { value: { cooked: null, raw: 'raw' } },
    ],
    type: 'TemplateLiteral',
  } as never, true, emptyScope)!], ['root-raw']);
});

test('resolves and bounds TypeScript candidate expressions through symbols', () => {
  withTemporaryProject((rootDir) => {
    const bits = Array.from(
      { length: 9 },
      (_, index) => `const bit${index} = flag ? '${index}a' : '${index}b';`,
    );
    const depth = ["const depth34 = 'root';"];
    for (let index = 33; index >= 0; index -= 1) {
      depth.push(`const depth${index} = depth${index + 1};`);
    }
    const eightBits = Array.from({ length: 8 }, (_, index) => `bit${index}`).join(' + ');
    const nineBitTemplate = Array.from({ length: 9 }, (_, index) => `\${bit${index}}`).join('');
    const sourcePath = writeProjectFile(rootDir, 'candidates.ts', [
      'declare const flag: boolean;',
      "const literal = 'root';",
      'const alias = literal;',
      'const noSub = `root`;',
      "const conditional = flag ? 'root' : 'primary';",
      "const template = `size_${conditional}`;",
      "const binary = 'size_' + conditional;",
      "const parenthesized = ('root');",
      "const asserted = 'root' as const;",
      "const angleAsserted = <const>'root';",
      "const nonNull = literal!;",
      "let mutable = 'root';",
      'const viaMutable = mutable;',
      'const { pattern } = sourceValue;',
      'const viaPattern = pattern;',
      "var repeated = 'root';",
      "var repeated = 'primary';",
      'const viaRepeated = repeated;',
      'const missing = globalKey;',
      'const called = readKey();',
      "const invalidTrue = flag ? readKey() : 'root';",
      "const invalidFalse = flag ? 'root' : readKey();",
      "const multiplied = 'root' * 'primary';",
      "const invalidLeft = readKey() + 'root';",
      "const invalidRight = 'root' + readKey();",
      'const invalidTemplate = `root_${readKey()}`;',
      'const cycleA = cycleB;',
      'const cycleB = cycleA;',
      'const cycle = cycleA;',
      ...bits,
      ...depth,
      'const tooDeep = depth0;',
      `const tooManyConcat = ${Array.from({ length: 9 }, (_, index) => `bit${index}`).join(' + ')};`,
      `const maxLeft = 'left' + ${eightBits};`,
      `const maxRight = 'right' + ${eightBits};`,
      'const tooManyUnion = flag ? maxLeft : maxRight;',
      `const tooManyTemplate = \`${nineBitTemplate}\`;`,
    ].join('\n'));

    const typescript = loadTypeScript();
    assert.ok(typescript);
    const program = typescript.createProgram({
      rootNames: [sourcePath],
      options: { noLib: true, noResolve: true, target: typescript.ScriptTarget.Latest },
    });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(sourcePath)!;
    const initializers = new Map<string, Parameters<typeof typescriptExpressionCandidates>[2]>();
    for (const statement of source.statements) {
      if (!typescript.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (typescript.isIdentifier(declaration.name) && declaration.initializer) {
          initializers.set(declaration.name.text, declaration.initializer);
        }
      }
    }

    const candidates = (name: string) => {
      const expression = initializers.get(name);
      assert.ok(expression, name);
      return typescriptExpressionCandidates(typescript, checker, expression);
    };

    assert.deepEqual([...candidates('alias')!], ['root']);
    assert.deepEqual([...candidates('noSub')!], ['root']);
    assert.deepEqual([...candidates('conditional')!], ['root', 'primary']);
    assert.deepEqual([...candidates('template')!], ['size_root', 'size_primary']);
    assert.deepEqual([...candidates('binary')!], ['size_root', 'size_primary']);
    for (const name of ['parenthesized', 'asserted', 'angleAsserted', 'nonNull']) {
      assert.deepEqual([...candidates(name)!], ['root']);
    }
    for (const name of [
      'viaMutable',
      'viaPattern',
      'viaRepeated',
      'missing',
      'called',
      'invalidTrue',
      'invalidFalse',
      'multiplied',
      'invalidLeft',
      'invalidRight',
      'invalidTemplate',
      'cycle',
      'tooDeep',
      'tooManyConcat',
      'tooManyUnion',
      'tooManyTemplate',
    ]) {
      assert.equal(candidates(name), undefined, name);
    }
  });
});

test('counts finite computed candidates in no-unused-class without guessing runtime values', async () => {
  const finiteMessages = await lint([
    "import styles from './basic.module.css';",
    "const key = compact ? 'root' : 'primary';",
    'styles[key];',
  ].join('\n'), fixture('Component.js'), {}, repositoryRoot, 'no-unused-class');

  assert.equal(finiteMessages.length, 1);
  assert.match(finiteMessages[0]!.message, /Unused CSS Module class "kebab-case"/);

  const indeterminateMessages = await lint([
    "import styles from './basic.module.css';",
    "let key = 'root';",
    "key = 'primary';",
    'styles[key];',
  ].join('\n'), fixture('Component.js'), {}, repositoryRoot, 'no-unused-class');

  assert.deepEqual(indeterminateMessages, []);
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

test('reports CSS Module classes unused by the current source file', async () => {
  const messages = await lint(
    [
      "import styles from './basic.module.css';",
      'const { root: rootClass } = styles;',
      'styles?.kebabCase;',
    ].join('\n'),
    fixture('Component.js'),
    { localsConvention: 'camelCaseOnly' },
    repositoryRoot,
    'no-unused-class',
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.ruleId, 'css-modules/no-unused-class');
  assert.match(messages[0]!.message, /Unused CSS Module class "primary"/);
});

test('handles static and uncertain no-unused-class access safely', async () => {
  const staticMessages = await lint(
    [
      "import styles from './basic.module.css';",
      "styles['root'];",
      'styles[`primary`];',
    ].join('\n'),
    fixture('Component.js'),
    {
      aliases: {},
      cache: false,
      cacheLimit: 1,
      sassLoadPaths: [],
      suggestThreshold: 0,
    },
    repositoryRoot,
    'no-unused-class',
  );
  assert.equal(staticMessages.length, 1);
  assert.match(staticMessages[0]!.message, /Unused CSS Module class "kebab-case"/);

  const dynamicMessages = await lint(
    [
      "import styles from './basic.module.css';",
      'const key = readKey();',
      'styles[key];',
    ].join('\n'),
    fixture('Component.js'),
    {},
    repositoryRoot,
    'no-unused-class',
  );
  assert.deepEqual(dynamicMessages, []);

  const destructuredMessages = await lint(
    "import styles from './basic.module.css';\nconst { ...rest } = styles;",
    fixture('Component.js'),
    {},
    repositoryRoot,
    'no-unused-class',
  );
  assert.deepEqual(destructuredMessages, []);

  const dynamicDestructuredMessages = await lint(
    [
      "import styles from './basic.module.css';",
      'const key = readKey();',
      'const { [key]: value } = styles;',
    ].join('\n'),
    fixture('Component.js'),
    {},
    repositoryRoot,
    'no-unused-class',
  );
  assert.deepEqual(dynamicDestructuredMessages, []);

  const indirectMessages = await lint(
    "import styles from './basic.module.css';\nconsume(styles);",
    fixture('Component.js'),
    {},
    repositoryRoot,
    'no-unused-class',
  );
  assert.deepEqual(indirectMessages, []);

  const shadowedMessages = await lint(
    "import styles from './basic.module.css';\nfunction render(styles) { return styles.root; }",
    fixture('Component.js'),
    {},
    repositoryRoot,
    'no-unused-class',
  );
  assert.equal(shadowedMessages.length, 3);

  const unresolvedMessages = await lint(
    "import styles from './missing.module.css';\nstyles.root;",
    fixture('Component.js'),
    {},
    repositoryRoot,
    'no-unused-class',
  );
  assert.deepEqual(unresolvedMessages, []);
});

test('no-unused-class fails closed without scope and preserves raw template access', () => {
  withTemporaryProject((rootDir) => {
    const source = writeProjectFile(rootDir, 'Component.js', 'export {};');
    writeProjectFile(rootDir, 'classes.module.css', '.raw-name {}');
    const reports: unknown[] = [];
    const binding = { name: 'styles' };
    const reference: { parent?: unknown; type: string } = { type: 'Identifier' };
    reference.parent = {
      computed: true,
      object: reference,
      property: {
        expressions: [],
        quasis: [{ value: { cooked: null, raw: 'raw-name' } }],
        type: 'TemplateLiteral',
      },
      type: 'MemberExpression',
    };
    const scope = {
      set: new Map([['styles', { identifiers: [binding], references: [{ identifier: reference }] }]]),
      upper: null,
    };
    const visitors = noUnusedClass.create({
      cwd: rootDir,
      options: [{}],
      physicalFilename: source,
      report: (report: unknown) => reports.push(report),
      sourceCode: { getScope: () => scope },
    } as never) as unknown as {
      'Program:exit': () => void;
      Program(node: unknown): void;
    };

    visitors.Program({
      body: [
        { type: 'ExpressionStatement' },
        { source: { value: './classes.module.css' }, specifiers: [], type: 'ImportDeclaration' },
        {
          source: { value: 1 },
          specifiers: [{ local: binding, type: 'ImportDefaultSpecifier' }],
          type: 'ImportDeclaration',
        },
        {
          source: { value: './classes.module.css' },
          specifiers: [{ local: binding, type: 'ImportDefaultSpecifier' }],
          type: 'ImportDeclaration',
        },
      ],
    });
    visitors['Program:exit']();
    assert.deepEqual(reports, []);

    const noScopeReports: unknown[] = [];
    const noScopeVisitors = noUnusedClass.create({
      cwd: rootDir,
      options: [{}],
      physicalFilename: source,
      report: (report: unknown) => noScopeReports.push(report),
      sourceCode: { getScope: () => ({ set: new Map(), upper: null }) },
    } as never) as unknown as {
      'Program:exit': () => void;
      Program(node: unknown): void;
    };
    noScopeVisitors.Program({
      body: [{
        source: { value: './classes.module.css' },
        specifiers: [{ local: binding, type: 'ImportDefaultSpecifier' }],
        type: 'ImportDeclaration',
      }],
    });
    noScopeVisitors['Program:exit']();
    assert.deepEqual(noScopeReports, []);
  });
});

test('keeps composed and Sass-extended classes out of no-unused-class reports', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    const source = writeProjectFile(rootDir, 'View.js', 'export {};');
    writeProjectFile(rootDir, 'composed.module.css', [
      '.base {}',
      '.left { composes: base; }',
      '.right { composes: base; }',
      '.root { composes: left right; }',
    ].join('\n'));

    const composedMessages = await lint(
      "import styles from './composed.module.css';\nstyles.root;",
      source,
      {},
      rootDir,
      'no-unused-class',
    );
    assert.deepEqual(composedMessages, []);

    writeProjectFile(rootDir, 'duplicates.module.css', '.root {}\n.primary {}\n.unused {}');
    const duplicateMessages = await lint([
      "import first from './duplicates.module.css';",
      "import second from './duplicates.module.css';",
      'first.root;',
      'second.primary;',
    ].join('\n'), source, {}, rootDir, 'no-unused-class');
    assert.equal(duplicateMessages.length, 1);
    assert.match(duplicateMessages[0]!.message, /Unused CSS Module class "unused"/);

    const dynamicDuplicateMessages = await lint([
      "import first from './duplicates.module.css';",
      "import second from './duplicates.module.css';",
      'const key = readKey();',
      'first[key];',
      'second.root;',
    ].join('\n'), source, {}, rootDir, 'no-unused-class');
    assert.deepEqual(dynamicDuplicateMessages, []);

    writeProjectFile(rootDir, 'extended.module.scss', [
      '.base { color: red; }',
      '.notice { @extend .base; }',
    ].join('\n'));
    writeProjectFile(rootDir, 'Extended.js', [
      "import styles from './extended.module.scss';",
      'styles.notice;',
    ].join('\n'));
    const extendedMessages = await lint(
      "import styles from './extended.module.scss';\nstyles.notice;",
      source,
      {},
      rootDir,
      'no-unused-class',
    );
    assert.deepEqual(extendedMessages, []);
    assert.deepEqual(findUnusedClasses({ rootDir }), { incomplete: true, unused: [] });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
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

test('compiles Less before collecting selectors', () => {
  const options = normalizeOptions(undefined, repositoryRoot);
  const extracted = extractClasses(fixture('less', 'features.module.less'), options);

  assert.ok(extracted);
  assert.deepEqual(
    new Set(['root', 'root--active', 'child', 'child--deep', 'size_sm', 'space-compact']),
    extracted.classes,
  );
  assert.equal(extracted.hasExtend, false);
  assert.equal(stylesheetLanguage(fixture('less', 'features.module.less')), 'less');
  assert.equal(stylesheetLanguage(fixture('basic.module.css')), 'css');
});

test('uses configured local load paths for Less', () => {
  const stylesheet = fixture('less', 'load-path.module.less');
  const viaLoadPaths = extractClasses(
    stylesheet,
    normalizeOptions({ loadPaths: ['test/fixtures/less/load-paths'] }, repositoryRoot),
  );
  const viaDeprecatedAlias = extractClasses(
    stylesheet,
    normalizeOptions({ sassLoadPaths: ['test/fixtures/less/load-paths'] }, repositoryRoot),
  );

  assert.ok(viaLoadPaths?.classes.has('tone'));
  assert.ok(viaDeprecatedAlias?.classes.has('tone'));
  assert.equal(extractClasses(stylesheet, normalizeOptions(undefined, repositoryRoot)), undefined);
});

test('checks Less CSS Modules through the rules', async () => {
  const messages = await lint([
    "import styles from './less/features.module.less';",
    'styles.root;',
    "styles['space-compact'];",
    'styles.rooot;',
  ].join('\n'), fixture('Component.js'));

  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.ruleId, 'css-modules/no-unknown-class');
  assert.match(messages[0]!.message, /Unknown CSS Module class "rooot".*Did you mean styles\.root\?/);

  const unresolvableMessages = await lint(
    "import styles from './less/features.module.less';\nstyles.root;",
    fixture('Component.js'),
    {},
    repositoryRoot,
    'unresolvable-stylesheet',
  );
  assert.deepEqual(unresolvableMessages, []);
});

test('resolves and invalidates Less imports through tsconfig aliases', () => {
  withTemporaryProject((rootDir) => {
    clearExtractionCache();
    writeProjectFile(rootDir, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@theme': ['src/first/theme.less'] } },
    }));
    writeProjectFile(rootDir, 'src/first/theme.less', '@name: first;');
    writeProjectFile(rootDir, 'src/second/theme.less', '@name: second;');
    const stylesheet = writeProjectFile(rootDir, 'src/entry.module.less', [
      "@import '@theme';",
      '.entry-@{name} { display: block; }',
    ].join('\n'));
    const options = normalizeOptions(undefined, rootDir);

    assert.ok(extractClasses(stylesheet, options)?.classes.has('entry-first'));

    writeProjectFile(rootDir, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@theme': ['src/second/theme.less'] } },
    }));
    assert.ok(extractClasses(stylesheet, options)?.classes.has('entry-second'));
    clearExtractionCache();
  });
});

test('rejects unsafe Less imports before reading files', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    const entry = writeProjectFile(rootDir, 'src/entry.module.less', '.root { display: block; }');
    writeProjectFile(rootDir, 'src/tokens.less', '@c: red;');
    writeProjectFile(rootDir, 'src/helper.js', 'module.exports = {};');
    writeProjectFile(rootDir, 'node_modules/pkg/vendor.less', '@v: blue;');
    const options = normalizeOptions(undefined, rootDir);
    const dependencies = new Set<string>();
    const directory = join(rootDir, 'src');
    const fileManager = safeLessFileManager(entry, options, dependencies, installedLess);

    // Always true: declining support hands the read back to Less's own unsandboxed file manager.
    assert.equal(fileManager.supports(), true);
    assert.equal(fileManager.supportsSync(), true);

    const loaded = fileManager.loadFileSync('tokens', directory, { ext: '.less' });
    assert.equal(loaded.filename, join(rootDir, 'src', 'tokens.less'));
    assert.match(loaded.contents!, /@c: red;/);
    assert.deepEqual([...dependencies], [join(rootDir, 'src', 'tokens.less')]);

    // An explicit extension is kept rather than doubled, with or without a suggested one.
    assert.equal(fileManager.loadFileSync('tokens.less', directory, {}).filename, join(rootDir, 'src', 'tokens.less'));

    for (const [specifier, loadOptions] of [
      ['../../outside', { ext: '.less' }],
      ['http://evil.example/x.less', { ext: '.less' }],
      ['../node_modules/pkg/vendor', { ext: '.less' }],
      ['./evil', { ext: '.js' }],
      ['helper.js', {}],
      ['./evil.js', { mime: 'application/javascript', ext: '.js' }],
      ['missing', { ext: '.less' }],
    ] as [string, { ext?: string; mime?: string }][]) {
      const refused = fileManager.loadFileSync(specifier, directory, loadOptions);
      assert.equal(refused.filename, undefined, `expected ${specifier} to be refused`);
      assert.ok(refused.error);
    }

    await assert.rejects(fileManager.loadFile(), /synchronously/);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('refuses Less @plugin directives and inline JavaScript', () => {
  withTemporaryProject((rootDir) => {
    const sentinel = join(rootDir, 'PWNED');
    const options = normalizeOptions(undefined, rootDir);
    writeProjectFile(rootDir, 'evil.js', [
      'module.exports = {',
      `  install() { require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'pwned'); },`,
      '};',
    ].join('\n'));
    writeProjectFile(rootDir, 'partial.less', '@plugin "./evil.js";\n@c: red;');

    const direct = writeProjectFile(rootDir, 'direct.module.less', '@plugin "./evil.js";\n.a { color: red; }');
    const viaImport = writeProjectFile(rootDir, 'imported.module.less', "@import 'partial';\n.b { color: @c; }");
    // Not at the start of a line, so the source scan cannot match it. This is the case that
    // proves the file manager's JavaScript refusal works against real Less, not just the regex.
    const offset = writeProjectFile(rootDir, 'offset.module.less', '/* c */@plugin "./evil.js";\n.d { color: red; }');
    const inlineJs = writeProjectFile(rootDir, 'inline.module.less', [
      '.c {',
      `  width: ~\`(function () { require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'pwned'); return 1; })()\`;`,
      '}',
    ].join('\n'));

    assert.equal(extractClasses(direct, options), undefined);
    assert.equal(extractClasses(viaImport, options), undefined);
    assert.equal(extractClasses(offset, options), undefined);
    assert.equal(extractClasses(inlineJs, options), undefined);
    assert.equal(existsSync(sentinel), false);
  });
});

test('hands Less nothing but stylesheets, whatever the import asks for', () => {
  withTemporaryProject((rootDir) => {
    const options = normalizeOptions(undefined, rootDir);
    writeProjectFile(rootDir, 'secret.env', 'API_KEY=super-secret-value');
    writeProjectFile(rootDir, 'app.js', 'const token = "js-secret-value";');
    // A stylesheet name is not evidence of a stylesheet: this one resolves to JavaScript.
    symlinkSync(join(rootDir, 'app.js'), join(rootDir, 'disguised.less'));

    // Positive control: the same import form works when it really does resolve to a stylesheet,
    // so the refusal below is about what the symlink points at, not about `(inline)` itself.
    writeProjectFile(rootDir, 'genuine.less', '.genuine { color: blue; }');
    const control = writeProjectFile(rootDir, 'control.module.less', [
      "@import (inline) 'genuine.less';",
      '.ok { color: red; }',
    ].join('\n'));
    assert.deepEqual([...extractClasses(control, options)!.classes].sort(), ['genuine', 'ok']);

    const inlined = writeProjectFile(rootDir, 'inlined.module.less', [
      "@import (inline) 'disguised.less';",
      '.ok { color: red; }',
    ].join('\n'));
    // Refused outright, so the JavaScript never reaches the compiled CSS at all.
    assert.equal(compileStylesheet(inlined, options), undefined);

    // data-uri reads a file and Less interpolation can carry the bytes into a selector, which
    // this plugin would then print as a class name. It degrades to a plain url() instead.
    const leak = writeProjectFile(rootDir, 'leak.module.less', [
      '@leak: data-uri("text/plain","./secret.env");',
      '.@{leak} { color: red; }',
    ].join('\n'));
    const extracted = extractClasses(leak, options);

    assert.ok(extracted);
    assert.equal([...extracted.classes].join(' ').includes('super-secret-value'), false);
    assert.deepEqual([...extracted.classes], ['url("./secret.env")']);
  });
});

test('applies CSS Modules semantics to Less output', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    const source = writeProjectFile(rootDir, 'View.js', 'export {};');
    writeProjectFile(rootDir, 'base.module.css', '.base { color: red; }');
    const stylesheet = writeProjectFile(rootDir, 'Card.module.less', [
      '@name: card;',
      ':export { brandColor: #0a0; }',
      '.@{name}-title { font-weight: bold; }',
      ".composed { composes: base from './base.module.css'; }",
      ':global(.vendor-widget) { display: block; }',
    ].join('\n'));
    const extracted = extractClasses(stylesheet, normalizeOptions({ localsConvention: 'camelCase' }, rootDir));

    assert.ok(extracted);
    // Interpolated selector, ICSS :export, cross-file composes, and the camelCase alias of a
    // hyphenated class are all readable; :global is exposed but is not a local class.
    assert.equal(extracted.classes.has('card-title'), true);
    assert.equal(extracted.classes.has('cardTitle'), true);
    assert.equal(extracted.classes.has('brandColor'), true);
    assert.equal(extracted.classes.has('composed'), true);
    assert.equal(extracted.classes.has('vendor-widget'), true);
    assert.equal(extracted.localClasses.has('vendor-widget'), false);

    const messages = await lint([
      "import styles from './Card.module.less';",
      'styles.cardTitle;',
      'styles.brandColor;',
      'styles.nope;',
    ].join('\n'), source, { localsConvention: 'camelCase' }, rootDir);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.message, /Unknown CSS Module class "nope"/);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('treats Less :extend as an incomplete unused-class analysis', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    const source = writeProjectFile(rootDir, 'View.js', 'export {};');
    const stylesheet = writeProjectFile(rootDir, 'extended.module.less', [
      '.base { color: red; }',
      '.notice:extend(.base) { display: block; }',
    ].join('\n'));
    const extracted = extractClasses(stylesheet, normalizeOptions(undefined, rootDir));

    assert.equal(extracted?.hasExtend, true);
    assert.equal(extracted?.hasSassExtend, true);

    const messages = await lint(
      "import styles from './extended.module.less';\nstyles.notice;",
      source,
      {},
      rootDir,
      'no-unused-class',
    );
    assert.deepEqual(messages, []);
    assert.deepEqual(findUnusedClasses({ rootDir }), { incomplete: true, unused: [] });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('reports a missing Less compiler with an install hint', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    const source = writeProjectFile(rootDir, 'View.js', 'export {};');
    const stylesheet = writeProjectFile(rootDir, 'Card.module.less', '.root { display: block; }');
    writeProjectFile(rootDir, 'plain.module.css', '.plain {}');
    const options = normalizeOptions(undefined, rootDir);
    const code = [
      "import styles from './Card.module.less';",
      "import plain from './plain.module.css';",
      'styles.root;',
      'plain.plain;',
    ].join('\n');

    clearExtractionCache();
    setLessLoader(() => {
      throw new Error("Cannot find module 'less'");
    });

    const messages = await lint(code, source, {}, rootDir, 'unresolvable-stylesheet');
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.message, /Install the optional peer dependency "less"/);
    assert.match(messages[0]!.message, /Card\.module\.less/);

    // The other rules stay silent rather than inventing unknown classes.
    assert.deepEqual(await lint(code, source, {}, rootDir, 'no-unknown-class'), []);
    assert.deepEqual(findUnusedClasses({ rootDir }), { incomplete: true, unused: [] });

    // A compiler that never calls back, and one that reports no output, both fail closed.
    clearExtractionCache();
    setLessLoader(() => ({ FileManager: class {}, render: () => undefined }));
    assert.equal(extractClasses(stylesheet, options), undefined);

    clearExtractionCache();
    setLessLoader(() => ({
      FileManager: class {},
      render: (_source: string, _options: unknown, callback: (error: unknown) => void) => {
        callback(new Error('boom'));
      },
    }));
    assert.equal(extractClasses(stylesheet, options), undefined);
  } finally {
    setLessLoader(undefined);
    clearExtractionCache();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('reports a missing Sass compiler with an install hint', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    const source = writeProjectFile(rootDir, 'View.js', 'export {};');
    const stylesheet = writeProjectFile(rootDir, 'Card.module.scss', '.root { display: block; }');
    const plain = writeProjectFile(rootDir, 'plain.module.css', '.plain {}');
    const options = normalizeOptions(undefined, rootDir);
    const code = [
      "import styles from './Card.module.scss';",
      "import plain from './plain.module.css';",
      'styles.root;',
      'plain.plain;',
    ].join('\n');

    clearExtractionCache();
    setSassLoader(() => {
      throw new Error("Cannot find module 'sass'");
    });
    assert.equal(isSassAvailable(), false);

    // Dart Sass before 1.45 has no `compileString`. The peer range rules it out, but a project can
    // ignore npm's warning, and then every valid stylesheet would fail with an unexplained compile
    // error. Treat it as absent so the install hint fires instead.
    setSassLoader(() => ({ Logger: { silent: undefined } }));
    assert.equal(isSassAvailable(), false);

    setSassLoader(() => {
      throw new Error("Cannot find module 'sass'");
    });

    const messages = await lint(code, source, {}, rootDir, 'unresolvable-stylesheet');
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.message, /Install the optional peer dependency "sass"/);
    assert.match(messages[0]!.message, /Card\.module\.scss/);

    // The other rules stay silent rather than inventing unknown classes, and plain CSS keeps
    // working: it needs no compiler at all.
    assert.deepEqual(await lint(code, source, {}, rootDir, 'no-unknown-class'), []);
    assert.equal(extractClasses(stylesheet, options), undefined);
    assert.ok(extractClasses(plain, options));
  } finally {
    setSassLoader(undefined);
    clearExtractionCache();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('degrades tsconfig aliases and the CLI scan without typescript', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'css-modules-real-'));
  const rootDir = realpathSync(temporaryDirectory);
  try {
    writeProjectFile(rootDir, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@styles/*': ['src/styles/*'] } },
    }));
    writeProjectFile(rootDir, 'src/styles/theme.module.css', '.root {}');
    const source = writeProjectFile(rootDir, 'src/View.js', 'export {};');
    const aliased = "import styles from '@styles/theme.module.css';\nstyles.root;";

    clearExtractionCache();
    assert.deepEqual(await lint(aliased, source, {}, rootDir, 'unresolvable-stylesheet'), []);

    setTypeScriptLoader(() => {
      throw new Error("Cannot find module 'typescript'");
    });
    clearExtractionCache();
    assert.equal(isTypeScriptAvailable(), false);

    // The alias stops resolving, and the report names the cause instead of blaming the file.
    const messages = await lint(aliased, source, {}, rootDir, 'unresolvable-stylesheet');
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.message, /Install the optional peer dependency "typescript"/);

    // Explicit `aliases` are the documented fallback and keep working with no parser at all.
    clearExtractionCache();
    assert.deepEqual(
      await lint(
        aliased,
        source,
        { aliases: { '@styles/*': 'src/styles/*' } },
        rootDir,
        'unresolvable-stylesheet',
      ),
      [],
    );

    // A genuinely missing relative import is never blamed on the absent parser.
    clearExtractionCache();
    const missing = await lint(
      "import styles from './nope.module.css';\nstyles.root;",
      source,
      {},
      rootDir,
      'unresolvable-stylesheet',
    );
    assert.equal(missing.length, 1);
    assert.match(missing[0]!.message, /Unable to resolve CSS Module/);
    assert.doesNotMatch(missing[0]!.message, /typescript/);

    // Neither is an unresolved alias in a project that has no tsconfig to read in the first place.
    unlinkSync(join(rootDir, 'tsconfig.json'));
    clearExtractionCache();
    const withoutConfig = await lint(aliased, source, {}, rootDir, 'unresolvable-stylesheet');
    assert.equal(withoutConfig.length, 1);
    assert.doesNotMatch(withoutConfig[0]!.message, /typescript/);

    // Every class looks unused when no source file can be parsed, so the scan fails closed.
    const scan = findUnusedClasses({ rootDir });
    assert.equal(scan.incomplete, true);
    assert.deepEqual(scan.unused, []);
    assert.match(scan.reason!, /Install the optional peer dependency "typescript"/);

    const textOutput: string[] = [];
    assert.equal(runCli(['check-unused', '--root', rootDir], (line) => textOutput.push(line)), 2);
    assert.match(textOutput[0]!, /Install the optional peer dependency "typescript"/);

    const jsonOutput: string[] = [];
    assert.equal(
      runCli(
        ['check-unused', '--root', rootDir, '--format', 'json'],
        (line) => jsonOutput.push(line),
      ),
      2,
    );
    const reported = JSON.parse(jsonOutput[0]!) as { incomplete: boolean; reason: string };
    assert.equal(reported.incomplete, true);
    assert.match(reported.reason, /Install the optional peer dependency "typescript"/);
  } finally {
    setTypeScriptLoader(undefined);
    clearExtractionCache();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('declares every compiler as an optional peer dependency', () => {
  for (const [name, range] of Object.entries({
    less: '^4.0.0',
    sass: '^1.45.0',
    typescript: '>=4.8.4 <6.1.0',
  })) {
    assert.equal(packageManifest.peerDependencies[name], range);
    assert.equal(packageManifest.peerDependenciesMeta[name]?.optional, true);
    assert.equal(Object.hasOwn(packageManifest.dependencies, name), false);
  }

  // `@typescript-eslint/utils` declares typescript as a peer too. A range narrower than its own is
  // what installs a second, nested copy, so the two have to stay identical.
  const utilsManifest = JSON.parse(
    readFileSync(
      join(repositoryRoot, 'node_modules', '@typescript-eslint', 'utils', 'package.json'),
      'utf8',
    ),
  ) as { peerDependencies: Record<string, string> };
  assert.equal(
    packageManifest.peerDependencies['typescript'],
    utilsManifest.peerDependencies['typescript'],
  );
});

test('keeps optional peer dependencies out of the published type surface', () => {
  // An optional peer named anywhere in the reachable declarations breaks `tsc` for a consumer who
  // did not install it. Structural types in the compiler modules exist precisely to prevent this.
  const optional = new Set(['less', 'sass', 'typescript']);
  const visited = new Set<string>();
  const leaks: string[] = [];

  const walk = (file: string): void => {
    const declaration = resolve(file);
    if (visited.has(declaration) || !existsSync(declaration)) {
      return;
    }
    visited.add(declaration);

    for (const [, specifier] of readFileSync(declaration, 'utf8').matchAll(/from '([^']+)'/g)) {
      if (specifier!.startsWith('.')) {
        walk(resolve(dirname(declaration), specifier!.replace(/\.js$/, '.d.ts')));
      } else if (optional.has(specifier!)) {
        leaks.push(`${relative(repositoryRoot, declaration)} -> ${specifier}`);
      }
    }
  };

  walk(join(repositoryRoot, 'dist', 'src', 'index.d.ts'));
  assert.ok(visited.size > 1, 'the declaration graph was not walked');
  assert.deepEqual(leaks, []);
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
    "import brokenLess from './less/dynamic.module.less';",
    "import ordinary from './ordinary.js';",
    "import * as namespace from './basic.module.css';",
    "import { root } from './basic.module.css';",
    "import './basic.module.css';",
    'styles.root;',
  ].join('\n'), fixture('Component.js'), { cacheLimit: 2 }, repositoryRoot, 'unresolvable-stylesheet');

  assert.equal(messages.length, 3);
  assert.equal(messages[0]!.ruleId, 'css-modules/unresolvable-stylesheet');
  assert.match(messages[0]!.message, /Unable to resolve CSS Module "\.\/missing\.module\.scss"/);
  assert.match(messages[1]!.message, /Unable to compile CSS Module "\.\/sass\/dynamic\.module\.scss"/);
  assert.match(messages[2]!.message, /Unable to compile CSS Module "\.\/less\/dynamic\.module\.less"/);
  assert.doesNotMatch(messages[2]!.message, /Install the optional peer dependency/);
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

test('finds unused local classes and resolves finite computed module access', () => {
  const rootDir = fixture('unused');
  const result = findUnusedClasses({ rootDir });

  assert.equal(result.incomplete, false);
  assert.deepEqual(relativeUnusedClasses(rootDir, result.unused), [
    { stylesheet: 'orphan.module.scss', className: 'orphan' },
    { stylesheet: 'used.module.css', className: 'unused' },
  ]);
});

test('project-wide unused resolves finite TypeScript candidates and exposes indeterminate access', () => {
  withTemporaryProject((rootDir) => {
    writeProjectFile(rootDir, 'finite.module.css', [
      '.size_sm {}',
      '.size_lg {}',
      '.unused {}',
    ].join('\n'));
    writeProjectFile(rootDir, 'finite.ts', [
      "import helper from './helper.js';",
      "import styles from './finite.module.css';",
      'declare const compact: boolean;',
      "const prefix = 'size_' as const;",
      "const size = compact ? ('sm' as const) : ('lg' as const);",
      'styles[prefix + size];',
      'void helper;',
    ].join('\n'));
    writeProjectFile(rootDir, 'helper.js', 'export default 1;');
    writeProjectFile(rootDir, 'destructured.module.css', [
      '.root {}',
      '.primary {}',
      '.unused {}',
    ].join('\n'));
    writeProjectFile(rootDir, 'destructured.ts', [
      "import styles from './destructured.module.css';",
      'declare const primary: boolean;',
      "const key = primary ? 'primary' : 'root';",
      "const { root, 'primary': quoted } = styles;",
      'const { [key]: className } = styles;',
      'void root;',
      'void quoted;',
      'void className;',
    ].join('\n'));

    assert.deepEqual(findUnusedClasses({ rootDir }), {
      incomplete: false,
      unused: [
        { stylesheet: join(rootDir, 'destructured.module.css'), className: 'unused' },
        { stylesheet: join(rootDir, 'finite.module.css'), className: 'unused' },
      ],
    });

    writeProjectFile(rootDir, 'rest.module.css', '.root {}');
    writeProjectFile(rootDir, 'rest.ts', [
      "import styles from './rest.module.css';",
      'const { ...rest } = styles;',
      'void rest;',
    ].join('\n'));
    const rest = findUnusedClasses({ rootDir, paths: ['rest.ts'] });
    assert.equal(rest.incomplete, true);
    assert.match(rest.reason!, /rest\.ts:2:7/);
    unlinkSync(join(rootDir, 'rest.ts'));

    writeProjectFile(rootDir, 'nested.ts', [
      "import styles from './rest.module.css';",
      'const { root: { nested } } = styles;',
      'void nested;',
    ].join('\n'));
    const nested = findUnusedClasses({ rootDir, paths: ['nested.ts'] });
    assert.equal(nested.incomplete, true);
    assert.match(nested.reason!, /nested\.ts:2:7/);
    unlinkSync(join(rootDir, 'nested.ts'));

    writeProjectFile(rootDir, 'numeric.ts', [
      "import styles from './rest.module.css';",
      'const { 1: numeric } = styles;',
      'void numeric;',
    ].join('\n'));
    const numeric = findUnusedClasses({ rootDir, paths: ['numeric.ts'] });
    assert.equal(numeric.incomplete, true);
    assert.match(numeric.reason!, /numeric\.ts:2:7/);
    unlinkSync(join(rootDir, 'numeric.ts'));

    writeProjectFile(rootDir, 'missing.ts', [
      "import styles from './missing.module.css';",
      'styles.root;',
    ].join('\n'));
    const missing = findUnusedClasses({ rootDir, paths: ['missing.ts'] });
    assert.equal(missing.incomplete, true);
    assert.match(missing.reason!, /Unable to resolve CSS Module/);
    unlinkSync(join(rootDir, 'missing.ts'));

    writeProjectFile(rootDir, 'runtime.module.css', '.root {}');
    writeProjectFile(rootDir, 'runtime.ts', [
      "import styles from './runtime.module.css';",
      'declare const key: string;',
      'styles[key];',
    ].join('\n'));

    const incomplete = findUnusedClasses({ rootDir });
    assert.equal(incomplete.incomplete, true);
    assert.deepEqual(incomplete.unused, []);
    assert.match(incomplete.reason!, /runtime\.ts:3:1/);

    const output: string[] = [];
    assert.equal(runCli(['check-unused', '--root', rootDir], (line) => output.push(line)), 2);
    assert.match(output[0]!, /runtime\.ts:3:1/);
  });
});

test('keeps CSS class identity when checking camel-cased properties', () => {
  withTemporaryProject((rootDir) => {
    writeProjectFile(rootDir, 'View.ts', [
      "import styles from './View.module.css';",
      'styles.kebabCase;',
    ].join('\n'));
    writeProjectFile(rootDir, 'View.module.css', '.kebab-case {}\n.unused {}');

    assert.deepEqual(findUnusedClasses({
      rootDir,
      localsConvention: 'camelCaseOnly',
    }), {
      incomplete: false,
      unused: [{ stylesheet: join(rootDir, 'View.module.css'), className: 'unused' }],
    });
  });
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
      // Less compiles it fine; fingerprinting is what rejects a file outside the project root.
      const outsideLess = writeProjectFile(outsideDir, 'outside.module.less', '.outside { color: red; }');
      assert.equal(compileStylesheet(outsideLess, normalizeOptions(undefined, rootDir)), undefined);
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
      const indeterminate = findUnusedClasses({ rootDir });
      assert.equal(indeterminate.incomplete, true);
      assert.deepEqual(indeterminate.unused, []);
      assert.match(indeterminate.reason!, /dynamic\.js:3:1/);
      const indirect = findUnusedClasses({ rootDir, paths: ['identifier.mjs'] });
      assert.equal(indirect.incomplete, true);
      assert.match(indirect.reason!, /identifier\.mjs:2:9/);
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

test('scans Less through the CLI and fails closed without a compiler', () => {
  withTemporaryProject((rootDir) => {
    clearExtractionCache();
    writeProjectFile(rootDir, 'Card.module.less', '.used { display: block; }\n.stale { display: none; }');
    writeProjectFile(rootDir, 'View.ts', "import styles from './Card.module.less';\nstyles.used;\n");
    const output: string[] = [];

    assert.equal(runCli(['check-unused', '--root', rootDir], (line) => output.push(line)), 1);
    assert.deepEqual(output, ['Card.module.less: stale']);

    // Without the optional compiler the scan cannot account for the stylesheet, so it reports
    // an incomplete run rather than a clean one. This is the documented 0 -> 2 upgrade note.
    // The cache is cleared after stubbing: a cache entry survives the compiler disappearing,
    // because it is validated by content hash and the compiler is not part of its key.
    output.length = 0;
    setLessLoader(() => {
      throw new Error("Cannot find module 'less'");
    });
    clearExtractionCache();
    try {
      assert.equal(runCli(['check-unused', '--root', rootDir], (line) => output.push(line)), 2);
      assert.deepEqual(output, ['Unable to complete unused CSS Module class scan.']);
    } finally {
      setLessLoader(undefined);
      clearExtractionCache();
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
      "const { root, primary: renamed, ['kebab-case']: kebab, [`root`]: templateRoot, [key]: dynamic, ...rest } = styles;",
      "const finiteKey = condition ? 'root' : 'primrayComputed';",
      'const { [finiteKey]: finite } = styles;',
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

    assert.equal(messages.length, 7);
    assert.deepEqual(messages.map((message) => message.messageId), [
      'unknownClass',
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
    assert.ok(messages.some((message) => /Unknown CSS Module class "primrayComputed"/.test(message.message)));
    assert.ok(messages.some((message) =>
      /primrayComputed/.test(message.message) && !/Did you mean/.test(message.message)));
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
      '--load-path', 'sass',
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
