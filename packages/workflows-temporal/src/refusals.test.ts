import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  ERROR_CLASSIFICATION,
  NON_RETRYABLE_ERROR_TYPES,
  REFUSAL_ALIASES,
} from "./refusals.js";
import {
  DB_ACTIVITY_OPTIONS,
  MANAGER_ACTIVITY_OPTIONS,
  NOTIFICATION_ACTIVITY_OPTIONS,
  VERIFICATION_ACTIVITY_OPTIONS,
  WORKER_ACTIVITY_OPTIONS,
} from "./retry-policies.js";

/**
 * The systematic half of "a refusal must not be retried".
 *
 * Reviewing the string list one entry at a time has failed three times: each
 * round found a refusal class that existed for months while Temporal cheerfully
 * retried it. So this test does not check the list against a remembered set of
 * names — it walks the repository, finds every `Error` subclass on disk, and
 * demands that `refusals.ts` has classified it. A new refusal that nobody
 * classifies is a RED test the moment it is written, which is the only thing
 * that makes the list keep up with the code.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function sourceFiles(): string[] {
  const roots = [join(repoRoot, "packages"), join(repoRoot, "apps")];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      // `dist` is build output of these same sources; `node_modules` is other
      // people's code and not ours to classify.
      if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      // Test files invent throwaway error classes to stand in for real ones.
      if (entry.endsWith(".test.ts")) continue;
      found.push(path);
    }
  };
  for (const root of roots) walk(root);
  return found;
}

/**
 * A class that descends from `Error`.
 *
 * `thrownName` is undefined exactly when the source does not let this scanner
 * READ the thrown name — a `name` assigned from anything other than a string
 * literal, assigned twice with different literals, or inherited from a class in
 * that state. Such a class is reported as an {@link UnreadableName} and fails
 * the suite; it is never silently recorded as `"Error"`, because "the scanner could
 * not tell" and "this class throws as a bare Error" are opposite facts and the
 * second one lets an entry pin `disposition: "retry"` on a real refusal.
 */
type FoundClass = { className: string; file: string; thrownName: string | undefined };

/** A class whose thrown name (or whose base class) the scanner cannot read. */
type UnreadableName = { className: string; file: string; reason: string };

type Declared = {
  className: string;
  base: string;
  file: string;
  /** The literal `name` this class assigns, if it assigns one readably. */
  ownName: string | undefined;
  /** Why the assignment could not be read; undefined when it could. */
  unreadable: string | undefined;
};

/** Bases that make a class an error even though nothing in the repo declares them. */
const INTRINSIC_ERROR_BASES: Readonly<Record<string, string>> = {
  Error: "Error",
  TypeError: "TypeError",
  RangeError: "RangeError",
  SyntaxError: "SyntaxError",
  ReferenceError: "ReferenceError",
  EvalError: "EvalError",
  URIError: "URIError",
  AggregateError: "AggregateError",
};

/** The identifier a class extends, or a marker the caller must treat as opaque. */
function heritageName(node: ts.ClassLikeDeclaration, source: ts.SourceFile): string {
  const clause = node.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = clause?.types[0]?.expression;
  if (expression === undefined) return "";
  if (ts.isIdentifier(expression)) return expression.text;
  // `extends Foo.Bar` — the class is `Bar` as far as a name lookup goes.
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  // `extends mixin(Error)` and friends: unresolvable, so say so rather than
  // silently deciding this is not an error class.
  return `?${expression.getText(source).replace(/\s+/g, " ")}`;
}

/** The name a class expression / declaration is known by. */
function classNameOf(node: ts.ClassLikeDeclaration, source: ts.SourceFile): string {
  if (node.name !== undefined) return node.name.text;
  const parent: ts.Node | undefined = node.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    parent !== undefined &&
    (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
  ) {
    return parent.name.text;
  }
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `<anonymous class at ${source.fileName}:${line + 1}>`;
}

function isNameKey(name: ts.PropertyName): boolean {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === "name";
  return false;
}

/** Unwraps `("X" as const)` / `("X" satisfies string)` down to the literal. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

type NameAssignment = { value: string } | { unreadable: string };

function readNameInitialiser(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
): NameAssignment | undefined {
  if (expression === undefined) return undefined;
  const inner = unwrap(expression);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return { value: inner.text };
  }
  return {
    unreadable: `name is assigned from \`${inner.getText(source).replace(/\s+/g, " ")}\`, which is not a string literal`,
  };
}

/**
 * Every assignment to the INSTANCE `name` inside one class body: the
 * `name = "X"` field (with any modifier order — `public override readonly` is
 * one spelling of many) and `this.name = "X"` anywhere in the class's own code.
 * Nested class bodies are skipped: their `this` is not this class's.
 */
