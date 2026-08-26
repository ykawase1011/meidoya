import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CREDENTIAL_ENV_KEYS,
  createVerificationCommandRunner,
  minimalEnv,
  redirectEnvKeysIn,
} from "@meidoya/agent-runtime";
import {
  confineGateArgv,
  planGateConfinement,
  type FilesystemSandbox,
  type GateConfinementPlan,
} from "@meidoya/execution-native";
import type { NodeProfile } from "@meidoya/node-protocol";
import type {
  ArtifactProbePort,
  CommandExecution,
  CommandRunnerPort,
  CommandSpec,
  QualityGateCatalog,
  QualityGateCommand,
} from "@meidoya/task-engine";
import { gateKeyOf, isQualityGateSelector, runVerification } from "@meidoya/task-engine";
import type { VerificationResult } from "@meidoya/task-engine";
import type { VerificationPlan } from "@meidoya/domain";

/**
 * Refusal of a verification request whose inputs are not something this node is
 * allowed to act on. Named `PolicyViolation` so Temporal's non-retryable list
 * (see `retry-policies.ts`) can recognise it: retrying a refusal is pointless
 * and hides it.
 */
export class VerificationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

/**
 * Default wall clock for one gate.
 *
 * Deliberately BELOW `VERIFICATION_ACTIVITY_OPTIONS.startToCloseTimeout`
 * (30 minutes). When the two were equal the activity's timeout and the gate's
 * raced, and Temporal normally won: a slow gate produced an activity timeout
 * and a retry instead of the `124` verdict the verification result is supposed
 * to carry, so the operator saw "the node stopped answering" rather than "your
 * test suite does not finish". The gate must lose that race on purpose, with
 * enough margin to report the verdict.
 */
export const DEFAULT_GATE_TIMEOUT_MS = 25 * 60_000;

/**
 * A quality gate's private HOME/TMPDIR, created per verification run.
 *
 * `control` holds the generated sandbox profile and is NOT writable by the
 * gate; `home` is. They are separate directories on purpose: a verification
 * runs several gates through one runner, and a gate that could rewrite the
 * profile file would be choosing the confinement of the gates that follow it.
 */
export type GateScratch = {
  readonly control: string;
  readonly home: string;
  readonly profilePath: string;
  dispose(): void;
};

export function createGateScratch(tmpRoot: string = os.tmpdir()): GateScratch {
  const control = mkdtempSync(path.join(tmpRoot, "meidoya-gate-"));
  const home = path.join(control, "home");
  mkdirSync(home, { mode: 0o700 });
  return {
    control,
    home,
    profilePath: path.join(control, "gate.sb"),
    dispose(): void {
      rmSync(control, { recursive: true, force: true });
    },
  };
}

/**
 * Environment for a quality gate: `minimalEnv()` plus whatever the node
 * OPERATOR named, minus every credential key, always, and with HOME and TMPDIR
 * pointed at a scratch directory that belongs to this run alone.
 *
 * WHY HOME IS REPLACED RATHER THAN COPIED. `minimalEnv` copies `HOME` because a
 * child with no home is barely a process — but the node operator's home is
 * where `10 section 9`'s materialized credentials LIVE:
 * `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.netrc`, `~/.ssh`.
 * Stripping `ANTHROPIC_API_KEY` from the environment while handing the same
 * child a `HOME` that contains the OAuth token it stands for bought nothing:
 * measured end to end through `createNodeVerificationActivity`, a gate reported
 * `ANTHROPIC_API_KEY=undefined` and the contents of the credentials file in the
 * same breath. A scratch HOME is what makes the environment boundary mean
 * something for the tools that read credentials off disk rather than out of
 * `process.env` — which, for every vendor CLI here, is most of them.
 *
 * WHY a gate gets its own environment at all (10 sections 2 and 9): a gate is
 * the least trusted thing this node spawns. Its argv is operator-approved, but
 * what it EXECUTES lives in the checkout — and the same task's `implement`
 * step holds `repo.write` over that checkout. `pytest` importing a
 * worker-written `conftest.py`, a worker-edited `Makefile` target, a
 * post-install hook: all of them run with whatever environment the gate got.
 * Inheriting the node's `process.env` therefore handed a repo-authored program
 * `ANTHROPIC_API_KEY` with no capability, no network grant and no side-effect
 * gate anywhere in the chain — verification is not a Worker run and carries no
 * capability grant at all. So the gate environment is built, never inherited.
 *
 * The credential strip is unconditional: an operator allowlist can add
 * variables a build genuinely needs (`CARGO_HOME`, `JAVA_HOME`, `CI`), but it
 * cannot re-add a credential, however it is spelled in node.yaml.
 *
 * There is exactly ONE place that enforces that, on purpose. The allowlist loop
 * used to ALSO skip credential keys, which made the two mutually redundant:
 * deleting either one left the whole suite green, so neither had a regression
 * signal and the composite could rot into having none at all. The strip below
 * is the survivor because it is the stronger statement — it holds for every way
 * a key can get into `env`, not just for the one loop that happened to be
 * guarded — and the test `buildGateEnv strips a credential the operator
 * explicitly allowlisted` fails the moment it is removed.
 */
