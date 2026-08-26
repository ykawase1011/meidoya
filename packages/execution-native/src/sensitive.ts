/**
 * Path segments that are denied unless the operator explicitly allows the
 * exact path (10-execution-nodes-and-security.md section 3).
 */
export const DEFAULT_SENSITIVE_SEGMENTS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".password-store",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".authinfo",
  // The agent runtimes' own on-disk credential stores. 10 section 9 says the
  // vendor credential is node-local and materialized for Codex/Claude — which
  // is precisely `~/.claude/.credentials.json` and `~/.codex/auth.json`. They
  // were missing from this list while `ANTHROPIC_API_KEY` was stripped from
  // every gate environment, so the environment boundary was carefully closed
  // around a file the same process could just read.
  ".claude",
  ".codex",
  // The XDG configuration home, which is where the credential stores that are
  // NOT dot-directories in `$HOME` actually live on a modern machine:
  // `~/.config/gh/hosts.yml` (a GitHub OAuth token in cleartext),
  // `~/.config/gcloud`, `~/.config/git/credentials`, `~/.config/op`. A gate
  // confined by everything above still read all of them, because the list was
  // written in 2010's dotfile layout and the tools moved.
  ".config",
  ".azure",
  "Library",
  "Keychains",
  "Keychain",
  "login.keychain-db",
  "System",
  "private-keys-v1.d",
];

/**
 * The subset of `DEFAULT_SENSITIVE_SEGMENTS` that an OS-level sandbox profile
 * can deny WHOLESALE, at any depth, on any user's home.
 *
 * Only the dot-prefixed segments qualify. `Library` and `System` are the two
 * that must never be denied by segment in a kernel profile: `/System/Library`
 * holds every dylib the gate's own interpreter links against and
 * `/System/Library/Keychains` holds the root certificate store, so denying them
 * does not confine a gate — it stops one from starting, which is how a profile
 * ends up being switched off. Those live in the process-local validator only,
 * where the paths being judged are ones this node was asked to open.
 */
export const CONFINABLE_SENSITIVE_SEGMENTS: readonly string[] =
  DEFAULT_SENSITIVE_SEGMENTS.filter((segment) => segment.startsWith("."));

/**
 * Home-RELATIVE sensitive subtrees an OS profile denies. Kept separate from the
 * segment list because the segment (`Keychains`) is only sensitive under a
 * user's home; the system copy is a public trust store.
 */
export const CONFINABLE_HOME_SUBPATHS: readonly string[] = ["Library/Keychains"];

/**
 * WHY `.local` IS NOT ON EITHER LIST, although it is where this system's own
 * secrets live.
 *
 * `docs/design/config.example.yaml` puts the daemon's `data_dir`, its SQLite
 * database, its client bearer files and its control SOCKET under
 * `~/.local/share/meidoya`, and `node.example.yaml` puts every workspace's
 * worktrees there too. So `.local` looks like the obvious segment to deny — and
 * denying it by segment is wrong twice over:
 *
 *  1. It denies the gate its OWN checkout. A task worktree lives at
 *     `~/.local/share/meidoya/worktrees/<task>`, and it is both a configured
 *     `allowed_root` and the cwd verification narrows to. A segment rule in the
 *     process-local validator would refuse every worktree binding at config
 *     load; the same rule in the SBPL profile would deny the gate reading the
 *     code it is supposed to test.
 *  2. It denies the gate its own TOOLCHAIN. Measured on this machine, under
 *     `(deny file-read* (regex #"/\.local($|/)"))`: `/usr/bin/sandbox-exec`
 *     still EXECS a mise-installed node (exec is not a file read), but that
 *     process cannot then read a single file under `~/.local/share/mise` —
 *     `readdirSync` is EPERM and `require()` of anything installed there is
 *     MODULE_NOT_FOUND. Node survives because its stdlib is compiled in; a
 *     mise-managed python, ruby or pnpm store does not. A profile that stops
 *     gates from starting is a profile the operator switches off.
 *
 * The daemon's state is therefore denied by PATH, not by segment — precisely,
 * from configuration the node already has — and the run's own writable roots
 * are allowed back inside it. See `daemonStateDenials` and
 * `buildGateSandboxProfile`.
 *
 * ---
 *
 * The daemon's own state, as absolute paths a gate sandbox denies outright.
 *
 * Derived from the ONE thing every node already knows about the daemon: the
 * control socket it connects to (`node.control_plane` in node.yaml). Its
 * directory is the daemon's `data_dir` — the SQLite database, the per-binding
 * `clients/*.secret` bearer files, every workspace's worktrees.
 *
 * This is the difference between "a gate can read some files it has no business
 * reading" and "a gate can read the credential that lets it impersonate any
 * binding on the control plane, and then connect to the control plane and use
 * it". `client-credentials.ts` stores that bearer in a file because every agent
 * process runs as the daemon's user; the confinement is what makes the file
 * unreachable from the one process on the node that runs repo-authored code.
 */
export function daemonStateDenials(controlSocketPath: string): readonly string[] {
  const slash = controlSocketPath.lastIndexOf("/");
  const directory = slash > 0 ? controlSocketPath.slice(0, slash) : controlSocketPath;
  // Both, not just the directory: the socket is denied as a path in its own
  // right so that a socket configured OUTSIDE the data dir is still denied.
  return Object.freeze([directory, controlSocketPath]);
}

const NORMALIZED = new Set(
  DEFAULT_SENSITIVE_SEGMENTS.map((s) => s.toLowerCase()),
);

export function isSensitiveSegment(segment: string): boolean {
  return NORMALIZED.has(segment.toLowerCase());
}

export function findSensitiveSegment(
  absolutePath: string,
  extraSegments: readonly string[] = [],
): string | undefined {
  const extra = new Set(extraSegments.map((s) => s.toLowerCase()));
  for (const segment of absolutePath.split("/")) {
    if (segment.length === 0) continue;
    const lower = segment.toLowerCase();
    if (NORMALIZED.has(lower) || extra.has(lower)) return segment;
  }
  return undefined;
}
