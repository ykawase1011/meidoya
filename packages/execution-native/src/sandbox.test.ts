import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxViolationError } from "./errors.js";
import { FilesystemSandbox } from "./sandbox.js";

let base: string;
let allowed: string;
let outside: string;
let fakeHome: string;
let sandbox: FilesystemSandbox;

beforeEach(() => {
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "meidoya-sandbox-")),
  );
  allowed = path.join(base, "Workspace", "Repositories");
  outside = path.join(base, "outside");
  fakeHome = path.join(base, "home");
  fs.mkdirSync(path.join(allowed, "project-a", "src"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(allowed, "project-a", "src", "main.ts"), "ok");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.writeFileSync(path.join(fakeHome, ".ssh", "id_ed25519"), "private key");

  sandbox = new FilesystemSandbox({
    allowedRoots: [allowed],
    allowHomeFallback: false,
    home: fakeHome,
    cwd: path.join(allowed, "project-a"),
  });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function expectDenied(fn: () => unknown, reason?: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected the operation to be denied").toBeInstanceOf(
    SandboxViolationError,
  );
  if (reason !== undefined) {
    expect((thrown as SandboxViolationError).reason).toBe(reason);
  }
}

describe("allowed paths", () => {
  it("permits a file inside an allowed root", () => {
    const r = sandbox.resolve("src/main.ts", { mustExist: true });
    expect(r.path).toBe(path.join(allowed, "project-a", "src", "main.ts"));
  });

  it("permits a not-yet-existing file inside an allowed root", () => {
    const r = sandbox.resolve("src/new-file.ts");
    expect(r.exists).toBe(false);
    expect(r.path.startsWith(allowed)).toBe(true);
  });

  it("reads a regular file with no-follow", () => {
    expect(sandbox.readFileNoFollow("src/main.ts").toString()).toBe("ok");
  });
});

describe("adversarial: filesystem escapes are denied", () => {
  it("denies `..` traversal out of the allowed root", () => {
    expectDenied(
      () => sandbox.resolve("../../../outside/secret.txt"),
      "outside-allowed-roots",
    );
  });

  it("denies deep `..` chains that land back on / ", () => {
    expectDenied(
      () => sandbox.resolve("../".repeat(40) + "etc/passwd"),
      "outside-allowed-roots",
    );
  });

  it("denies an absolute path escape", () => {
    expectDenied(
      () => sandbox.resolve(path.join(outside, "secret.txt")),
      "outside-allowed-roots",
    );
    expectDenied(() => sandbox.resolve("/etc/passwd"), "outside-allowed-roots");
  });

  it("denies a leaf symlink pointing outside an allowed root", () => {
    const link = path.join(allowed, "project-a", "escape.txt");
    fs.symlinkSync(path.join(outside, "secret.txt"), link);
    expectDenied(() => sandbox.resolve("escape.txt"), "outside-allowed-roots");
    expectDenied(() => sandbox.readFileNoFollow("escape.txt"));
  });

  it("denies a symlinked ancestor directory pointing outside", () => {
    const linkDir = path.join(allowed, "project-a", "escape-dir");
    fs.symlinkSync(outside, linkDir);
    expectDenied(
      () => sandbox.resolve("escape-dir/secret.txt"),
      "outside-allowed-roots",
    );
  });

  it("denies `link/..` which is inside the root only before realpath", () => {
    // Lexically `escape-dir/../x` folds to `project-a/x` (inside the root);
    // the kernel would land in `outside/..` instead.
    const linkDir = path.join(allowed, "project-a", "escape-dir");
    fs.symlinkSync(outside, linkDir);
    expectDenied(
      () => sandbox.resolve("escape-dir/../nothing.txt"),
      "outside-allowed-roots",
    );
  });

  it("denies a leaf symlink even when its target is also inside the root, under no-follow", () => {
    const link = path.join(allowed, "project-a", "alias.ts");
    fs.symlinkSync(path.join(allowed, "project-a", "src", "main.ts"), link);
    expect(sandbox.resolve("alias.ts", { mustExist: true }).path).toBe(
      path.join(allowed, "project-a", "src", "main.ts"),
    );
    expectDenied(
      () => sandbox.resolve("alias.ts", { noFollow: true }),
      "symlink-not-allowed",
    );
    expectDenied(
      () => sandbox.resolve("alias.ts", { denyLeafSymlink: true }),
      "symlink-not-allowed",
    );
  });

  it("denies an ancestor symlink under no-follow even when the target is inside the root", () => {
    const inner = path.join(allowed, "project-a", "src");
    const linkDir = path.join(allowed, "project-a", "src-alias");
    fs.symlinkSync(inner, linkDir);
    expect(sandbox.resolve("src-alias/main.ts", { mustExist: true }).path).toBe(
      path.join(inner, "main.ts"),
    );
    expectDenied(
      () => sandbox.resolve("src-alias/main.ts", { noFollow: true }),
      "symlink-not-allowed",
    );
  });

  it("denies sensitive paths reached through an in-root symlink", () => {
    const link = path.join(allowed, "project-a", "notes");
    fs.symlinkSync(path.join(fakeHome, ".ssh"), link);
    // outside the root anyway; the sensitive segment is caught when the root
    // itself contains the sensitive directory.
    expectDenied(() => sandbox.resolve("notes/id_ed25519"));

    const sensitiveInsideRoot = path.join(allowed, ".ssh");
    fs.mkdirSync(sensitiveInsideRoot, { recursive: true });
    fs.writeFileSync(path.join(sensitiveInsideRoot, "config"), "x");
    expectDenied(
      () => sandbox.resolve(path.join(sensitiveInsideRoot, "config")),
      "sensitive-path",
    );

    const alias = path.join(allowed, "project-a", "ssh-alias");
    fs.symlinkSync(sensitiveInsideRoot, alias);
    expectDenied(() => sandbox.resolve("ssh-alias/config"), "sensitive-path");
  });

  it("denies Library and Keychain segments inside an allowed root", () => {
    for (const name of ["Library", "Keychains"]) {
      const dir = path.join(allowed, "project-a", name);
      fs.mkdirSync(dir, { recursive: true });
      expectDenied(() => sandbox.resolve(`${name}/file`), "sensitive-path");
    }
  });

  it("allows a sensitive path only when explicitly listed", () => {
    const explicit = path.join(allowed, ".ssh");
    fs.mkdirSync(explicit, { recursive: true });
    fs.writeFileSync(path.join(explicit, "config"), "x");
    const permissive = new FilesystemSandbox({
      allowedRoots: [allowed],
      allowHomeFallback: false,
      home: fakeHome,
      explicitlyAllowedSensitivePaths: [path.join(explicit, "config")],
      cwd: path.join(allowed, "project-a"),
    });
    expect(permissive.resolve(path.join(explicit, "config")).path).toBe(
      path.join(explicit, "config"),
    );
    expectDenied(() => permissive.resolve(path.join(explicit, "other")));
  });

  it("denies a NUL byte and empty paths", () => {
    expectDenied(() => sandbox.resolve(""), "unresolvable-path");
    expectDenied(() => sandbox.resolve("src/main\0.ts"), "unresolvable-path");
  });

  it("denies a tilde path escaping into the home directory", () => {
    expectDenied(() => sandbox.resolve("~/.ssh/id_ed25519"));
  });
});

