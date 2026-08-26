/**
 * Quality gates: the operator-authored allowlist of verification commands.
 *
 * 10 section 2 (execution nodes and security): an agent-authored plan must never
 * be able to choose *what* runs, only *which* of the operator's configured
 * quality gates to run. The workspace policy (`quality_gates.commands` in
 * workflow-policy.yaml) is the sole authority for the argv that reaches spawn;
 * a plan carries a gate NAME and nothing else.
 */

/** One configured gate. `argv[0]` is the executable; nothing is shell-interpreted. */
export type QualityGateCommand = {
  readonly name: string;
  readonly argv: readonly string[];
};

export type QualityGateCatalog = readonly QualityGateCommand[];

/**
 * The legacy built-in catalog, used ONLY by `validatePlan` when a caller hands
 * it no workspace catalog. It is deliberately NOT a runtime fallback: nothing
 * spawns from it. An execution node refuses every argv here twice over — `npm`
 * is not an absolute path, so the gate's PATH would decide what runs, and it
 * matches no entry in any node's own `quality_gates:` allowlist — and a
 * workspace that configures no catalog pauses its task with
 * `no-quality-gate-catalog` rather than reaching for this. The shipped examples
 * (docs/design/config.example.yaml, node.example.yaml,
 * workflow-policy.example.yaml) name absolute binaries and no longer mirror it.
 */
export const DEFAULT_QUALITY_GATES: QualityGateCatalog = Object.freeze([
  Object.freeze({ name: "test", argv: Object.freeze(["npm", "test"]) }),
  Object.freeze({ name: "lint", argv: Object.freeze(["npm", "run", "lint"]) }),
  Object.freeze({ name: "typecheck", argv: Object.freeze(["npm", "run", "typecheck"]) }),
]) as QualityGateCatalog;

/** A single name segment: no whitespace, no shell metacharacters, no path parts. */
const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
/** `gate` or `group:gate` — the optional prefix only groups results (05 section 7). */
export const QUALITY_GATE_SELECTOR_PATTERN = new RegExp(`^${SEGMENT}(:${SEGMENT})?$`);

/** Characters that would be meaningful to a shell. Present only as a tripwire. */
const SHELL_METACHARACTERS = /[;&|<>$`"'\\\n\r*?(){}[\]!#~]/;

export function isQualityGateSelector(name: string): boolean {
  return QUALITY_GATE_SELECTOR_PATTERN.test(name);
}

/** `quality:test` selects the gate named `test`; the prefix is only a group label. */
export function gateKeyOf(selector: string): string {
  const sep = selector.lastIndexOf(":");
  return sep > 0 ? selector.slice(sep + 1) : selector;
}

export type QualityGateResolution =
  | { ok: true; gate: QualityGateCommand }
  | { ok: false; reason: "invalid-selector" | "not-allowlisted" };

/**
 * Resolve a plan-supplied selector against the operator's catalog. This is the
 * ONLY way an argv is produced; nothing derived from agent text is executed.
 */
export function resolveQualityGate(
  catalog: QualityGateCatalog,
  selector: string,
): QualityGateResolution {
  if (!isQualityGateSelector(selector)) return { ok: false, reason: "invalid-selector" };
  const key = gateKeyOf(selector);
  const gate = catalog.find((c) => c.name === key);
  if (gate === undefined || gate.argv.length === 0) {
    return { ok: false, reason: "not-allowlisted" };
  }
  return { ok: true, gate };
}

export class QualityGateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityGateConfigError";
  }
}

/**
 * Parse one operator-configured `command:` line into a fixed argv.
 *
 * Operator config is trusted, but it is still parsed strictly so a gate can
 * never smuggle shell syntax into a runner that has no shell: anything that
 * would need `/bin/sh` to mean what it looks like is rejected at config load.
 */
export function parseQualityGateCommand(name: string, commandLine: string): QualityGateCommand {
  if (!isQualityGateSelector(name)) {
    throw new QualityGateConfigError(`quality gate name ${JSON.stringify(name)} is not a plain name`);
  }
  if (SHELL_METACHARACTERS.test(commandLine)) {
    throw new QualityGateConfigError(
      `quality gate ${name}: command must be a plain "program args..." line without shell syntax`,
    );
  }
  const argv = commandLine.trim().split(/\s+/u).filter((part) => part.length > 0);
  if (argv.length === 0) {
    throw new QualityGateConfigError(`quality gate ${name}: command is empty`);
  }
  return { name: gateKeyOf(name), argv: Object.freeze(argv) };
}

export function parseQualityGateCatalog(
  entries: readonly { name: string; command: string }[],
): QualityGateCatalog {
  const catalog: QualityGateCommand[] = [];
  for (const entry of entries) {
    const gate = parseQualityGateCommand(entry.name, entry.command);
    if (catalog.some((c) => c.name === gate.name)) {
      throw new QualityGateConfigError(`duplicate quality gate ${gate.name}`);
    }
    catalog.push(gate);
  }
  return Object.freeze(catalog);
}
