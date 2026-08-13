import { TSESTree } from '@typescript-eslint/utils';

import { extractClasses, stylesheetLanguage } from '../core/extractor.js';
import { isLessAvailable } from '../core/less-compiler.js';
import { normalizeOptions } from '../core/options.js';
import {
  isCssModuleSpecifier,
  needsTypeScriptForAliases,
  resolveStylesheet,
} from '../core/resolver.js';
import { isSassAvailable } from '../core/sass-compiler.js';
import { cssModulesOptionsSchema } from '../core/schema.js';
import { createRule } from './create-rule.js';
import type { CssModulesOptions } from '../core/types.js';

type Options = readonly [CssModulesOptions?];
type MessageIds =
  | 'missingLessCompiler'
  | 'missingSassCompiler'
  | 'missingTypeScript'
  | 'unresolvableStylesheet';

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
      missingSassCompiler:
        'Unable to compile CSS Module "{{stylesheet}}". Install the optional peer dependency "sass" (1.45.0 or newer) to lint .module.scss and .module.sass files.',
      missingTypeScript:
        'Unable to resolve CSS Module "{{stylesheet}}". Install the optional peer dependency "typescript" to read aliases from tsconfig.json, or map this one with the "aliases" option.',
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

          // A genuine compile error still gets the generic message; only an absent compiler earns
          // the install hint. `.module.css` needs no compiler and never reaches either branch.
          const language = stylesheet ? stylesheetLanguage(stylesheet.path) : undefined;
          if (language === 'less' && !isLessAvailable()) {
            context.report({
              node: statement.source,
              messageId: 'missingLessCompiler',
              data: { stylesheet: specifier },
            });
            continue;
          }

          if (language === 'sass' && !isSassAvailable()) {
            context.report({
              node: statement.source,
              messageId: 'missingSassCompiler',
              data: { stylesheet: specifier },
            });
            continue;
          }

          // An alias-shaped specifier that did not resolve, next to a tsconfig nobody could read,
          // is almost always the missing parser rather than a missing file.
          if (
            !stylesheet &&
            !specifier.startsWith('.') &&
            needsTypeScriptForAliases(context.physicalFilename, options.rootDir)
          ) {
            context.report({
              node: statement.source,
              messageId: 'missingTypeScript',
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
