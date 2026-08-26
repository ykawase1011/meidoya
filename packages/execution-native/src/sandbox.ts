import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxViolationError } from "./errors.js";
import { canonicalize, expandTilde, isWithin } from "./paths.js";
import { findSensitiveSegment } from "./sensitive.js";

export type SandboxOptions = {
  allowedRoots: string[];
  /** Must stay false: never fall back to the whole user home. */
  allowHomeFallback?: boolean;
  /** Exact absolute paths the operator opted into despite being sensitive. */
  explicitlyAllowedSensitivePaths?: string[];
  extraSensitiveSegments?: string[];
  home?: string;
  /** Fixed per-worker cwd; relative paths resolve against it. */
  cwd?: string;
};

export type AccessOptions = {
  /** No-follow: any symlink component (ancestor or leaf) is denied. */
  noFollow?: boolean;
  /** Deny when the leaf is a symlink but allow resolved ancestors. */
  denyLeafSymlink?: boolean;
  mustExist?: boolean;
};

export type ResolvedPath = {
  path: string;
  exists: boolean;
  root: string;
};

/**
 * Allowed-roots filesystem boundary for the mac-restricted / linux-restricted
 * profiles. Fail-closed: anything not provably inside a canonical allowed root
 * is denied.
 */
export class FilesystemSandbox {
  readonly roots: readonly string[];
  readonly cwd: string;
  private readonly home: string;
  private readonly allowedSensitive: readonly string[];
  private readonly extraSensitive: readonly string[];

  constructor(options: SandboxOptions) {
    this.home = options.home ?? os.homedir();
    if (options.allowHomeFallback === true) {
      throw new SandboxViolationError(
        "home-fallback-denied",
        this.home,
        "allow_home_fallback must be false; the whole user home is never an allowed root",
      );
    }
    if (options.allowedRoots.length === 0) {
      throw new SandboxViolationError(
        "invalid-root",
        "<none>",
        "at least one allowed root is required",
      );
    }

    const canonicalHome = safeRealpath(this.home);
    const roots = options.allowedRoots.map((raw) => {
      const expanded = expandTilde(raw, this.home);
      if (!path.isAbsolute(expanded)) {
        throw new SandboxViolationError(
          "invalid-root",
          raw,
          "allowed roots must be absolute",
        );
      }
      // realpath FIRST: a symlinked root must be compared in canonical form.
      const canonical = safeRealpath(expanded);
      if (canonical === undefined) {
        throw new SandboxViolationError(
          "invalid-root",
          raw,
          "allowed root does not exist",
        );
      }
      if (canonical === path.parse(canonical).root) {
        throw new SandboxViolationError(
          "invalid-root",
          raw,
          "filesystem root is never an allowed root",
        );
      }
      if (canonicalHome !== undefined && canonical === canonicalHome) {
        throw new SandboxViolationError(
          "home-fallback-denied",
          raw,
          "the user home directory is never an allowed root",
        );
      }
      return canonical;
    });

    this.roots = Object.freeze(dedupe(roots));
    this.allowedSensitive = Object.freeze(
      (options.explicitlyAllowedSensitivePaths ?? []).map((p) =>
        expandTilde(p, this.home),
      ),
    );
    this.extraSensitive = Object.freeze([
      ...(options.extraSensitiveSegments ?? []),
    ]);

    const cwdRaw = options.cwd ?? this.roots[0];
    const cwd = canonicalize(expandTilde(cwdRaw ?? "", this.home), "/");
    if (cwd === undefined || !cwd.exists) {
      throw new SandboxViolationError(
        "invalid-root",
        String(cwdRaw),
        "worker cwd must exist",
      );
    }
    if (!this.roots.some((root) => isWithin(root, cwd.path))) {
      throw new SandboxViolationError(
        "outside-allowed-roots",
        String(cwdRaw),
        "worker cwd must be inside an allowed root",
        cwd.path,
      );
    }
    this.cwd = cwd.path;
  }

