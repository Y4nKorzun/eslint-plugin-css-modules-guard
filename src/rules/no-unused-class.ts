import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

import { extractClasses, propertyNamesForClass } from '../core/extractor.js';
import { normalizeOptions } from '../core/options.js';
import { isCssModuleSpecifier, resolveStylesheet } from '../core/resolver.js';
import type { CssModulesOptions } from '../core/types.js';

type Options = readonly [CssModulesOptions?];
type MessageIds = 'unusedClass';

interface ImportedModule {
  binding: TSESTree.Identifier;
  localClasses: ReadonlySet<string>;
  stylesheet: string;
}

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://www.npmjs.com/package/eslint-plugin-css-modules-guard#rule-css-modules${name}`,
);

type PropertyKey = TSESTree.MemberExpression['property'] | TSESTree.Property['key'];

function staticPropertyName(property: PropertyKey, computed: boolean): string | undefined {
  if (!computed && property.type === TSESTree.AST_NODE_TYPES.Identifier) {
    return property.name;
  }

  if (
    property.type === TSESTree.AST_NODE_TYPES.Literal &&
    typeof property.value === 'string'
  ) {
    return property.value;
  }

  if (
    computed &&
    property.type === TSESTree.AST_NODE_TYPES.TemplateLiteral &&
    property.expressions.length === 0
  ) {
    return property.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
  }

  return undefined;
}

function destructuredClassNames(node: TSESTree.Identifier): string[] | undefined {
  const parent = node.parent;
  if (
    parent.type !== TSESTree.AST_NODE_TYPES.VariableDeclarator ||
    parent.init !== node ||
    parent.id.type !== TSESTree.AST_NODE_TYPES.ObjectPattern
  ) {
    return undefined;
  }

  const classNames: string[] = [];
  for (const property of parent.id.properties) {
    if (property.type !== TSESTree.AST_NODE_TYPES.Property) {
      return undefined;
    }

    const className = staticPropertyName(property.key, property.computed);
    if (!className) {
      return undefined;
    }
    classNames.push(className);
  }

  return classNames;
}

function referencedClassNames(node: TSESTree.Identifier): string[] | undefined {
  const parent = node.parent;
  if (
    parent.type === TSESTree.AST_NODE_TYPES.MemberExpression &&
    parent.object === node
  ) {
    const className = staticPropertyName(parent.property, parent.computed);
    return className ? [className] : undefined;
  }

  return destructuredClassNames(node);
}

export const noUnusedClass = createRule<Options, MessageIds>({
  name: 'no-unused-class',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Report CSS Module classes unused by the current source file.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          localsConvention: {
            type: 'string',
            enum: ['asIs', 'camelCase', 'camelCaseOnly', 'dashes'],
          },
          aliases: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          sassLoadPaths: {
            type: 'array',
            items: { type: 'string' },
          },
          suggestThreshold: {
            type: 'integer',
            minimum: 0,
            maximum: 10,
          },
          cache: { type: 'boolean' },
          cacheLimit: {
            type: 'integer',
            minimum: 1,
          },
        },
      },
    ],
    messages: {
      unusedClass: 'Unused CSS Module class "{{className}}" in "{{stylesheet}}".',
    },
  },
  defaultOptions: [{}],
  create(context) {
    const options = normalizeOptions(context.options[0], context.cwd);
    const importedModules: ImportedModule[] = [];

    const importedVariable = (binding: TSESTree.Identifier) => {
      let scope: ReturnType<typeof context.sourceCode.getScope> | null =
        context.sourceCode.getScope(binding);

      while (scope) {
        const variable = scope.set.get(binding.name);
        if (variable?.identifiers.includes(binding)) {
          return variable;
        }
        scope = scope.upper;
      }

      return undefined;
    };

    return {
      Program(program) {
        for (const statement of program.body) {
          if (statement.type !== TSESTree.AST_NODE_TYPES.ImportDeclaration) {
            continue;
          }

          const defaultImport = statement.specifiers.find(
            (specifier): specifier is TSESTree.ImportDefaultSpecifier =>
              specifier.type === TSESTree.AST_NODE_TYPES.ImportDefaultSpecifier,
          );
          const specifier = typeof statement.source.value === 'string'
            ? statement.source.value
            : undefined;
          if (!defaultImport || !specifier || !isCssModuleSpecifier(specifier)) {
            continue;
          }

          const stylesheet = resolveStylesheet(context.physicalFilename, specifier, options);
          const extracted = stylesheet && extractClasses(stylesheet.path, options);
          if (extracted) {
            importedModules.push({
              binding: defaultImport.local,
              localClasses: extracted.localClasses,
              stylesheet: specifier,
            });
          }
        }
      },
      'Program:exit'() {
        for (const imported of importedModules) {
          const variable = importedVariable(imported.binding);
          if (!variable) {
            continue;
          }

          const usedClasses = new Set<string>();
          let usageIsDynamic = false;
          for (const reference of variable.references) {
            const classNames = referencedClassNames(reference.identifier as TSESTree.Identifier);
            if (!classNames) {
              usageIsDynamic = true;
              break;
            }
            for (const className of classNames) {
              usedClasses.add(className);
            }
          }

          if (usageIsDynamic) {
            continue;
          }

          for (const className of [...imported.localClasses].sort()) {
            const isUsed = [...propertyNamesForClass(className, options.localsConvention)]
              .some((propertyName) => usedClasses.has(propertyName));
            if (isUsed) {
              continue;
            }

            context.report({
              node: imported.binding,
              messageId: 'unusedClass',
              data: { className, stylesheet: imported.stylesheet },
            });
          }
        }
      },
    };
  },
});