export function buildGateEnv(
  base: NodeJS.ProcessEnv = process.env,
  operatorAllowlist: readonly string[] = [],
  scratchHome?: string,
  gatePath?: string,
): NodeJS.ProcessEnv {
  const env = minimalEnv(base);
  for (const key of operatorAllowlist) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of CREDENTIAL_ENV_KEYS) delete env[key];
  // The operator's LOGIN NAME is not a credential and it is not on
  // `MINIMAL_ENV_KEYS` any more — but `quality_gate_env: [USER]` would put it
  // back, and this is the one place that can refuse that. It matters for the
  // same reason the scratch HOME does: `/Users/${USER}` reconstructs the home
  // the scratch directory exists to hide, and the reconstruction is an absolute
  // path, which no HOME substitution reaches.
  delete env.USER;
  delete env.LOGNAME;
  if (gatePath !== undefined && !operatorAllowlist.includes("PATH")) {
    // See `buildGatePath`. An operator who really needs the node's own PATH
    // says `quality_gate_env: [PATH]`, which is a written decision rather than
    // an inherited default.
    env.PATH = gatePath;
  }
  if (scratchHome !== undefined) {
    // After the allowlist loop, so `quality_gate_env: [HOME]` cannot put the
    // operator's home back, and after nothing else: these two are the whole
    // point of the function now.
    env.HOME = scratchHome;
    env.TMPDIR = scratchHome;
  }
  return env;
}

/**
 * The directories a gate's `PATH` starts from: the system ones, and nothing
 * that names a user.
 */
export const GATE_SYSTEM_PATH_DIRS: readonly string[] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * A gate's `PATH`, DERIVED from the argv this node was configured to run rather
 * than inherited from the node process.
 *
 * WHY NOT INHERIT. A developer machine's `PATH` is a list of the operator's
 * private directories — `/Users/operator/.local/share/mise/installs/node/…/bin`,
 * `/Users/operator/.pnpm`, `/Users/operator/go/bin`. Handing that to the gate hands over the
 * operator's login name and the layout of their home in one variable, which is
 * the same leak `USER` was (see `buildGateEnv`), just spelled longer. The
 * scratch HOME is worth nothing while a gate can read the operator's real home
 * path out of its own environment.
 *
 * WHY NOT DROP IT. `argv[0]` is absolute, so the gate itself resolves without a
 * `PATH` — but the gate's own shebang does not. `node_modules/.bin/vitest`
 * starts `#!/usr/bin/env node`, and `env` needs a `PATH` to find `node`. A gate
 * with no `PATH` fails with an error that looks nothing like its cause.
 *
 * SO: the system directories, FIRST and always, plus the directory each
 * configured `argv[0]` actually lives in. The order is the enforcement — a
 * checkout that ships its own `node` in the same `node_modules/.bin` the
 * operator pointed `argv[0]` at cannot win the lookup against `/usr/bin`.
 * Relative entries are dropped: a `.` on a gate's `PATH` is the checkout
 * choosing what `env` resolves.
 */