function nameAssignments(node: ts.ClassLikeDeclaration, source: ts.SourceFile): NameAssignment[] {
  const found: NameAssignment[] = [];
  for (const member of node.members) {
    const isStatic = ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static;
    if (isStatic) continue; // `static name` shadows Function.name, not the instance's.
    if (ts.isPropertyDeclaration(member) && isNameKey(member.name)) {
      const read = readNameInitialiser(member.initializer, source);
      if (read !== undefined) found.push(read);
    }
  }

  const visit = (child: ts.Node): void => {
    if (ts.isClassLike(child) && child !== node) return;
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(child.left) &&
      child.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      child.left.name.text === "name"
    ) {
      const read = readNameInitialiser(child.right, source);
      if (read !== undefined) found.push(read);
    }
    ts.forEachChild(child, visit);
  };
  for (const member of node.members) visit(member);
  return found;
}

/**
 * Every class in the tree that descends from `Error`, with the `name` a thrown
 * instance carries.
 *
 * Parsed with the TypeScript compiler API rather than line regexes, because the
 * regexes had three blind spots a reviewer turned into a GREEN test pinning the
 * wrong classification:
 *
 *  - `export const X = class extends Error {}` was invisible, so the
 *    completeness guard never fired for it at all;
 *  - `this.name = SOME_CONST` was scanned as `"Error"`, so the registry could
 *    record a real refusal as an unnamed, therefore necessarily retryable,
 *    error — and the tests below then ENFORCED that;
 *  - `public override readonly name = "X"` matched no assignment spelling, with
 *    the same consequence.
 *
 * Both assignment spellings count — `this.name = "X"` in a constructor and the
 * `name = "X"` class field under any modifiers — and a class that assigns
 * neither inherits its base's. Subclass chains are followed to a fixpoint across
 * packages: `ChatRateLimitError extends ChatTransportError` is an error class
 * too, and a scan that only matched `extends Error` would have skipped it.
 */
