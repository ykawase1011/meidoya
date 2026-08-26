import fs from "node:fs";
import path from "node:path";
import type { NodeProfile } from "@meidoya/node-protocol";
import {
  CONFINABLE_HOME_SUBPATHS,
  CONFINABLE_SENSITIVE_SEGMENTS,
} from "./sensitive.js";

/**
 * One entry of the operator's egress allowlist for quality gates, in the ONLY
 * grammar `sandbox-exec` actually accepts for a remote endpoint:
 * `localhost:<port>` or `*:<port>`, with `*` allowed for the port.
 *
 * This is narrower than it looks like it should be, and the narrowness is the
 * honest part. `(remote ip "github.com:443")` is not a stricter rule than
 * `*:443` — it is a PARSE ERROR: measured, `sandbox-exec` rejects the profile
 * with "host must be * or localhost in network address" and the gate does not
 * start. Nor is `127.0.0.1:5432` accepted, though `localhost:5432` covers it.
 * So a kernel profile cannot express a per-host allowlist at all, and the node
 * refuses to accept a spelling that would suggest otherwise: an operator asking
 * for one host on 443 must knowingly write `*:443`, which is the whole internet
 * on the port that matters. The default — no allowance, no network — is
 * therefore the one that carries the weight, and it is what all three shipped
 * gates run under.
 */
const NETWORK_ALLOWANCE = /^(\*|localhost):(\*|\d{1,5})$/u;

/**
 * Builds the refusal a caller throws when a quality gate cannot be confined by
 * anything the OS enforces.
 *
 * A FUNCTION rather than an `Error` subclass on purpose. Temporal's refusal
 * registry (`refusals.ts` in `@meidoya/workflows-temporal`) classifies error
 * classes by the NAME they throw under, and `PolicyViolation` is already
 * classified as non-retryable — which is the correct disposition here, since
 * retrying "this node cannot confine a gate" three times only hides it. A new
 * subclass would be one more name for the same disposition.
 */
function confinementRefusal(message: string): Error {
  const error = new Error(message);
  error.name = "PolicyViolation";
  return error;
}

/** Where macOS keeps the only OS-level sandbox this node can drive. */
export const DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export type GateConfinementPlan =
  /** Wrap the gate's argv: `<executable> -f <profile file> <argv…>`. */
  | { readonly kind: "sandbox-exec"; readonly executable: string; readonly profile: string }
  /** Nothing to wrap: the guest boundary already is the confinement. */
  | { readonly kind: "vm-boundary" };

export type GateConfinementOptions = {
  readonly profile: NodeProfile;
  /**
   * The ONLY paths the gate may write: the checkout under test and the gate's
   * own scratch HOME/TMPDIR. Everything else on the filesystem is read-mostly.
   */
  readonly writableRoots: readonly string[];
  /** The node operator's home, whose credential stores are denied outright. */
  readonly home: string;
  /**
   * Absolute paths denied to the gate whatever their name looks like: the
   * daemon's `data_dir` and its control socket (`daemonStateDenials`).
   */
  readonly deniedPaths?: readonly string[];
  /** Operator egress allowlist, `host:port`. Empty means: no network at all. */
  readonly networkAllowlist?: readonly string[];
  /** This run's scratch HOME; readable even under the segment denials. */
  readonly scratchRoot?: string;
  readonly sandboxExec?: string;
  /** Injectable so the "sandbox-exec is missing" refusal has a test. */
  readonly isExecutable?: (candidate: string) => boolean;
};

function defaultIsExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** SBPL string literals are C-like: only `\` and `"` need escaping. */
function sbplString(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw confinementRefusal(
      "a path in the gate sandbox profile contains a control character; refusing to build a" +
        " profile whose meaning depends on how the parser recovers",
    );
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function realpathOr(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function assertAbsolute(candidate: string, what: string): string {
  if (!path.isAbsolute(candidate)) {
    throw confinementRefusal(
      `${what} must be an absolute path to appear in a sandbox profile, got ${JSON.stringify(candidate)}`,
    );
  }
  return realpathOr(candidate);
}

/**
 * The SBPL profile every quality gate on a macOS node runs under.
 *
 * WHAT IT IS FOR. A gate is the least trusted thing this node spawns: its argv
 * is operator-approved, but what that binary LOADS comes out of the checkout,
 * and the same task's `implement` step holds `repo.write` over that checkout.
 * `vitest` executes `vitest.config.ts`; `eslint` executes `eslint.config.js`;
 * both are repo-authored JavaScript, and both are in this project's own
 * `node.example.yaml` as the SAFE gates. So "name the real binary and the
 * checkout no longer decides what executes" was never true, and the only place
 * left to draw a boundary is what the CHILD can reach.
 *
 * Two shapes, on purpose:
 *  - WRITES are an ALLOWLIST. Nothing outside the checkout and the gate's own
 *    scratch HOME is writable, so a gate cannot install a shell profile, a git
 *    hook, a `~/.claude/settings.json` or anything else that turns one run into
 *    persistence.
 *  - READS stay open except for the credential stores and the daemon's own
 *    state, because a read allowlist is unbuildable: the gate's own
 *    interpreter, its dylibs and its toolchain live wherever the operator
 *    installed them (`~/.local/share/mise/…`, `/opt/homebrew`,
 *    `/Library/Developer`), and a profile that has to enumerate them is a
 *    profile everybody turns off. The segment list is the same one
 *    `findSensitiveSegment` refuses in-process, so there is one list, not two.
 *  - NETWORK is a DENY with an operator allowlist, because reads plus network
 *    is the whole of credential egress and this profile used to have neither
 *    half. Measured inside the previous profile: `curl https://example.com`
 *    returned 200 and `nc -z example.com 443` succeeded, from the process this
 *    file's own comment calls the least trusted thing the node spawns — while
 *    `networkPolicy` WAS enforced for the agent runtime, the trusted process
 *    that holds a capability grant. A gate holds none, and all three gates in
 *    the shipped `node.example.yaml` are offline, so the default is nothing.
 *
 * ORDER MATTERS, and it is the reason the rules are not grouped by verb. SBPL
 * is last-match-wins, so the file reads: deny the daemon's state → allow the
 * run's OWN roots back (a task worktree lives INSIDE the daemon's data dir, so
 * a flat deny would deny the gate the code it is testing) → deny the credential
 * segments, so that neither the checkout's own `.ssh` nor the operator's
 * `~/.config` is reachable through the allow-back → allow the run's own scratch
 * HOME last, because `$HOME/.config` is where a tool writes its config on first
 * run and a segment rule cannot tell whose home it is looking at.
 *
 * THE RESIDUAL, stated at the altitude an operator has to make a decision at.
 * What a gate CAN still do, after this profile:
 *  - read any ordinary file on the node that is not a credential store, the
 *    daemon's data dir or the control socket. Concretely: every other checkout
 *    on the machine, including checkouts of workspaces this run has no binding
 *    for, and their source, their `.env`-shaped files and their build output.
 *    Reads outside this run's narrowed sandbox are NOT confined by path.
 *  - execute anything the checkout can make it execute; the OS boundary is
 *    about what the child REACHES, never about what it is.
 * What it can NOT do, and this is the part that changed: reach the operator's
 * credential stores (`.ssh`, `.aws`, `.claude`, `.codex`, `.config`, the login
 * Keychain), reach the daemon's bearer credentials or its control socket, write
 * anywhere outside the checkout and its scratch HOME, or open a socket to
 * anywhere at all unless the operator named the address. The pre-fix residual
 * was not "a gate can read some ordinary files": it was the operator's whole
 * credential set plus the control plane, and it was accepted as small because
 * it was written down as small.
 */
export function buildGateSandboxProfile(options: {
  readonly writableRoots: readonly string[];
  readonly home: string;
  readonly deniedSegments?: readonly string[];
  readonly deniedHomeSubpaths?: readonly string[];
  /** Absolute paths denied outright: the daemon's data dir and its socket. */
  readonly deniedPaths?: readonly string[];
  /** Operator egress allowlist, `host:port`. Absent or empty: no network. */
  readonly networkAllowlist?: readonly string[];
  /**
   * This run's scratch HOME, if it has one. Readable unconditionally, AFTER
   * the credential-segment denials — because those are written as segments and
   * a scratch HOME is a real home: `$XDG_CONFIG_HOME` defaults to
   * `$HOME/.config`, so `pnpm`, `yarn` and friends write a config file there on
   * first run and read it back on the next line. Denying that is not a
   * confinement, it is an intermittent gate failure with no explanation. There
   * is nothing to protect inside it: the node creates it empty, per run.
   */
  readonly scratchRoot?: string;
}): string {
  const home = assertAbsolute(options.home, "the node's home");
  const writable = options.writableRoots.map((root) =>
    assertAbsolute(root, "a gate-writable root"),
  );
  if (writable.length === 0) {
    throw confinementRefusal(
      "a gate sandbox profile needs at least one writable root (the checkout under test)",
    );
  }
  const segments = options.deniedSegments ?? CONFINABLE_SENSITIVE_SEGMENTS;
  const homeSubpaths = options.deniedHomeSubpaths ?? CONFINABLE_HOME_SUBPATHS;
  // `realpathOr` rather than a bare string: the daemon's data dir is routinely
  // reached through a symlinked home (`/tmp` -> `/private/tmp` on macOS), and a
  // deny rule written against the un-canonicalized spelling denies nothing.
  const deniedPaths = (options.deniedPaths ?? []).map((candidate) =>
    assertAbsolute(candidate, "a path denied to gates"),
  );
  const scratchRoot =
    options.scratchRoot === undefined
      ? undefined
      : assertAbsolute(options.scratchRoot, "the gate's scratch HOME");
  const network = options.networkAllowlist ?? [];
  for (const allowance of network) {
    if (!NETWORK_ALLOWANCE.test(allowance)) {
      throw confinementRefusal(
        `gate network allowance ${JSON.stringify(allowance)} is not something an OS profile can` +
          " enforce. sandbox-exec accepts only `localhost:<port>` or `*:<port>` (either half may" +
          " be `*`) and rejects the whole profile for anything else — a host name there is a" +
          " parse error, not a stricter rule, and the gate would simply fail to start. There is" +
          " no per-host egress allowlist to be had here: `*:443` means the whole internet on 443." +
          " A gate holds no capability grant, so the default is no network at all.",
      );
    }
  }

  const segmentRules = segments.map((segment) => {
    const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Anchored on `/` at both ends so `.ssh` matches the SEGMENT and not, say,
    // `/tmp/my.sshsuffix`. Depth- and user-agnostic: another account's
    // `~/.aws` is denied by the same line.
    return `  (regex #"/${escaped}($|/)")`;
  });

  return [
    "(version 1)",
    ";; meidoya quality-gate profile: generated per run, never edited by hand.",
    "(allow default)",
    "",
    ";; NETWORK: deny, with an operator allowlist. A gate carries no capability",
    ";; grant, and `network*` covers unix sockets too — which is what puts the",
    ";; daemon's control socket out of reach even for a gate that found the path.",
    "(deny network*)",
    ...(network.length === 0
      ? []
      : [
          "(allow network-outbound",
          ...network.map((allowance) => `  (remote ip ${sbplString(allowance)})`),
          ")",
        ]),
    "",
    ";; WRITES: allowlist. The checkout under test and the run's scratch HOME.",
    "(deny file-write*)",
    "(allow file-write*",
    ...writable.map((root) => `  (subpath ${sbplString(root)})`),
    ")",
    ";; /dev/null, /dev/tty and friends: a gate that cannot write them cannot",
    ";; even redirect its own output.",
    "(allow file-write-data file-ioctl (subpath \"/dev\"))",
    "",
    ";; READS, part 1: the daemon's own state. Its data_dir holds the SQLite",
    ";; database and the per-binding `clients/*.secret` bearer files, and its",
    ";; control socket accepts `session.hello` from anyone holding one. Every",
    ";; agent process runs as the daemon's user, so nothing but this rule is",
    ";; between a gate and the whole control plane.",
    ...(deniedPaths.length === 0
      ? []
      : [
          "(deny file-read*",
          ...deniedPaths.flatMap((denied) => [
            `  (subpath ${sbplString(denied)})`,
            `  (literal ${sbplString(denied)})`,
          ]),
          ")",
        ]),
    ";; …and the run's OWN roots back, because a task worktree lives INSIDE that",
    ";; data dir. Last match wins, so this re-allows only what this run may also",
    ";; WRITE — never another tenant's worktree, never the clients/ directory.",
    "(allow file-read*",
    ...writable.map((root) => `  (subpath ${sbplString(root)})`),
    ")",
    "",
    ";; READS, part 2: the credential stores this node refuses in-process,",
    ";; refused again where the kernel is the one saying no. LAST, so the",
    ";; allow-back above cannot reopen the checkout's own `.ssh` or `.config`.",
    "(deny file-read*",
    ...segmentRules,
    ...homeSubpaths.map((sub) => `  (subpath ${sbplString(path.join(home, sub))})`),
    ")",
    ...(scratchRoot === undefined
      ? []
      : [
          "",
          ";; The run's own scratch HOME, last: `$HOME/.config` is where a tool",
          ";; writes its config on first run, and it is this run's directory,",
          ";; created empty by the node. Denying it fails gates, protects nothing.",
          `(allow file-read* (subpath ${sbplString(scratchRoot)}))`,
        ]),
    "",
  ].join("\n");
}

/**
 * How this node confines a quality gate, per profile (10 sections 3-5).
 *
 * DENY BY DEFAULT: a profile with no confinement this process can actually
 * apply does not fall through to "run it anyway".
 *
 *  - `mac-restricted`: `sandbox-exec`, REQUIRED. 10 section 3 says mac-restricted
 *    is explicitly not VM-equivalent isolation, which leaves two honest options:
 *    require an OS-level boundary for gates, or refuse to host verification on
 *    this profile at all. Requiring it is the one that keeps the shipped
 *    `node.example.yaml` working, and macOS ships the mechanism; when the binary
 *    is missing the node takes the OTHER option and refuses.
 *  - `linux-restricted`: REFUSED. 10 section 4's isolation (dedicated OS user,
 *    rootless container, read-only root) is a deployment plan that
 *    `planLinuxHardening` describes and NOTHING in this process applies — the
 *    node has no per-child confinement on Linux, and claiming one in a comment
 *    is exactly the defect that made this round necessary.
 *  - `lima-trusted`: unconfined child, because the VM already is the boundary
 *    (10 section 5: `trusted` means free inside the guest, not on the host).
 */
export function planGateConfinement(options: GateConfinementOptions): GateConfinementPlan {
  switch (options.profile) {
    case "lima-trusted":
      return { kind: "vm-boundary" };
    case "mac-restricted": {
      const executable = options.sandboxExec ?? DEFAULT_SANDBOX_EXEC;
      const isExecutable = options.isExecutable ?? defaultIsExecutable;
      if (!isExecutable(executable)) {
        throw confinementRefusal(
          `profile mac-restricted requires ${executable} to confine a quality gate, and it is not` +
            " executable on this node. A gate runs code the checkout chooses (vitest.config.ts," +
            " eslint.config.js, a conftest.py the implement step just wrote), so without an" +
            " OS-level boundary there is nothing between it and this node's home; refusing to" +
            " run verification here. Move verification to a lima-trusted node.",
        );
      }
      return {
        kind: "sandbox-exec",
        executable,
        profile: buildGateSandboxProfile({
          writableRoots: options.writableRoots,
          home: options.home,
          ...(options.deniedPaths === undefined ? {} : { deniedPaths: options.deniedPaths }),
          ...(options.networkAllowlist === undefined
            ? {}
            : { networkAllowlist: options.networkAllowlist }),
          ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }),
        }),
      };
    }
    case "linux-restricted":
      throw confinementRefusal(
        "profile linux-restricted has no per-child confinement implemented on this node: the" +
          " dedicated OS user / rootless container / read-only root of 10 section 4 is a" +
          " deployment plan (planLinuxHardening) that this process describes and does not apply." +
          " A quality gate executes code the checkout chooses, so it is not run without a" +
          " boundary the OS enforces; verification belongs on a lima-trusted node until this" +
          " profile grows one.",
      );
    default: {
      const exhaustive: never = options.profile;
      throw confinementRefusal(`unknown node profile ${String(exhaustive)}`);
    }
  }
}

/** `sandbox-exec -f <profile> <argv…>`, or the argv unchanged inside a VM. */
export function confineGateArgv(
  plan: GateConfinementPlan,
  profilePath: string,
  argv: readonly string[],
): readonly string[] {
  if (plan.kind === "vm-boundary") return argv;
  return [plan.executable, "-f", profilePath, ...argv];
}