export function buildGatePath(argv0s: readonly string[]): string {
  const dirs: string[] = [...GATE_SYSTEM_PATH_DIRS];
  for (const argv0 of argv0s) {
    if (!path.isAbsolute(argv0)) continue;
    const dir = path.dirname(argv0);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.join(":");
}

/**
 * Refuses a node's own `quality_gates:` whose `argv[0]` is not there to run.
 *
 * F10, and it is a usability defect that reads as a security one. The shipped
 * `node.example.yaml` named `/usr/local/bin/vitest`, which exists on no stock
 * machine; `refuseStructurally` checks only that `argv[0]` is ABSOLUTE, so the
 * config loaded fine, the node started fine, and every verification then failed
 * with exit `71` (`spawn ENOENT`, laundered through the gate's exit code) —
 * from a Temporal activity, twice retried, with nothing in the message naming a
 * path. An operator who follows the documentation gets a startup refusal
 * naming the binary instead.
 *
 * `isExecutable` is injected so the refusal has a test that does not depend on
 * what happens to be installed on the machine running it.
 */
export function assertNodeQualityGatesResolvable(
  gates: readonly NodeGateEntry[],
  isExecutable: (candidate: string) => boolean = defaultIsExecutable,
): void {
  for (const gate of gates) {
    const argv0 = gate.argv[0];
    // A non-absolute argv[0] is `assertNodeQualityGatesJustified`'s refusal (or
    // the operator's explicit `allow_unsafe`), and resolving it would mean
    // consulting a PATH — which is the thing that refusal exists to prevent.
    if (argv0 === undefined || !path.isAbsolute(argv0)) continue;
    if (isExecutable(argv0)) continue;
    throw new VerificationPolicyError(
      `node quality_gates entry ${gate.name} names ${argv0}, which is not an executable file on` +
        " this node. Every gate would fail with exit 71 (spawn ENOENT) and the failure would name" +
        " no path. Run `command -v " +
        path.basename(argv0) +
        "` on this node and put the absolute path it prints here.",
    );
  }
}

function defaultIsExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Operator env names that are refused at config load rather than stripped. */
export function credentialKeysIn(names: readonly string[]): readonly string[] {
  const credentials = new Set(CREDENTIAL_ENV_KEYS);
  return names.filter((name) => credentials.has(name));
}

/**
 * Operator env names that REDIRECT the gate rather than carry a credential.
 *
 * `quality_gate_env:` was checked against `CREDENTIAL_ENV_KEYS` only, so an
 * operator could allowlist `NODE_OPTIONS`, `LD_PRELOAD` or `GIT_SSH_COMMAND`
 * into the least trusted process on the node — the same half of the boundary
 * that `assertNoInjectedCredentials` refuses on the Control-Plane-to-node
 * direction (see `REDIRECT_ENV_PATTERNS`). There is no reason for the two
 * directions to disagree: a variable that is too dangerous to accept from the
 * Control Plane for the process that HOLDS the credentials is not safer in the
 * process that runs the checkout's code.
 */
export function redirectKeysIn(names: readonly string[]): readonly string[] {
  // `redirectEnvKeysIn` matches on names but reads values, so give every name
  // a placeholder. No real environment is consulted.
  return redirectEnvKeysIn(Object.fromEntries(names.map((name) => [name, "x"])));
}

export type NodeCommandRunnerOptions = {
  /**
   * The workspace's operator-configured quality gates, already justified
   * against this node's own `quality_gates:` (`parseActivityQualityGates`).
   * REQUIRED: there is no built-in fallback, because falling back to
   * `DEFAULT_QUALITY_GATES` runs `npm test` — i.e. whatever the target repo's
   * package.json says — for an operator who never configured that gate.
   */
  qualityGates: QualityGateCatalog;
  /**
   * This node's profile. REQUIRED, and deliberately not defaulted: it decides
   * whether a gate can be confined at all (`planGateConfinement`), and a
   * default would mean "whatever profile the caller forgot to pass runs the
   * checkout's code unconfined".
   */
  profile: NodeProfile;
  /**
   * The node operator's home, whose credential stores the confinement denies.
   * Defaults to `baseEnv.HOME` and then to this process's home.
   */
  home?: string;
  /** Scratch HOME/TMPDIR for this run. Created per runner when absent. */
  scratch?: GateScratch;
  /**
   * Absolute paths the confinement denies outright, on top of the credential
   * segments: the daemon's data dir and its control socket
   * (`daemonStateDenials`). Absent means the node could not derive them, NOT
   * that they are safe — `startNode` always passes them.
   */
  deniedPaths?: readonly string[];
  /** Operator egress allowlist for gates, `host:port`. Empty: no network. */
  networkAllowlist?: readonly string[];
  /** Injected by `planGateConfinement`'s tests; the real path otherwise. */
  sandboxExec?: string;
  timeoutMs?: number;
  /** Aborting kills every running gate's process group. */
  signal?: AbortSignal;
  /**
   * Extra environment variable names the node operator allows gates to see
   * (`quality_gate_env:` in node.yaml). Credential keys are stripped from the
   * result regardless of what is listed here.
   */
  envAllowlist?: readonly string[];
  /** The environment to select from. Defaults to this process's. */
  baseEnv?: NodeJS.ProcessEnv;
};

export type NodeCommandRunner = CommandRunnerPort & {
  cancel(): void;
  /** Removes this run's scratch HOME. Safe to call repeatedly. */
  dispose(): void;
};

/**
 * Verification commands run inside the node sandbox: the argv comes from the
 * operator's quality-gate allowlist (never from the plan), the cwd must resolve
 * to an allowed root, and no shell is involved at any point. Every child is
 * spawned detached so a timeout or `cancel()` kills the whole process group.
 *
 * The `FilesystemSandbox` handed in here is NARROWED to the target project (see
 * `narrowTo`), and it is worth being precise about what that does and does not
 * do, because a previous round of this file read as though it did more: it is a
 * PROCESS-LOCAL PATH VALIDATOR. It decides which cwd this node is willing to
 * spawn in and which artifact paths it will stat. It does not confine the
 * child. The child is confined by two things built here:
 *
 *  1. its ENVIRONMENT, which is constructed rather than inherited and whose
 *     HOME is a scratch directory (`buildGateEnv`), and
 *  2. an OS-LEVEL boundary around the spawned process (`planGateConfinement`),
 *     without which this node does not run a gate at all.
 */
export function createNodeCommandRunner(
  sandbox: FilesystemSandbox,
  options: NodeCommandRunnerOptions,
): NodeCommandRunner {
  const baseEnv = options.baseEnv ?? process.env;
  const scratch = options.scratch ?? createGateScratch();
  let plan: GateConfinementPlan;
  try {
    plan = planGateConfinement({
      profile: options.profile,
      // The gate may write its checkout and its own scratch HOME. Nothing else.
      writableRoots: [...sandbox.roots, scratch.home],
      home: options.home ?? baseEnv.HOME ?? os.homedir(),
      ...(options.deniedPaths === undefined ? {} : { deniedPaths: options.deniedPaths }),
      ...(options.networkAllowlist === undefined
        ? {}
        : { networkAllowlist: options.networkAllowlist }),
      // The gate may READ its own scratch HOME whatever the segment denials
      // say: `$HOME/.config` is where a tool writes its config on first run.
      scratchRoot: scratch.home,
      ...(options.sandboxExec === undefined ? {} : { sandboxExec: options.sandboxExec }),
    });
  } catch (error) {
    // Never leave a scratch directory behind for a run that will not happen.
    if (options.scratch === undefined) scratch.dispose();
    throw error;
  }
  if (plan.kind === "sandbox-exec") {
    // 0o400: the gate can read the profile it runs under (it is not a secret)
    // and the write-allowlist above does not cover `control/`, so it cannot
    // rewrite the profile the NEXT gate of the same verification will use.
    writeFileSync(scratch.profilePath, plan.profile, { mode: 0o400 });
  }

  const runner = createVerificationCommandRunner({
    catalog: options.qualityGates.map((gate) => ({
      name: gate.name,
      argv: confineGateArgv(plan, scratch.profilePath, gate.argv),
    })),
    cwd: sandbox.cwd,
    resolveCwd: (cwd) => sandbox.resolve(cwd, { mustExist: true }).path,
    // Explicit, never inherited: see `buildGateEnv`. Passing it here rather
    // than relying on `spawnBounded`'s minimal default keeps the node's own
    // policy readable at the place the node decides it.
    env: buildGateEnv(
      baseEnv,
      options.envAllowlist ?? [],
      scratch.home,
      // Derived from the argv this node was CONFIGURED to run, not inherited:
      // see `buildGatePath`.
      buildGatePath(options.qualityGates.map((gate) => gate.argv[0] as string)),
    ),
    timeoutMs: options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    cancel: () => runner.cancel(),
    dispose: () => {
      if (options.scratch === undefined) scratch.dispose();
    },
    run: (spec: CommandSpec): Promise<CommandExecution> => runner.run(spec),
  };
}

export function createNodeArtifactProbe(sandbox: FilesystemSandbox): ArtifactProbePort {
  return {
    exists(path: string): boolean {
      try {
        return sandbox.resolve(path, { mustExist: true }).exists;
      } catch {
        return false;
      }
    },
  };
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * Flags that hand a following token to `execve` regardless of the program.
 * `find . -exec /bin/sh -c id ;` is the canonical one.
 *
 * One of the two rules that SURVIVED the deletion of the argv classifier, and
 * it survived on the same terms as everything else here: it keys on a FLAG
 * whose documented meaning is "execute this", not on a table of program names,
 * and it has a test that fails on its own (`-exec` in front of an ABSOLUTE
 * non-shell binary, which nothing else in this file sees).
 */
const EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * Flags that hand a command line to a program that is otherwise inert.
 * `tar --checkpoint-action=exec=…`, `git -c alias.q='!curl…' q`,
 * `rsync --rsh-command=…`: none of these programs is a shell, and each takes
 * one flag that makes it one.
 */
const COMMAND_CARRYING_FLAG_PREFIXES = [
  "--checkpoint-action",
  "--use-compress-program",
  "--to-command",
  "--rsh-command",
  "--exec-path",
  "--init-file",
  "--rcfile",
  "--upload-pack",
  "--receive-pack",
];

/**
 * A token that names a file the CHECKOUT controls, or a program the checkout
 * can win the race to provide.
 *
 * Two shapes, and the second one was missing:
 *  - a relative path (`scripts/gate.sh`, `../shared/gate.toml`) resolves inside
 *    the checkout, which a `repo.write` worker in the same task can edit;
 *  - a BARE name (`vitest`, `pytest`, `gate`) resolves through the gate's
 *    `PATH`. `isCheckoutRelativeExecutable` used to require a `/`, so a bare
 *    `argv[0]` was accepted and whatever `PATH` produced at spawn time is what
 *    ran — including a checkout-provided `node_modules/.bin` entry if any
 *    relative component ever reaches that `PATH`. `node.example.yaml` warns
 *    about exactly this ("Name the real binary… use the path your toolchain
 *    installs them at") and nothing enforced it.
 *
 * So `argv[0]` must be ABSOLUTE, and no later non-flag token may be a relative
 * path. Later bare words (`test`, `run`, `--reporter=dot`'s operand) stay
 * usable: they are subcommands and operands, not programs this node spawns.
 */
function namesSomethingTheCheckoutControls(token: string): boolean {
  return !token.startsWith("/") && token.includes("/");
}

/**
 * One entry of this node's OWN `quality_gates:` allowlist.
 *
 * Structurally a superset of `QualityGateCommand`, plus the operator's explicit
 * acceptance of an argv the structural floor would otherwise refuse.
 */
export type NodeGateEntry = {
  readonly name: string;
  readonly argv: readonly string[];
  /**
   * Run this entry even though it names something the checkout controls (a
   * relative path, a `PATH`-resolved bare name, a flag that hands a command
   * line to an otherwise inert program). Default false. Setting it is a
   * statement that the operator accepts a `repo.write` worker in the same task
   * choosing what the gate executes.
   */
  readonly allowUnsafe?: boolean;
};

export type GateJustification = { ok: true } | { ok: false; reason: string };

/**
 * The structural floor, applied to a WHOLE argv.
 *
 * WHAT THIS IS NOT, ANY MORE. It used to be ~400 lines of tables —
 * `SHELL_EXECUTABLES`, `SCRIPT_RUNNERS`, `INTERPRETERS`, `CONTAINER_RUNNERS`,
 * `INLINE_CODE_*`, `CODE_SUBCOMMANDS`, a `git` subcommand list — classifying
 * argv STRINGS by the name of the program they mention. Round 7 made this node
 * an allowlist (no `quality_gates:` ⇒ nothing runs), which moved those tables
 * out of the boundary and left them as a lint over configuration the operator
 * wrote themselves. As a lint they were still wrong about where the risk is:
 * the shipped `node.example.yaml` recommends `vitest run`, `eslint .` and
 * `tsc --noEmit` as the SAFE gates, and `vitest` executes `vitest.config.ts`
 * while `eslint` executes `eslint.config.js` — both repo-authored JavaScript,
 * both editable by the same task's `implement` step. Naming the real binary
 * never took the choice of what executes away from the checkout, so a table
 * that refuses `node -e` while blessing `vitest` was measuring the wrong thing
 * and asking every review to extend it. It is deleted, and what a gate can
 * REACH — its environment (`buildGateEnv`) and an OS boundary around the child
 * (`planGateConfinement`) — is where the enforcement now is.
 *
 * WHAT SURVIVES, and why each of the three earns its place:
 *  1. `argv[0]` MUST BE ABSOLUTE. A bare name is resolved by `PATH` at spawn
 *     time, i.e. by something other than the operator's config.
 *  2. NO CHECKOUT-RELATIVE TOKEN, at any position. `timeout 60 scripts/gate.sh`
 *     and `mise x -- scripts/gate.sh` name a file the implement step can write;
 *     no wrapper list is involved, which is what finally covered wrappers
 *     nobody has heard of.
 *  3. FLAGS THAT MEAN "EXECUTE THIS" (`-exec`, `--checkpoint-action=…`). Two
 *     small sets keyed on flag semantics, not on program names.
 * Each has a test that fails when only that rule is removed.
 */
function refuseStructurally(argv: readonly string[]): string | undefined {
  const argv0 = argv[0];
  if (argv0 !== undefined && !argv0.startsWith("/")) {
    return argv0.includes("/")
      ? `relative executable ${argv0} resolves inside the checkout`
      : `${argv0} is not an absolute path, so the gate's PATH decides what runs`;
  }
  // PASS 1 — checkout-relative paths, anywhere.
  //
  // Run as its own pass, before anything else, so that this refusal (the one
  // that names the actual repo-authored file) is what the operator is told
  // about, whichever other rule the argv also happens to trip.
  //
  // Tokens starting with `-` are exempt: a program is never spawned from one,
  // and exempting them keeps `--reporter=dot` and
  // `--manifest-path=crates/x/Cargo.toml` usable. The SEPARATED spelling
  // (`--manifest-path crates/x/Cargo.toml`) is refused — an argv cannot tell
  // which non-flag tokens are operands and which are programs, so both are
  // refused rather than guessed, and the operator answers with an absolute path
  // or `allow_unsafe: true`.
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith("-") || !namesSomethingTheCheckoutControls(token)) continue;
    return `${token} (argv[${index}]) is a path inside the checkout`;
  }
  // PASS 2 — flags that execute a string, whatever program they are given to.
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const where = index === 0 ? "" : ` (argv[${index}])`;
    if (EXEC_FLAGS.has(token)) {
      return `${token}${where} hands the rest of the argv to execve`;
    }
    if (COMMAND_CARRYING_FLAG_PREFIXES.some((prefix) => token.startsWith(prefix))) {
      return `${token}${where} hands a command line to a program that is not a shell`;
    }
  }
  return undefined;
}