function scanErrorClasses(): { classes: FoundClass[]; unreadable: UnreadableName[] } {
  const declared: Declared[] = [];

  for (const file of sourceFiles()) {
    const relativePath = relative(repoRoot, file).split("\\").join("/");
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const assignments = nameAssignments(node, source);
        const broken = assignments.find((a) => "unreadable" in a);
        const literals = [...new Set(assignments.flatMap((a) => ("value" in a ? [a.value] : [])))];
        declared.push({
          className: classNameOf(node, source),
          base: heritageName(node, source),
          file: relativePath,
          ownName: broken === undefined ? literals[0] : undefined,
          unreadable:
            broken !== undefined
              ? broken.unreadable
              : literals.length > 1
                ? `name is assigned more than once (${literals.map((l) => `"${l}"`).join(", ")}); the scanner cannot say which wins`
                : undefined,
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  const resolved = new Map<string, FoundClass & { unreadable: string | undefined }>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const candidate of declared) {
      if (resolved.has(candidate.className)) continue;
      const intrinsic = INTRINSIC_ERROR_BASES[candidate.base];
      const parent = resolved.get(candidate.base);
      if (intrinsic === undefined && parent === undefined) continue;
      const inheritedName = intrinsic ?? parent?.thrownName;
      const inheritedProblem =
        parent !== undefined && parent.unreadable !== undefined
          ? `inherits its name from ${candidate.base}, whose own name cannot be read: ${parent.unreadable}`
          : undefined;
      const unreadable = candidate.unreadable ?? (candidate.ownName === undefined ? inheritedProblem : undefined);
      resolved.set(candidate.className, {
        className: candidate.className,
        file: candidate.file,
        // A subclass that assigns no name inherits its parent's, not "Error".
        thrownName: unreadable !== undefined ? undefined : (candidate.ownName ?? inheritedName),
        unreadable,
      });
      changed = true;
    }
  }

  const unreadable: UnreadableName[] = [];
  for (const entry of resolved.values()) {
    if (entry.unreadable !== undefined) {
      unreadable.push({ className: entry.className, file: entry.file, reason: entry.unreadable });
    }
  }
  // A base expression the parser cannot resolve to a name (`extends mixin(Error)`)
  // would silently drop the whole subtree out of the scan.
  for (const candidate of declared) {
    if (!candidate.base.startsWith("?")) continue;
    unreadable.push({
      className: candidate.className,
      file: candidate.file,
      reason: `extends \`${candidate.base.slice(1)}\`, which the scanner cannot resolve to a class name`,
    });
  }

  return {
    classes: [...resolved.values()].map(({ className, file, thrownName }) => ({
      className,
      file,
      thrownName,
    })),
    unreadable,
  };
}

describe("the refusal registry", () => {
  const { classes: scanned, unreadable } = scanErrorClasses();

  /**
   * The scanner's own honesty check, and the reason the rest of this file can be
   * trusted at all.
   *
   * A class whose `name` comes from a const, from a template with a
   * substitution, or from a base class in the same state, USED to be recorded as
   * `"Error"`. The completeness guard then demanded an entry, this file's second
   * test demanded `thrownName: "Error"`, and the third demanded
   * `disposition: "retry"` — three green tests pinning "retry a refusal" for a
   * class that throws under a perfectly matchable name. So an unreadable name is
   * a failure of THIS suite, not a value it guesses.
   */
  it("can read every error class's thrown name from its source", () => {
    expect(
      unreadable.map((u) => `${u.className} (${u.file}): ${u.reason}`),
      "assign `name` from a string literal so Temporal's nonRetryableErrorTypes can be checked against it",
    ).toEqual([]);
  });

  /**
   * The completeness guard. This is the assertion that makes the whole file
   * worth having: add an `Error` subclass anywhere in the repository without
   * saying how Temporal should treat it, and this goes red naming the class.
   */
  it("classifies every Error subclass in the repository", () => {
    const onDisk = scanned.map((c) => c.className).sort();
    const classified = Object.keys(ERROR_CLASSIFICATION).sort();
    const unclassified = onDisk.filter((name) => !classified.includes(name));
    const stale = classified.filter((name) => !onDisk.includes(name));
    expect(
      unclassified,
      "these error classes exist but refusals.ts does not say whether Temporal may retry them",
    ).toEqual([]);
    expect(stale, "these classified error classes no longer exist").toEqual([]);
  });

  it("records each class's thrown name as the source actually assigns it", () => {
    for (const { className, file, thrownName } of scanned) {
      const entry = ERROR_CLASSIFICATION[className];
      if (!entry) continue; // reported by the completeness test above
      // Unreadable is reported by the honesty test above and must NOT be
      // asserted here: asserting anything about a name the scanner could not
      // read is how a wrong classification got pinned green.
      if (thrownName === undefined) continue;
      expect(entry.thrownName, `${className} (${file}) throws as "${thrownName}"`).toBe(thrownName);
      expect(entry.file, `${className} moved`).toBe(file);
    }
  });

  it("never classifies an unnamed error as a refusal", () => {
    // A refusal is listed under BOTH spellings (see `NON_RETRYABLE_ERROR_TYPES`),
    // and the bare "Error" is one no list may contain: it would make every plain
    // failure in the system non-retryable. A class that wants to be a refusal
    // has to say what it is called.
    for (const [className, entry] of Object.entries(ERROR_CLASSIFICATION)) {
      if (entry.thrownName !== "Error") continue;
      expect(entry.disposition, `${className} has no distinguishable type`).toBe("retry");
    }
  });

  it("never lists the bare Error type", () => {
    expect(
      NON_RETRYABLE_ERROR_TYPES,
      "listing \"Error\" makes every plain failure in the system non-retryable",
    ).not.toContain("Error");
  });

  /**
   * BOTH spellings of every refusal, because the one that actually matches is
   * the CLASS name: `ensureApplicationFailure` builds the failure type as
   * `error.constructor?.name ?? error.name`. Listing only `thrownName` left the
   * three `PolicyViolation`-named refusals retried to exhaustion with this whole
   * file green — `refusals-runtime.test.ts` catches that against a real server,
   * and this catches it here, where the reason is written down.
   */
  it("lists every refusal under both spellings, and nothing that must stay retryable", () => {
    for (const [className, entry] of Object.entries(ERROR_CLASSIFICATION)) {
      if (entry.disposition === "refusal") {
        expect(
          NON_RETRYABLE_ERROR_TYPES,
          `${className} is a refusal, and Temporal matches it by its CLASS name`,
        ).toContain(className);
        expect(
          NON_RETRYABLE_ERROR_TYPES,
          `${className} is a refusal and would be retried when a peer raises it by name`,
        ).toContain(entry.thrownName);
      } else {
        expect(
          NON_RETRYABLE_ERROR_TYPES,
          `${className} is retryable but the list refuses to retry it`,
        ).not.toContain(entry.thrownName);
        expect(
          NON_RETRYABLE_ERROR_TYPES,
          `${className} is retryable but the list refuses to retry its class name`,
        ).not.toContain(className);
      }
    }
    for (const alias of REFUSAL_ALIASES) {
      expect(NON_RETRYABLE_ERROR_TYPES).toContain(alias);
    }
  });

  /**
   * Every option set, not merely the long-running ones.
   *
   * `DB_ACTIVITY_OPTIONS` carried no `nonRetryableErrorTypes` at all, and it is
   * the set that proxies `db.chargeBudget` / `db.extendBudget` — the two
   * activities that raise `BudgetSnapshotUnreadableError`. A refusal is not a
   * property of how long an activity runs, so no set gets to opt out.
   */
  it("is declared by every activity option set", () => {
    const all = {
      DB_ACTIVITY_OPTIONS,
      NOTIFICATION_ACTIVITY_OPTIONS,
      MANAGER_ACTIVITY_OPTIONS,
      WORKER_ACTIVITY_OPTIONS,
      VERIFICATION_ACTIVITY_OPTIONS,
    };
    for (const [name, options] of Object.entries(all)) {
      const declared = options.retry?.nonRetryableErrorTypes ?? [];
      for (const type of NON_RETRYABLE_ERROR_TYPES) {
        expect(declared, `${name} would retry a ${type}`).toContain(type);
      }
    }
  });
});