  /** Narrow to a single project / task worktree for the duration of a run. */
  narrowTo(target: string, cwd?: string): FilesystemSandbox {
    const resolved = this.resolve(target, { mustExist: true });
    return new FilesystemSandbox({
      allowedRoots: [resolved.path],
      allowHomeFallback: false,
      explicitlyAllowedSensitivePaths: [...this.allowedSensitive],
      extraSensitiveSegments: [...this.extraSensitive],
      home: this.home,
      cwd: cwd ?? resolved.path,
    });
  }

  isAllowed(candidate: string, options: AccessOptions = {}): boolean {
    try {
      this.resolve(candidate, options);
      return true;
    } catch {
      return false;
    }
  }

  resolve(candidate: string, options: AccessOptions = {}): ResolvedPath {
    if (candidate.length === 0) {
      throw new SandboxViolationError(
        "unresolvable-path",
        candidate,
        "empty path",
      );
    }
    if (candidate.includes("\0")) {
      throw new SandboxViolationError(
        "unresolvable-path",
        candidate,
        "path contains a NUL byte",
      );
    }

    const expanded = expandTilde(candidate, this.home);
    const canonical = canonicalize(expanded, this.cwd);
    if (canonical === undefined) {
      throw new SandboxViolationError(
        "unresolvable-path",
        candidate,
        "path could not be canonicalized",
      );
    }

    if (options.mustExist === true && !canonical.exists) {
      throw new SandboxViolationError(
        "not-found",
        candidate,
        "path does not exist",
        canonical.path,
      );
    }

    if (options.noFollow === true && canonical.symlinkComponents.length > 0) {
      throw new SandboxViolationError(
        "symlink-not-allowed",
        candidate,
        canonical.ancestorSymlink
          ? "ancestor symlink is not allowed for no-follow operations"
          : "leaf symlink is not allowed for no-follow operations",
        canonical.path,
      );
    }
    if (options.denyLeafSymlink === true && canonical.leafSymlink) {
      throw new SandboxViolationError(
        "symlink-not-allowed",
        candidate,
        "leaf symlink is not allowed for this operation",
        canonical.path,
      );
    }

    const root = this.roots.find((r) => isWithin(r, canonical.path));
    if (root === undefined) {
      throw new SandboxViolationError(
        "outside-allowed-roots",
        candidate,
        "resolved path is outside every allowed root",
        canonical.path,
      );
    }

    // Sensitive segments are checked on the *canonical* path, so a benign name
    // symlinked into ~/.ssh is still caught.
    if (!this.allowedSensitive.includes(canonical.path)) {
      const sensitive = findSensitiveSegment(
        canonical.path,
        this.extraSensitive,
      );
      if (sensitive !== undefined) {
        throw new SandboxViolationError(
          "sensitive-path",
          candidate,
          `sensitive path segment "${sensitive}" requires explicit allow`,
          canonical.path,
        );
      }
    }

    return { path: canonical.path, exists: canonical.exists, root };
  }

  /**
   * Re-resolve at use time and confirm the path still canonicalizes to the
   * same location. Closes the gap between an earlier check and the actual
   * operation (TOCTOU).
   */
  verifyStillAllowed(
    candidate: string,
    previouslyResolved: string,
    options: AccessOptions = {},
  ): ResolvedPath {
    const again = this.resolve(candidate, options);
    if (again.path !== previouslyResolved) {
      throw new SandboxViolationError(
        "symlink-not-allowed",
        candidate,
        `path changed between check and use (was ${previouslyResolved})`,
        again.path,
      );
    }
    return again;
  }

  /** Regular-file read with O_NOFOLLOW on the leaf and no symlinked ancestors. */
  readFileNoFollow(candidate: string): Buffer {
    const resolved = this.resolve(candidate, {
      noFollow: true,
      mustExist: true,
    });
    const fd = fs.openSync(resolved.path, fs.constants.O_RDONLY | O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        throw new SandboxViolationError(
          "unresolvable-path",
          candidate,
          "not a regular file",
          resolved.path,
        );
      }
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  statNoFollow(candidate: string): fs.Stats {
    const resolved = this.resolve(candidate, {
      noFollow: true,
      mustExist: true,
    });
    return fs.lstatSync(resolved.path);
  }
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function dedupe(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function safeRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}
