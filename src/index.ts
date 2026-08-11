import { noUnknownClass } from './rules/no-unknown-class.js';
import { unresolvableStylesheet } from './rules/unresolvable-stylesheet.js';

interface CssModulesPlugin {
  meta: {
    name: string;
    version: string;
  };
  rules: {
    'no-unknown-class': typeof noUnknownClass;
    'unresolvable-stylesheet': typeof unresolvableStylesheet;
  };
  configs: {
    recommended: {
      plugins: {
        'css-modules': CssModulesPlugin;
      };
      rules: {
        'css-modules/no-unknown-class': 'error';
        'css-modules/unresolvable-stylesheet': 'error';
      };
    };
  };
}

const plugin: CssModulesPlugin = {
  meta: {
    name: 'eslint-plugin-css-modules-guard',
    version: '0.7.1',
  },
  rules: {
    'no-unknown-class': noUnknownClass,
    'unresolvable-stylesheet': unresolvableStylesheet,
  },
  configs: {} as CssModulesPlugin['configs'],
};

plugin.configs.recommended = {
  plugins: {
    'css-modules': plugin,
  },
  rules: {
    'css-modules/no-unknown-class': 'error',
    'css-modules/unresolvable-stylesheet': 'error',
  },
};

export default plugin;
export { noUnknownClass, unresolvableStylesheet };
export type { CssModulesOptions, ExtractionResult, LocalsConvention } from './core/types.js';