describe("adversarial: TOCTOU re-resolution", () => {
  it("denies a path that was replaced by an escaping symlink after the check", () => {
    const target = path.join(allowed, "project-a", "report.txt");
    fs.writeFileSync(target, "clean");
    const first = sandbox.resolve("report.txt", { mustExist: true });
    expect(first.path).toBe(target);

    fs.rmSync(target);
    fs.symlinkSync(path.join(outside, "secret.txt"), target);

    expectDenied(
      () => sandbox.verifyStillAllowed("report.txt", first.path),
      "outside-allowed-roots",
    );
  });

  it("denies when an ancestor directory is swapped for a symlink after the check", () => {
    const dir = path.join(allowed, "project-a", "swap");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "f.txt"), "clean");
    const first = sandbox.resolve("swap/f.txt", { mustExist: true });

    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(outside, dir);

    expectDenied(
      () => sandbox.verifyStillAllowed("swap/f.txt", first.path),
      "outside-allowed-roots",
    );
  });

  it("re-resolution succeeds when nothing changed", () => {
    const first = sandbox.resolve("src/main.ts", { mustExist: true });
    expect(sandbox.verifyStillAllowed("src/main.ts", first.path).path).toBe(
      first.path,
    );
  });
});

describe("root configuration is fail-closed", () => {
  it("never allows the whole user home", () => {
    expect(
      () =>
        new FilesystemSandbox({
          allowedRoots: [fakeHome],
          allowHomeFallback: false,
          home: fakeHome,
        }),
    ).toThrow(SandboxViolationError);
  });

  it("rejects allow_home_fallback: true outright", () => {
    expect(
      () =>
        new FilesystemSandbox({
          allowedRoots: [allowed],
          allowHomeFallback: true,
          home: fakeHome,
        }),
    ).toThrow(SandboxViolationError);
  });

  it("rejects the filesystem root, relative roots, missing roots and empty root lists", () => {
    for (const roots of [["/"], ["relative/path"], [path.join(base, "nope")], []]) {
      expect(
        () =>
          new FilesystemSandbox({
            allowedRoots: roots,
            allowHomeFallback: false,
            home: fakeHome,
          }),
      ).toThrow(SandboxViolationError);
    }
  });

  it("canonicalizes a symlinked allowed root before containment checks", () => {
    const linkRoot = path.join(base, "root-link");
    fs.symlinkSync(allowed, linkRoot);
    const s = new FilesystemSandbox({
      allowedRoots: [linkRoot],
      allowHomeFallback: false,
      home: fakeHome,
      cwd: path.join(linkRoot, "project-a"),
    });
    expect(s.roots).toEqual([allowed]);
    expect(s.resolve("src/main.ts", { mustExist: true }).path).toBe(
      path.join(allowed, "project-a", "src", "main.ts"),
    );
    expectDenied(() => s.resolve(path.join(outside, "secret.txt")));
  });

  it("rejects a worker cwd outside the allowed roots", () => {
    expect(
      () =>
        new FilesystemSandbox({
          allowedRoots: [allowed],
          allowHomeFallback: false,
          home: fakeHome,
          cwd: outside,
        }),
    ).toThrow(SandboxViolationError);
  });
});

describe("per-run narrowing", () => {
  it("narrows to the target project and denies sibling projects", () => {
    fs.mkdirSync(path.join(allowed, "project-b"), { recursive: true });
    fs.writeFileSync(path.join(allowed, "project-b", "f.txt"), "b");
    expect(sandbox.isAllowed(path.join(allowed, "project-b", "f.txt"))).toBe(true);

    const narrowed = sandbox.narrowTo(path.join(allowed, "project-a"));
    expect(narrowed.cwd).toBe(path.join(allowed, "project-a"));
    expect(narrowed.isAllowed("src/main.ts")).toBe(true);
    expectDenied(
      () => narrowed.resolve(path.join(allowed, "project-b", "f.txt")),
      "outside-allowed-roots",
    );
  });

  it("cannot narrow to a path outside the parent sandbox", () => {
    expectDenied(() => sandbox.narrowTo(outside), "outside-allowed-roots");
  });
});
