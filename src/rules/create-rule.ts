import { ESLintUtils } from '@typescript-eslint/utils';

/**
 * Editors turn `meta.docs.url` into the "open documentation" link on a report, so it has to point
 * at a page that actually exists. Kept in one place: three copies of the same template is how the
 * previous URL drifted into an anchor no README ever had.
 */
export const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/Y4nKorzun/eslint-plugin-css-modules-guard/blob/main/docs/rules/${name}.md`,
);
