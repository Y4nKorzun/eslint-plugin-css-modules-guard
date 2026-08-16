import type ts from 'typescript';

import {
  concatenateCandidates,
  MAX_CANDIDATE_DEPTH,
  unionCandidates,
} from './candidates.js';
import type { TypeScriptModule } from './typescript-loader.js';

function variableInitializer(
  typescript: TypeScriptModule,
  checker: ts.TypeChecker,
  node: ts.Identifier,
): ts.Expression | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol?.declarations?.length === 1 ? symbol.declarations[0] : undefined;
  if (
    !declaration ||
    !typescript.isVariableDeclaration(declaration) ||
    !typescript.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    (declaration.parent.flags & typescript.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  return declaration.initializer;
}

function expressionCandidates(
  typescript: TypeScriptModule,
  checker: ts.TypeChecker,
  node: ts.Expression,
  seen: Set<ts.Node>,
  depth: number,
): Set<string> | undefined {
  if (depth > MAX_CANDIDATE_DEPTH) {
    return undefined;
  }

  if (typescript.isStringLiteral(node) || typescript.isNoSubstitutionTemplateLiteral(node)) {
    return new Set([node.text]);
  }

  if (typescript.isIdentifier(node)) {
    const initializer = variableInitializer(typescript, checker, node);
    if (!initializer || seen.has(initializer)) {
      return undefined;
    }
    return expressionCandidates(
      typescript,
      checker,
      initializer,
      new Set(seen).add(initializer),
      depth + 1,
    );
  }

  if (typescript.isConditionalExpression(node)) {
    const consequent = expressionCandidates(
      typescript,
      checker,
      node.whenTrue,
      seen,
      depth + 1,
    );
    const alternate = expressionCandidates(
      typescript,
      checker,
      node.whenFalse,
      seen,
      depth + 1,
    );
    return consequent && alternate ? unionCandidates(consequent, alternate) : undefined;
  }

  if (typescript.isBinaryExpression(node)) {
    if (node.operatorToken.kind !== typescript.SyntaxKind.PlusToken) {
      return undefined;
    }
    const left = expressionCandidates(typescript, checker, node.left, seen, depth + 1);
    const right = expressionCandidates(typescript, checker, node.right, seen, depth + 1);
    return left && right ? concatenateCandidates(left, right) : undefined;
  }

  if (typescript.isTemplateExpression(node)) {
    let result: Set<string> | undefined = new Set([node.head.text]);
    for (const span of node.templateSpans) {
      const expression = expressionCandidates(
        typescript,
        checker,
        span.expression,
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
      result = concatenateCandidates(result, new Set([span.literal.text]));
    }
    return result;
  }

  if (
    typescript.isParenthesizedExpression(node) ||
    typescript.isAsExpression(node) ||
    typescript.isTypeAssertionExpression(node) ||
    typescript.isNonNullExpression(node)
  ) {
    return expressionCandidates(typescript, checker, node.expression, seen, depth + 1);
  }

  return undefined;
}

export function typescriptExpressionCandidates(
  typescript: TypeScriptModule,
  checker: ts.TypeChecker,
  node: ts.Expression,
): ReadonlySet<string> | undefined {
  return expressionCandidates(typescript, checker, node, new Set([node]), 0);
}
