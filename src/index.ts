import { noUnknownClass } from './rules/no-unknown-class.js';

interface CssModulesPlugin {
  meta: {
    name: string;
    version: string;
  };
  rules: {
    'no-unknown-class': typeof noUnknownClass;
  };
  configs: {
    recommended: {
      plugins: {
        'css-modules': CssModulesPlugin;
      };
      rules: {
        'css-modules/no-unknown-class': 'error';
      };
    };
  };
}

const plugin: CssModulesPlugin = {
  meta: {
    name: 'eslint-plugin-css-modules-real',
    version: '0.4.0',
  },
  rules: {
    'no-unknown-class': noUnknownClass,
  },
  configs: {} as CssModulesPlugin['configs'],
};

plugin.configs.recommended = {
  plugins: {
    'css-modules': plugin,
  },
  rules: {
    'css-modules/no-unknown-class': 'error',
  },
};

export default plugin;
export { noUnknownClass };
export type { CssModulesOptions, ExtractionResult, LocalsConvention } from './core/types.js';
