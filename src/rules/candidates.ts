import { TSESTree } from '@typescript-eslint/utils';
import type { TSESLint } from '@typescript-eslint/utils';

import {
  concatenateCandidates,
  MAX_CANDIDATE_DEPTH,
  unionCandidates,
} from '../core/candidates.js';

type GetScope = (node: TSESTree.Node) => TSESLint.Scope.Scope;
type PropertyKey = TSESTree.MemberExpression['property'] | TSESTree.Property['key'];

function variableInitializer(
  node: TSESTree.Identifier,
  getScope: GetScope,
): TSESTree.Expression | undefined {
  let scope: TSESLint.Scope.Scope | null = getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      const definition = variable.defs.length === 1 ? variable.defs[0] : undefined;
      if (
        definition?.type !== 'Variable' ||
        definition.parent.kind !== 'const' ||
        definition.name !== definition.node.id ||
        !definition.node.init ||
        variable.references.some((reference) => reference.isWrite() && !reference.init)
      ) {
        return undefined;
      }
      return definition.node.init;
    }
    scope = scope.upper;
  }
  return undefined;
}

function expressionCandidates(
  node: TSESTree.Expression,
  getScope: GetScope,
  seen: Set<TSESTree.Node>,
  depth: number,
): Set<string> | undefined {
  if (depth > MAX_CANDIDATE_DEPTH) {
    return undefined;
  }

  switch (node.type) {
    case TSESTree.AST_NODE_TYPES.Literal:
      return typeof node.value === 'string' ? new Set([node.value]) : undefined;
    case TSESTree.AST_NODE_TYPES.Identifier: {
      const initializer = variableInitializer(node, getScope);
      if (!initializer || seen.has(initializer)) {
        return undefined;
      }
      const nextSeen = new Set(seen).add(initializer);
      return expressionCandidates(initializer, getScope, nextSeen, depth + 1);
    }
    case TSESTree.AST_NODE_TYPES.ConditionalExpression: {
      const consequent = expressionCandidates(node.consequent, getScope, seen, depth + 1);
      const alternate = expressionCandidates(node.alternate, getScope, seen, depth + 1);
      return consequent && alternate ? unionCandidates(consequent, alternate) : undefined;
    }
    case TSESTree.AST_NODE_TYPES.BinaryExpression: {
      if (node.operator !== '+') {
        return undefined;
      }
      const left = expressionCandidates(node.left, getScope, seen, depth + 1);
      const right = expressionCandidates(node.right, getScope, seen, depth + 1);
      return left && right ? concatenateCandidates(left, right) : undefined;
    }
    case TSESTree.AST_NODE_TYPES.TemplateLiteral: {
      let result: Set<string> | undefined = new Set([
        node.quasis[0]!.value.cooked ?? node.quasis[0]!.value.raw,
      ]);
      for (let index = 0; index < node.expressions.length; index += 1) {
        const expression = expressionCandidates(
          node.expressions[index]!,
          getScope,
          seen,
          depth + 1,
        );
        if (!result || !expression) {
          return undefined;
        }
        result = concatenateCandidates(result, expression);
        if (!result) {
          return undefined;
        }
        result = concatenateCandidates(result, new Set([
          node.quasis[index + 1]!.value.cooked ?? node.quasis[index + 1]!.value.raw,
        ]));
      }
      return result;
    }
    case TSESTree.AST_NODE_TYPES.TSAsExpression:
    case TSESTree.AST_NODE_TYPES.TSNonNullExpression:
    case TSESTree.AST_NODE_TYPES.TSTypeAssertion:
      return expressionCandidates(node.expression, getScope, seen, depth + 1);
    default:
      return undefined;
  }
}

export function propertyCandidates(
  property: PropertyKey,
  computed: boolean,
  getScope: GetScope,
): ReadonlySet<string> | undefined {
  if (!computed && property.type === TSESTree.AST_NODE_TYPES.Identifier) {
    return new Set([property.name]);
  }

  if (
    property.type === TSESTree.AST_NODE_TYPES.Literal &&
    typeof property.value === 'string'
  ) {
    return new Set([property.value]);
  }

  if (!computed || property.type === TSESTree.AST_NODE_TYPES.PrivateIdentifier) {
    return undefined;
  }

  return expressionCandidates(property, getScope, new Set([property]), 0);
}