/**
 * Can this node justify spawning this argv on its own?
 *
 * DENY BY DEFAULT. Acceptance requires a positive match against configuration
 * this node's OPERATOR wrote: `quality_gates:` in node.yaml, name AND argv,
 * token for token. There is no other way to reach `spawn`.
 *
 * This is the same rule as capabilities (10 section 6) — the Control Plane's
 * word is a REQUEST, and this node's local policy is what turns it into an
 * execution — and it is now stated the same way: an intersection with a local
 * ALLOWLIST, not a filter against a list of known-bad shapes.
 *
 * WHY the empty catalog is a refusal rather than a fallback. It used to fall
 * back to `refuseStructurally` alone, which is a denylist, and `node.ts` only
 * populates the catalog when the operator wrote `quality_gates:` — so the
 * denylist was the DEFAULT path, not an edge case. The seventh review measured
 * it end to end: 69 of 75 crafted argvs were accepted, among them
 * `php -r "system('id')"`, `pwsh -Command`, `git -c alias.q='!curl…' q`,
 * `docker run -v /:/host`, `uv run`, `gradle`, and this repository's own
 * `mise x -- scripts/gate.sh`. Three rounds of adding names to the denylist had
 * each been followed by a review finding more, which is the normal outcome for
 * a denylist and not a sign that the next round would be the last.
 *
 * So an unconfigured node now runs no gates at all, loudly: the operator gets a
 * PolicyViolation naming the config key to add, once, at the first
 * verification. That is defensible because the node already refuses an absent
 * catalog from the Control Plane for the same reason — a gate's argv is
 * operator configuration, and "nobody configured it" is not permission.
 *
 * The structural floor still applies on top of a configured match, but it is
 * now three rules rather than a name table (`refuseStructurally`): a
 * `PATH`-resolved `argv[0]` (`pnpm -r test`), a checkout-relative token
 * (`timeout 60 scripts/gate.sh`) and flags that mean "execute this". Each is
 * acknowledged per entry with `allow_unsafe: true` — operator-only, and not
 * settable from a plan or from the Control Plane's catalog. What a configured
 * gate can DO once it runs is no longer decided here at all; see
 * `createNodeCommandRunner`.
 */
