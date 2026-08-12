import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

import { extractClasses, stylesheetLanguage } from '../core/extractor.js';
import { isLessAvailable } from '../core/less-compiler.js';
import { normalizeOptions } from '../core/options.js';
import { isCssModuleSpecifier, resolveStylesheet } from '../core/resolver.js';
import { cssModulesOptionsSchema } from '../core/schema.js';
import type { CssModulesOptions } from '../core/types.js';

type Options = readonly [CssModulesOptions?];
type MessageIds = 'unresolvableStylesheet' | 'missingLessCompiler';

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
      missingLessCompiler:
        'Unable to compile CSS Module "{{stylesheet}}". Install the optional peer dependency "less" to lint .module.less files.',
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

          // A genuine Less compile error still gets the generic message; only an absent compiler
          // earns the install hint.
          if (stylesheet && stylesheetLanguage(stylesheet.path) === 'less' && !isLessAvailable()) {
            context.report({
              node: statement.source,
              messageId: 'missingLessCompiler',
              data: { stylesheet: specifier },
            });
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
