import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

import { extractClasses } from '../core/extractor.js';
import { normalizeOptions } from '../core/options.js';
import { isCssModuleSpecifier, resolveStylesheet } from '../core/resolver.js';
import { cssModulesOptionsSchema } from '../core/schema.js';
import type { CssModulesOptions } from '../core/types.js';

type Options = readonly [CssModulesOptions?];
type MessageIds = 'unresolvableStylesheet';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://www.npmjs.com/package/eslint-plugin-css-modules-guard#rule-css-modules${name}`,
);

export const unresolvableStylesheet = createRule<Options, MessageIds>({
  name: 'unresolvable-stylesheet',
  meta: {
    type: 'problem',
    docs: {
      description: 'Require CSS Modules to resolve and compile before use.',
    },
    schema: cssModulesOptionsSchema,
    messages: {
      unresolvableStylesheet: 'Unable to {{action}} CSS Module "{{stylesheet}}".',
    },
  },
  defaultOptions: [{}],
  create(context) {
    const options = normalizeOptions(context.options[0], context.cwd);

    return {
      Program(program) {
        for (const statement of program.body) {
          if (statement.type !== TSESTree.AST_NODE_TYPES.ImportDeclaration) {
            continue;
          }

          const hasDefaultImport = statement.specifiers.some(
            (specifier) => specifier.type === TSESTree.AST_NODE_TYPES.ImportDefaultSpecifier,
          );
          const specifier = statement.source.value;
          if (!hasDefaultImport || !isCssModuleSpecifier(specifier)) {
            continue;
          }

          const stylesheet = resolveStylesheet(context.physicalFilename, specifier, options);
          if (stylesheet && extractClasses(stylesheet.path, options)) {
            continue;
          }

          context.report({
            node: statement.source,
            messageId: 'unresolvableStylesheet',
            data: {
              action: stylesheet ? 'compile' : 'resolve',
              stylesheet: specifier,
            },
          });
        }
      },
    };
  },
});