export function justifyQualityGate(
  gate: QualityGateCommand,
  nodeCatalog: readonly NodeGateEntry[],
): GateJustification {
  if (nodeCatalog.length === 0) {
    return {
      ok: false,
      reason:
        `gate ${gate.name}: this node has no quality_gates configured, so there is nothing that` +
        " can justify spawning any argv. Verification is deny-by-default: add the gate's real" +
        " binary and argv to `quality_gates:` in this node's node.yaml (see" +
        " docs/design/node.example.yaml)",
    };
  }
  const configured = nodeCatalog.find((c) => c.name === gate.name);
  if (configured === undefined) {
    return {
      ok: false,
      reason: `gate ${gate.name} is not in this node's configured quality_gates`,
    };
  }
  const same =
    configured.argv.length === gate.argv.length &&
    configured.argv.every((part, index) => part === gate.argv[index]);
  if (!same) {
    return {
      ok: false,
      reason:
        `gate ${gate.name} argv ${JSON.stringify(gate.argv)} does not match this node's` +
        ` configured argv ${JSON.stringify(configured.argv)}`,
    };
  }
  if (configured.allowUnsafe === true) return { ok: true };
  const refusal = refuseStructurally(gate.argv);
  return refusal === undefined
    ? { ok: true }
    : {
        ok: false,
        reason:
          `gate ${gate.name}: ${refusal}. It is configured in this node's quality_gates,` +
          " which is not on its own a reason to run it; set `allow_unsafe: true` on that" +
          " entry if you accept that the checkout decides what executes",
      };
}

