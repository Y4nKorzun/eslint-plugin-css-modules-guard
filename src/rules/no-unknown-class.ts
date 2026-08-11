import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

import { extractClasses } from '../core/extractor.js';
import { normalizeOptions } from '../core/options.js';
import { isCssModuleSpecifier, resolveStylesheet } from '../core/resolver.js';
import type { CssModulesOptions, ExtractionResult } from '../core/types.js';

type Options = readonly [CssModulesOptions?];
type MessageIds = 'suggestedClass' | 'unknownClass';

interface ImportedModule {
  binding: TSESTree.Identifier;
  classes: ExtractionResult;
  stylesheet: string;
}

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://www.npmjs.com/package/eslint-plugin-css-modules-guard#rule-css-modules${name}`,
);

function staticPropertyName(node: TSESTree.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === TSESTree.AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }

  if (
    node.computed &&
    node.property.type === TSESTree.AST_NODE_TYPES.Literal &&
    typeof node.property.value === 'string'
  ) {
    return node.property.value;
  }

  if (
    node.computed &&
    node.property.type === TSESTree.AST_NODE_TYPES.TemplateLiteral &&
    node.property.expressions.length === 0
  ) {
    return node.property.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
  }

  return undefined;
}

function boundedDistance(left: string, right: string, threshold: number): number {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);

  if (
    leftCharacters.length > 256 ||
    rightCharacters.length > 256 ||
    Math.abs(leftCharacters.length - rightCharacters.length) > threshold
  ) {
    return threshold + 1;
  }

  let previous = Array.from({ length: rightCharacters.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= leftCharacters.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;

    for (let rightIndex = 1; rightIndex <= rightCharacters.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]! +
        (leftCharacters[leftIndex - 1] === rightCharacters[rightIndex - 1] ? 0 : 1);
      const insertion = current[rightIndex - 1]! + 1;
      const deletion = previous[rightIndex]! + 1;
      const distance = Math.min(substitution, insertion, deletion);
      current.push(distance);
      rowMinimum = Math.min(rowMinimum, distance);
    }

    if (rowMinimum > threshold) {
      return threshold + 1;
    }

    previous = current;
  }

  return previous[rightCharacters.length]!;
}

function nearestMatch(
  requested: string,
  candidates: ReadonlySet<string>,
  threshold: number,
): string | undefined {
  if (candidates.size > 5_000) {
    return undefined;
  }

  let nearest: string | undefined;
  let nearestDistance = threshold + 1;

  for (const candidate of candidates) {
    const distance = boundedDistance(
      requested,
      candidate,
      Math.min(threshold, Math.max(0, nearestDistance - 1)),
    );
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }

  }

  return nearest;
}

function suggestedAccess(binding: string, className: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(className)
    ? `${binding}.${className}`
    : `${binding}[${JSON.stringify(className)}]`;
}

export const noUnknownClass = createRule<Options, MessageIds>({
  name: 'no-unknown-class',
  meta: {
    type: 'problem',
    hasSuggestions: true,
    docs: {
      description: 'Require CSS Module properties to exist in the source stylesheet.',
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
        },
      },
    ],
    messages: {
      suggestedClass: 'Replace with "{{suggestion}}".',
      unknownClass: 'Unknown CSS Module class "{{className}}" in "{{stylesheet}}".{{suggestion}}',
    },
  },
  defaultOptions: [{}],
  create(context) {
    const options = normalizeOptions(context.options[0], context.cwd);
    const importedModules = new Map<string, ImportedModule>();

    const hasImportedBinding = (
      node: TSESTree.MemberExpression,
      imported: ImportedModule,
    ): boolean => {
      let scope: ReturnType<typeof context.sourceCode.getScope> | null =
        context.sourceCode.getScope(node);

      while (scope) {
        const variable = scope.set.get(imported.binding.name);
        if (variable) {
          return variable.identifiers.includes(imported.binding);
        }
        scope = scope.upper;
      }

      return false;
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
          const classes = stylesheet && extractClasses(stylesheet.path, options);
          if (classes) {
            importedModules.set(defaultImport.local.name, {
              binding: defaultImport.local,
              classes,
              stylesheet: specifier,
            });
          }
        }
      },
      MemberExpression(node) {
        if (node.object.type !== TSESTree.AST_NODE_TYPES.Identifier) {
          return;
        }

        const imported = importedModules.get(node.object.name);
        const className = staticPropertyName(node);
        if (!imported || !className || !hasImportedBinding(node, imported)) {
          return;
        }

        if (imported.classes.classes.has(className)) {
          return;
        }

        const suggestedClass = nearestMatch(className, imported.classes.classes, options.suggestThreshold);
        const suggested = suggestedClass && suggestedAccess(imported.binding.name, suggestedClass);
        context.report({
          node,
          messageId: 'unknownClass',
          data: {
            className,
            stylesheet: imported.stylesheet,
            suggestion: suggested
              ? ` Did you mean ${suggested}?`
              : '',
          },
          suggest: suggested
            ? [{
                messageId: 'suggestedClass',
                data: { suggestion: suggested },
                fix(fixer) {
                  return fixer.replaceText(node, suggested);
                },
              }]
            : null,
        });
      },
    };
  },
});
