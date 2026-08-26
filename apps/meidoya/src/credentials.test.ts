import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialCandidates, readSessionCredential } from "./credentials.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "meidoya-cred-test-"));
  mkdirSync(path.join(dir, "clients"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCredential(name: string, secret: string, mode = 0o600): string {
  const file = path.join(dir, "clients", name);
  writeFileSync(file, `${secret}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

describe("session credential lookup", () => {
  it("defaults to <socket dir>/clients/<profile>.secret", () => {
    const socketPath = path.join(dir, "meidoya.sock");
    expect(credentialCandidates("alice", socketPath, {})).toEqual([
      path.join(dir, "clients", "alice.secret"),
    ]);
    writeCredential("alice.secret", "dummy-credential-alice");
    expect(readSessionCredential("alice", socketPath, {})).toBe("dummy-credential-alice");
  });

  it("prefers an explicit directory, and an inline secret over any file", () => {
    const socketPath = path.join(dir, "meidoya.sock");
    writeCredential("alice.secret", "dummy-from-file");
    const env = { MEIDOYA_CREDENTIALS_DIR: path.join(dir, "clients") };
    expect(credentialCandidates("alice", socketPath, env)[0]).toBe(
      path.join(dir, "clients", "alice.secret"),
    );
    expect(readSessionCredential("alice", socketPath, env)).toBe("dummy-from-file");
    expect(
      readSessionCredential("alice", socketPath, { ...env, MEIDOYA_CLIENT_SECRET: "dummy-inline" }),
    ).toBe("dummy-inline");
  });

  it("returns nothing when no credential was provisioned", () => {
    expect(readSessionCredential("nobody", path.join(dir, "meidoya.sock"), {})).toBeUndefined();
  });

  it("refuses a credential other users can read", () => {
    writeCredential("alice.secret", "dummy-credential-alice", 0o644);
    expect(() => readSessionCredential("alice", path.join(dir, "meidoya.sock"), {})).toThrow(
      /group\/world accessible/,
    );
  });
});