/**
 * Refuses a node's OWN `quality_gates:` at CONFIG LOAD, so an operator who
 * pasted the old example learns at startup rather than when a verification
 * finally arrives (and is retried twice, and reports a PolicyViolation nobody
 * connects to a config line).
 */
export function assertNodeQualityGatesJustified(gates: readonly NodeGateEntry[]): void {
  for (const gate of gates) {
    if (gate.allowUnsafe === true) continue;
    if (gate.argv.length === 0) continue;
    const refusal = refuseStructurally(gate.argv);
    if (refusal !== undefined) {
      throw new VerificationPolicyError(
        `node quality_gates entry ${gate.name} cannot be justified: ${refusal}.` +
          " Name the real binary, or set `allow_unsafe: true` on that entry to accept it.",
      );
    }
  }
}

/**
 * Validates the quality-gate catalog that arrives with a verification activity.
 *
 * The catalog is operator configuration owned by the Control Plane (a
 * workspace's `quality_gates.commands`), so it is the only thing that may name
 * an argv. It is still parsed strictly here rather than trusted: the node is
 * the process that spawns, so it checks the shape it is about to execute, and
 * an absent or empty catalog is a hard refusal — never a silent fallback to a
 * built-in default the operator did not configure.
 *
 * Shape is not enough on its own: `["/bin/sh", "-c", "curl … | sh"]` is a
 * perfectly shaped argv. Every entry must ALSO be justified against this node's
 * own policy (`justifyQualityGate`) before it can be spawned.
 *
 * WHICH entries are justified: the ones this verification SELECTS.
 * `selected` carries the gate keys of the plan's commands, and the returned
 * catalog contains exactly the entries that were both selected AND justified —
 * so everything the runner can reach has been positively matched against this
 * node's allowlist, which is the property that matters, while a workspace gate
 * this node does not host stops being a reason to refuse a verification that
 * never asked for it. It used to justify EVERY incoming entry, which made a
 * heterogeneous fleet unusable: a node that configured `test` but not the
 * workspace's `cargo-clippy` refused a plan selecting only `test`, and the
 * refusal named a gate nobody was trying to run. Nothing is weakened — an
 * unselected entry is never spawned, and a selected one still needs a
 * token-for-token match — and the loud refusal still arrives, at the moment a
 * plan actually selects the gate this node cannot justify.
 *
 * Omitting `selected` justifies everything, which is the stricter reading and
 * the right default for callers that are not looking at a plan.
 */
export function parseActivityQualityGates(
  input: unknown,
  nodeCatalog: readonly NodeGateEntry[] = [],
  selected?: ReadonlySet<string>,
): QualityGateCatalog {
  if (!Array.isArray(input) || input.length === 0) {
    throw new VerificationPolicyError(
      "verification input carries no quality-gate catalog; the Control Plane must send the" +
        " workspace's configured `qualityGates` (name + argv) with every verification activity",
    );
  }
  const catalog: QualityGateCommand[] = [];
  const seen = new Set<string>();
  for (const entry of input as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      throw new VerificationPolicyError("quality gate entry is not an object");
    }
    const gate = entry as { name?: unknown; argv?: unknown };
    if (typeof gate.name !== "string" || !isQualityGateSelector(gate.name)) {
      throw new VerificationPolicyError(
        `quality gate name ${JSON.stringify(gate.name)} is not a plain gate name`,
      );
    }
    if (!Array.isArray(gate.argv) || gate.argv.length === 0) {
      throw new VerificationPolicyError(`quality gate ${gate.name}: argv must be a non-empty array`);
    }
    const argv = gate.argv as readonly unknown[];
    for (const part of argv) {
      if (typeof part !== "string" || part.length === 0 || CONTROL_CHARACTERS.test(part)) {
        // Nothing is shell-interpreted (the argv reaches `spawn` verbatim), so
        // only shapes that cannot be an argument at all are rejected: empty
        // strings and control characters, NUL included.
        throw new VerificationPolicyError(
          `quality gate ${gate.name}: argv must be non-empty strings without control characters`,
        );
      }
    }
    const command: QualityGateCommand = {
      name: gate.name,
      argv: Object.freeze([...(argv as string[])]),
    };
    // Shape was checked above for every entry (a malformed catalog is a
    // malformed catalog); justification and inclusion are for the selected
    // ones. `duplicate` is likewise checked over the whole input, so a catalog
    // that defines `test` twice is refused even when only `lint` is selected.
    if (seen.has(command.name)) {
      throw new VerificationPolicyError(`duplicate quality gate ${command.name}`);
    }
    seen.add(command.name);
    if (selected !== undefined && !selected.has(command.name)) continue;
    const justified = justifyQualityGate(command, nodeCatalog);
    if (!justified.ok) {
      throw new VerificationPolicyError(
        `this node refuses an argv it cannot justify: ${justified.reason}`,
      );
    }
    catalog.push(command);
  }
  return Object.freeze(catalog);
}

