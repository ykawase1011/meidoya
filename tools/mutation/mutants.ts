import ts from "typescript";

/**
 * A single source mutation: one operator, one span, one replacement.
 *
 * Mutants are generated from the TypeScript AST rather than by regex so a
 * replacement can never land inside a string, a comment, or a type annotation.
 */
export type Mutant = {
  /**
   * Stable identity, used by the allowlist. Deliberately contains no line
   * number: an unrelated edit above a guard must not silently invalidate (or
   * silently re-target) an allowlist entry. See `docs/mutation-testing.md`.
   */
  id: string;
  /** Repository-relative POSIX path. */
  file: string;
  mutator: string;
  /** Dotted names of the enclosing declarations, for human readability. */
  scope: string;
  line: number;
  /** Exact source text being replaced. */
  original: string;
  /** Exact source text to splice in. Never truncated — this is applied. */
  replacement: string;
  /** Whitespace-collapsed, length-capped `original` — used in `id` only. */
  label: string;
  /** Byte offsets into the file text. */
  start: number;
  end: number;
};

const RELATIONAL: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.LessThanToken, ">="],
  [ts.SyntaxKind.LessThanEqualsToken, ">"],
  [ts.SyntaxKind.GreaterThanToken, "<="],
  [ts.SyntaxKind.GreaterThanEqualsToken, "<"],
]);

const EQUALITY: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="],
  [ts.SyntaxKind.EqualsEqualsToken, "!="],
  [ts.SyntaxKind.ExclamationEqualsToken, "=="],
]);

const LOGICAL: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.AmpersandAmpersandToken, "||"],
  [ts.SyntaxKind.BarBarToken, "&&"],
]);

/**
 * Zero-argument validator/narrowing calls whose removal weakens a contract
 * without changing the shape of the value for the happy path. `.strict()` on a
 * request schema is the canonical case: deleting it accepted unknown fields and
 * the entire suite stayed green.
 */
const GUARD_METHODS: ReadonlySet<string> = new Set([
  "strict",
  "strip",
  "nonempty",
  "trim",
  "readonly",
  "positive",
  "nonnegative",
  "int",
  "finite",
  "safe",
  "freeze",
]);

function normalize(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}

function declaredName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassDeclaration(node)
  ) {
    return node.name?.getText();
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (
    (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  return undefined;
}

function scopeOf(node: ts.Node): string {
  const parts: string[] = [];
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const name = declaredName(current);
    if (name !== undefined) parts.unshift(name);
  }
  return parts.length === 0 ? "<module>" : parts.join(".");
}

/**
 * Conditions that are already a bare boolean literal are skipped by the
 * force-true/force-false mutator: the BooleanLiteral mutator covers them, and
 * generating both would produce one mutant identical to the original.
 */
function isBooleanLiteral(node: ts.Node): boolean {
  return (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  );
}

export function generateMutants(file: string, sourceText: string): Mutant[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const raw: Omit<Mutant, "id">[] = [];

  const push = (
    node: ts.Node,
    mutator: string,
    start: number,
    end: number,
    replacement: string,
  ): void => {
    const { line } = source.getLineAndCharacterOfPosition(start);
    const original = sourceText.slice(start, end);
    raw.push({
      file,
      mutator,
      scope: scopeOf(node),
      line: line + 1,
      original,
      replacement,
      label: normalize(original),
      start,
      end,
    });
  };

  const forceCondition = (node: ts.Node, condition: ts.Expression): void => {
    if (isBooleanLiteral(condition)) return;
    push(node, "ConditionTrue", condition.getStart(source), condition.getEnd(), "true");
    push(node, "ConditionFalse", condition.getStart(source), condition.getEnd(), "false");
  };

  const visit = (node: ts.Node): void => {
    // Never mutate types, declarations without runtime meaning, or imports.
    if (
      ts.isTypeNode(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isImportDeclaration(node)
    ) {
      return;
    }

    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      const start = node.operatorToken.getStart(source);
      const end = node.operatorToken.getEnd();
      const relational = RELATIONAL.get(kind);
      if (relational !== undefined) push(node, "ConditionalBoundary", start, end, relational);
      const equality = EQUALITY.get(kind);
      if (equality !== undefined) push(node, "EqualityOperator", start, end, equality);
      const logical = LOGICAL.get(kind);
      if (logical !== undefined) push(node, "LogicalOperator", start, end, logical);
    }

    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    ) {
      push(
        node,
        "RemoveNegation",
        node.getStart(source),
        node.getEnd(),
        node.operand.getText(source),
      );
    }

    if (isBooleanLiteral(node)) {
      const flipped = node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true";
      push(node, "BooleanLiteral", node.getStart(source), node.getEnd(), flipped);
    }

    if (ts.isIfStatement(node)) forceCondition(node, node.expression);
    if (ts.isConditionalExpression(node)) forceCondition(node, node.condition);
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      // Forcing a loop condition true is a guaranteed hang, not a useful
      // mutant; only the terminating direction is generated.
      if (!isBooleanLiteral(node.expression)) {
        push(
          node,
          "ConditionFalse",
          node.expression.getStart(source),
          node.expression.getEnd(),
          "false",
        );
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression) &&
      GUARD_METHODS.has(node.expression.name.text)
    ) {
      push(
        node,
        "RemoveGuardCall",
        node.getStart(source),
        node.getEnd(),
        node.expression.expression.getText(source),
      );
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);

  // Assign ordinals so two textually identical mutations in the same scope get
  // distinct, order-stable ids.
  const seen = new Map<string, number>();
  return raw
    .sort((a, b) => a.start - b.start || a.mutator.localeCompare(b.mutator))
    .map((mutant) => {
      const base = `${mutant.file}:${mutant.scope}:${mutant.mutator}:${mutant.label}=>${normalize(mutant.replacement)}`;
      const ordinal = seen.get(base) ?? 0;
      seen.set(base, ordinal + 1);
      return { ...mutant, id: `${base}#${ordinal}` };
    });
}

export function applyMutant(sourceText: string, mutant: Mutant): string {
  return (
    sourceText.slice(0, mutant.start) + mutant.replacement + sourceText.slice(mutant.end)
  );
}
