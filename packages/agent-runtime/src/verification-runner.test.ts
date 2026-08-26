import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  VERIFICATION_EXIT,
  createVerificationCommandRunner,
  type AllowedCommandCatalog,
} from "./verification-runner.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "meidoya-verify-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const catalog: AllowedCommandCatalog = [
  { name: "test", argv: [process.execPath, "-e", "process.exit(0)"] },
  { name: "lint", argv: [process.execPath, "-e", "process.exit(3)"] },
];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe("verification command runner", () => {
  it("runs an allowlisted gate and reports its exit code", async () => {
    const runner = createVerificationCommandRunner({ catalog, cwd: dir });
    await expect(runner.run({ name: "test" })).resolves.toMatchObject({ exitCode: 0 });
    await expect(runner.run({ name: "lint" })).resolves.toMatchObject({
      exitCode: 3,
      failureSignature: "lint:exit-3",
    });
  });

  it("refuses a gate the operator did not configure", async () => {
    const runner = createVerificationCommandRunner({ catalog, cwd: dir });
    const result = await runner.run({ name: "deploy" });
    expect(result).toMatchObject({
      exitCode: VERIFICATION_EXIT.denied,
      failureSignature: "deploy:command-not-allowlisted",
    });
    expect(result.resolvedCommand).toBeUndefined();
  });

  it("ignores a legacy command line smuggled beside the name", async () => {
    const runner = createVerificationCommandRunner({ catalog, cwd: dir });
    const marker = path.join(dir, "smuggled");
    const result = await runner.run({
      name: "test",
      command: `${process.execPath} -e "require('fs').writeFileSync(${JSON.stringify(marker)},'x')"`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.resolvedCommand).toBe(catalog[0]?.argv.join(" "));
    expect(existsSync(marker)).toBe(false);
  });

  describe("shell metacharacters cannot start a second process", () => {
    const payloads = [
      "test; touch pwned",
      "test && touch pwned",
      "test | touch pwned",
      "test $(touch pwned)",
      "test `touch pwned`",
      "test\ntouch pwned",
      "test & touch pwned",
    ];

    it.each(payloads)("rejects %j without spawning anything", async (name) => {
      const runner = createVerificationCommandRunner({ catalog, cwd: dir });
      const result = await runner.run({ name });
      expect(result.exitCode).toBe(VERIFICATION_EXIT.denied);
      expect(result.failureSignature).toBe(`${name}:invalid-command-name`);
      // Give any (nonexistent) shell child a moment to land.
      await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(path.join(dir, "pwned"))).toBe(false);
    });

    it("cannot inject through an allowlisted gate's arguments either", async () => {
      // Even if a configured gate takes an argument that *looks* like shell
      // syntax, it is one literal argv entry: no shell ever sees it.
      const echoing: AllowedCommandCatalog = [
        {
          name: "test",
          argv: [
            process.execPath,
            "-e",
            "require('fs').writeFileSync('argv.txt', process.argv.slice(1).join('|'))",
            "; touch pwned",
          ],
        },
      ];
      const runner = createVerificationCommandRunner({ catalog: echoing, cwd: dir });
      await runner.run({ name: "test" });
      expect(readFileSync(path.join(dir, "argv.txt"), "utf8")).toBe("; touch pwned");
      expect(existsSync(path.join(dir, "pwned"))).toBe(false);
    });
  });

  it("cannot exfiltrate a sandbox-denied file (the reported attack)", async () => {
    // The demonstrated attack: `cat <secret> > <outside>` as a plan command.
    const secret = path.join(dir, "scope-secret");
    writeFileSync(secret, "s3cr3t");
    const outside = path.join(dir, "leak");
    const runner = createVerificationCommandRunner({ catalog, cwd: dir });

    const result = await runner.run({
      name: `test; cat ${secret} > ${outside}`,
    });

    expect(result.exitCode).toBe(VERIFICATION_EXIT.denied);
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(outside)).toBe(false);
  });

  it("denies a cwd the sandbox rejects, without spawning", async () => {
    const runner = createVerificationCommandRunner({
      catalog,
      cwd: dir,
      resolveCwd: () => {
        const error = new Error("outside allowed roots");
        error.name = "SandboxDeniedError";
        throw error;
      },
    });
    await expect(runner.run({ name: "test" })).resolves.toMatchObject({
      exitCode: VERIFICATION_EXIT.denied,
      failureSignature: "test:sandbox-denied:SandboxDeniedError",
    });
  });

  it("kills a backgrounded grandchild when the gate times out", async () => {
    const pidFile = path.join(dir, "grandchild.pid");
    const spawner = [
      process.execPath,
      "-e",
      [
        "const {spawn}=require('child_process');",
        "const fs=require('fs');",
        `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
        "setInterval(()=>{},1000);",
      ].join(""),
    ];
    const runner = createVerificationCommandRunner({
      catalog: [{ name: "test", argv: spawner }],
      cwd: dir,
      timeoutMs: 500,
      killGraceMs: 100,
    });

    const result = await runner.run({ name: "test" });
    expect(result.exitCode).toBe(VERIFICATION_EXIT.timeout);

    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(await waitUntil(() => !alive(pid))).toBe(true);
  });

  it("kills a backgrounded grandchild on cancel", async () => {
    const pidFile = path.join(dir, "grandchild.pid");
    const spawner = [
      process.execPath,
      "-e",
      [
        "const {spawn}=require('child_process');",
        "const fs=require('fs');",
        `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
        "setInterval(()=>{},1000);",
      ].join(""),
    ];
    const controller = new AbortController();
    const runner = createVerificationCommandRunner({
      catalog: [{ name: "test", argv: spawner }],
      cwd: dir,
      killGraceMs: 100,
      signal: controller.signal,
    });

    const running = runner.run({ name: "test" });
    await waitUntil(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();

    const result = await running;
    expect(result.exitCode).toBe(VERIFICATION_EXIT.cancelled);
    expect(await waitUntil(() => !alive(pid))).toBe(true);
  });

  // The `enabled: false` half of this test was DELETED along with the option it
  // pinned. Nothing but the test ever set it; wiring it from node config would
  // have made every gate exit 126 and every task fail with the signature
  // "verification-disabled" — the quiet failure mode this package exists to not
  // have. An unreachable branch kept alive by its own test is not coverage.
  it("refuses to run once cancelled", async () => {
    const controller = new AbortController();
    const runner = createVerificationCommandRunner({
      catalog,
      cwd: dir,
      signal: controller.signal,
    });
    controller.abort();
    await expect(runner.run({ name: "test" })).resolves.toMatchObject({
      exitCode: VERIFICATION_EXIT.cancelled,
    });
  });

  it("detaches from the caller's abort signal when cancelled, so runners do not pile up", async () => {
    // One runner per verification on a process-lifetime signal used to retain
    // one `abort` listener each, and every listener pinned that runner's
    // in-flight set and catalog.
    const controller = new AbortController();
    const runners = Array.from({ length: 15 }, () =>
      createVerificationCommandRunner({ catalog, cwd: dir, signal: controller.signal }),
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(15);

    for (const runner of runners) runner.cancel();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    // Detaching does not resurrect a cancelled runner.
    await expect(runners[0]!.run({ name: "test" })).resolves.toMatchObject({
      exitCode: VERIFICATION_EXIT.cancelled,
    });
  });
});