export type NodeVerificationActivityOptions = {
  /** The node's sandbox; narrowed per run to the project being verified. */
  sandbox: FilesystemSandbox;
  /**
   * This node's profile, from `node.profile` in node.yaml. REQUIRED: it decides
   * how (and whether) a gate child can be confined at all. See
   * `planGateConfinement` — a `linux-restricted` node refuses verification
   * outright, and a `mac-restricted` node refuses it when `sandbox-exec` is
   * missing.
   */
  profile: NodeProfile;
  /** The node operator's home; its credential stores are denied to gates. */
  home?: string;
  /**
   * The daemon's data dir and control socket, denied to every gate
   * (`daemonStateDenials(controlPlaneSocketPath(...))`). `startNode` derives
   * them from this node's own `node.control_plane`.
   */
  deniedPaths?: readonly string[];
  /** Operator egress allowlist for gates (`quality_gate_network:`). */
  networkAllowlist?: readonly string[];
  /** Injected by tests so the "no sandbox-exec" refusal is reachable. */
  sandboxExec?: string;
  /** workspaceId -> projectId -> absolute path, validated at config load. */
  projects: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Workspaces the Control Plane reconciled onto this node. */
  grantedWorkspaces: ReadonlySet<string>;
  nodeId: string;
  /** Aborting kills every gate still running on this node. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * This node's OWN quality-gate allowlist, from `quality_gates:` in node.yaml.
   * The incoming catalog is intersected with it (`justifyQualityGate`), and an
   * EMPTY list means no gate can be justified: verification is deny-by-default,
   * so an unconfigured node refuses every verification rather than falling back
   * to a denylist of known-bad argv shapes.
   */
  nodeQualityGates?: readonly NodeGateEntry[];
  /**
   * Extra environment variable names gates may see (`quality_gate_env:` in
   * node.yaml). Credential keys are stripped regardless; see `buildGateEnv`.
   */
  envAllowlist?: readonly string[];
  /** The environment gates are built from. Defaults to this process's. */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * workspaceId -> project ids dropped at config validation. A workspace whose
   * binding set was truncated is AMBIGUOUS: inferring "the only project" from
   * what survived can pick the wrong checkout entirely.
   */
  truncatedWorkspaces?: Readonly<Record<string, readonly string[]>>;
  /**
   * Per-invocation cancellation, i.e. the Temporal activity's own signal.
   * Without it, cancelling the activity leaves the gate running to its timeout
   * (30 minutes by default) with nobody waiting for the answer.
   */
  cancellationSignal?: () => AbortSignal | undefined;
  /**
   * Per-invocation heartbeat sink (`Context.current().heartbeat`). Quality
   * gates routinely outlive the activity's `heartbeatTimeout`, and an activity
   * that never heartbeats is killed and retried to exhaustion.
   */
  heartbeat?: (details: unknown) => void;
  heartbeatIntervalMs?: number;
};

export type NodeVerificationRequest = {
  workspaceId: string;
  plan: VerificationPlan;
  qualityGates?: unknown;
  projectId?: string;
  cwd?: string;
  expectedArtifacts?: string[];
};

/**
 * The verification activity an execution node serves.
 *
 * This is the whole point of the node hosting verification at all: the gates
 * run inside the node's sandbox, narrowed to the project or worktree under
 * test, with an argv that came from the workspace's operator configuration.
 * Verification used to be dispatched to the control queue instead, which meant
 * either every gate answered 126 (and no `coding` task could ever complete) or
 * the operator's argv ran unsandboxed next to the daemon's database.
 */
