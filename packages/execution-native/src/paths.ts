import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandTilde(input: string, home: string = os.homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

export function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}

export type CanonicalPath = {
  /** Fully symlink-resolved absolute path. */
  path: string;
  exists: boolean;
  /** Components (relative to filesystem root) that were symlinks. */
  symlinkComponents: string[];
  /** True when a symlink was crossed before the final component. */
  ancestorSymlink: boolean;
  /** True when the final component itself is a symlink. */
  leafSymlink: boolean;
};

/**
 * Kernel-like resolution: walk one component at a time, resolving symlinks as
 * we go, so `..` is applied to the *canonical* directory. Lexical
 * normalization first (path.resolve) is unsafe: `root/link/../x` would be
 * folded to `root/x` while the kernel would land wherever `link` points.
 */
export function canonicalize(
  input: string,
  base: string,
): CanonicalPath | undefined {
  // Deliberately not path.join: it would fold `..` lexically before we get a
  // chance to resolve symlinks component by component.
  const absolute = path.isAbsolute(input)
    ? input
    : `${base}${path.sep}${input}`;
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const segments = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((s) => s.length > 0 && s !== ".");

  const symlinkComponents: string[] = [];
  let exists = true;
  let leafSymlink = false;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined) continue;
    const isLast = i === segments.length - 1;

    if (segment === "..") {
      // A `..` after a missing component cannot be resolved safely.
      if (!exists) return undefined;
      current = path.dirname(current);
      leafSymlink = false;
      continue;
    }

    const next = path.join(current, segment);
    if (!exists) {
      current = next;
      continue;
    }

    let link = false;
    try {
      link = fs.lstatSync(next).isSymbolicLink();
    } catch {
      exists = false;
      current = next;
      continue;
    }

    if (link) {
      symlinkComponents.push(next);
      if (isLast) leafSymlink = true;
      try {
        current = fs.realpathSync(next);
      } catch {
        return undefined;
      }
      continue;
    }

    current = next;
    leafSymlink = false;
  }

  return {
    path: current,
    exists,
    symlinkComponents,
    ancestorSymlink: symlinkComponents.length > (leafSymlink ? 1 : 0),
    leafSymlink,
  };
}