export function createNodeVerificationActivity(
  options: NodeVerificationActivityOptions,
): (input: NodeVerificationRequest) => Promise<VerificationResult> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
  return async (input) => {
    if (!options.grantedWorkspaces.has(input.workspaceId)) {
      throw new VerificationPolicyError(
        `workspace ${input.workspaceId} is not bound to node ${options.nodeId}`,
      );
    }
    // An empty plan is not a pass. `runVerification` over zero commands answers
    // `passed` — nothing ran, nothing failed — which would turn "the planner
    // produced no gates" (or a plan that was dropped on the way here) into a
    // green verification step and let a `coding` task complete unverified.
    if (input.plan.commands.length === 0) {
      return {
        status: "failed",
        groups: [],
        missingArtifacts: [],
        artifacts: [],
        evidence: [],
        failureSignature: "verification-plan-empty",
      };
    }
    // Only what this plan selects has to be justified: `quality:test` and
    // `test` both select the gate named `test` (`gateKeyOf`), and an entry the
    // plan never names is neither justified nor placed in the runner's catalog,
    // so it cannot be spawned by anything downstream either.
    const selected = new Set(input.plan.commands.map((command) => gateKeyOf(command.name)));
    const catalog = parseActivityQualityGates(
      input.qualityGates,
      options.nodeQualityGates ?? [],
      selected,
    );
    const root = resolveVerificationRoot(
      input.workspaceId,
      ownProperty(options.projects, input.workspaceId) ?? {},
      input.projectId,
      ownProperty(options.truncatedWorkspaces ?? {}, input.workspaceId) ?? [],
    );
    // Narrowed, so the sandbox's ONLY allowed root for this run is the project
    // under test: a `..` cwd, another workspace's checkout, or the node's own
    // config are all outside it and are denied before anything is spawned.
    const narrowed = options.sandbox.narrowTo(root);
    const commands = createNodeCommandRunner(narrowed, {
      qualityGates: catalog,
      profile: options.profile,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.deniedPaths === undefined ? {} : { deniedPaths: options.deniedPaths }),
      ...(options.networkAllowlist === undefined
        ? {}
        : { networkAllowlist: options.networkAllowlist }),
      ...(options.sandboxExec === undefined ? {} : { sandboxExec: options.sandboxExec }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.envAllowlist === undefined ? {} : { envAllowlist: options.envAllowlist }),
      ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
    });
    const artifacts = createNodeArtifactProbe(narrowed);

    // Activity cancellation has to reach the process group. The runner's
    // `cancel` used to be dropped on the floor, so a cancelled or abandoned
    // activity left its gates running until the 30-minute timeout.
    const activitySignal = options.cancellationSignal?.();
    const cancel = (): void => commands.cancel();
    if (activitySignal?.aborted === true) cancel();
    else activitySignal?.addEventListener("abort", cancel, { once: true });

    const beat = options.heartbeat;
    beat?.({ phase: "verification", workspaceId: input.workspaceId });
    const ticker =
      beat === undefined
        ? undefined
        : setInterval(() => beat({ phase: "verification", workspaceId: input.workspaceId }), heartbeatIntervalMs);
    ticker?.unref?.();

    try {
      return await runVerification(input.plan, { commands, artifacts }, {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.expectedArtifacts === undefined
          ? {}
          : { expectedArtifacts: input.expectedArtifacts }),
      });
    } finally {
      if (ticker !== undefined) clearInterval(ticker);
      // Both signals outlive this activity — the node-lifetime abort by
      // construction, the activity signal potentially — so both listeners are
      // detached. Left attached, each verification retains one closure that
      // pins that runner's in-flight set and catalog for the node's lifetime.
      commands.cancel();
      // The scratch HOME goes with the run that owns it. Left behind, a node
      // accumulates one directory per verification for its whole lifetime.
      commands.dispose();
      activitySignal?.removeEventListener("abort", cancel);
    }
  };
}

/**
 * Own-property lookup for maps keyed by ids that arrive from the Control Plane.
 *
 * `projects["__proto__"]` returns `Object.prototype`, which is not `undefined`,
 * so a plain index passes the "is it bound?" check and the refusal never fires;
 * the run then dies later as a `TypeError`, which is not in Temporal's
 * non-retryable list and so gets retried instead of surfaced.
 */
function ownProperty<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * The directory verification is narrowed to. Same rule as a Worker run's cwd
 * (`SandboxRunAssignment.workingDirectory`): a project or task worktree this
 * node has a validated binding for, never the node's own working directory and
 * never the whole sandbox.
 */
export function resolveVerificationRoot(
  workspaceId: string,
  projects: Readonly<Record<string, string>>,
  projectId?: string,
  /** Project ids configured for this workspace but dropped as invalid. */
  droppedProjectIds: readonly string[] = [],
): string {
  const bound = Object.keys(projects).sort();
  if (projectId !== undefined) {
    const found = ownProperty(projects, projectId);
    if (typeof found !== "string") {
      throw new VerificationPolicyError(
        droppedProjectIds.includes(projectId)
          ? `project ${projectId} is configured for workspace ${workspaceId} but its binding was` +
            " dropped as invalid on this node; fix the path or the allowed roots"
          : `project ${projectId} is not bound on this node for workspace ${workspaceId}`,
      );
    }
    return found;
  }
  // A truncated binding set is NOT a smaller configured set. Two configured
  // projects, one of whose paths was dropped, leaves exactly one survivor —
  // and inferring "the only project" from it verifies the wrong checkout while
  // reporting success. Ambiguity and truncation both fail closed.
  if (droppedProjectIds.length > 0) {
    throw new VerificationPolicyError(
      `verification for workspace ${workspaceId} names no project and this node's binding set was` +
        ` truncated (dropped: ${[...droppedProjectIds].sort().join(", ")}); refusing to infer a` +
        " project from what survived",
    );
  }
  if (bound.length === 1) {
    // Unambiguous: the workspace has exactly one checkout on this node.
    return projects[bound[0] as string] as string;
  }
  throw new VerificationPolicyError(
    bound.length === 0
      ? `workspace ${workspaceId} has no project bound on this node; nothing to verify in`
      : `verification for workspace ${workspaceId} names no project and this node binds ${bound.length}` +
        ` (${bound.join(", ")}); refusing to guess a working directory`,
  );
}
