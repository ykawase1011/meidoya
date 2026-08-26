import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGateSandboxProfile,
  confineGateArgv,
  DEFAULT_SANDBOX_EXEC,
  planGateConfinement,
} from "./gate-confinement.js";
import {
  CONFINABLE_SENSITIVE_SEGMENTS,
  daemonStateDenials,
  DEFAULT_SENSITIVE_SEGMENTS,
  findSensitiveSegment,
} from "./sensitive.js";
import { FilesystemSandbox } from "./sandbox.js";

let base: string;
let home: string;
let checkout: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "meidoya-confine-")));
  home = path.join(base, "home");
  checkout = path.join(base, "checkout");
  fs.mkdirSync(home);
  fs.mkdirSync(checkout);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/**
 * The agent runtimes' own on-disk credential stores.
 *
 * `~/.claude/.credentials.json` and `~/.codex/auth.json` are what 10 section 9
 * calls "materialize the credential on the node". `ANTHROPIC_API_KEY` was
 * stripped from every gate environment while these two were not on the
 * sensitive list at all, so the process-local validator would have handed a
 * gate's artifact probe the very file the environment strip existed to protect.
 */
describe("sensitive path segments", () => {
  it("refuses the agent runtimes' credential directories", () => {
    expect(DEFAULT_SENSITIVE_SEGMENTS).toContain(".claude");
    expect(DEFAULT_SENSITIVE_SEGMENTS).toContain(".codex");
    expect(findSensitiveSegment("/Users/x/.claude/.credentials.json")).toBe(".claude");
    expect(findSensitiveSegment("/Users/x/.codex/auth.json")).toBe(".codex");
  });

  it("denies them through the sandbox that guards a checkout", () => {
    fs.mkdirSync(path.join(checkout, ".claude"));
    fs.writeFileSync(path.join(checkout, ".claude", ".credentials.json"), "dummy");
    const sandbox = new FilesystemSandbox({ allowedRoots: [checkout], cwd: checkout });
    expect(() => sandbox.resolve(".claude/.credentials.json")).toThrow(/sensitive path segment/);
  });

  /**
   * `Library` and `System` are on the in-process list and must NOT be on the
   * confinable one: a kernel profile that denies every path containing
   * `/System` or `/Library` denies `/System/Library` — every dylib the gate's
   * own interpreter links against, and the root certificate store. A profile
   * that stops gates from starting is a profile that gets switched off.
   */
  it("keeps segments that a kernel profile must not deny out of the confinable set", () => {
    expect(CONFINABLE_SENSITIVE_SEGMENTS).toContain(".ssh");
    expect(CONFINABLE_SENSITIVE_SEGMENTS).toContain(".claude");
    expect(CONFINABLE_SENSITIVE_SEGMENTS).not.toContain("Library");
    expect(CONFINABLE_SENSITIVE_SEGMENTS).not.toContain("System");
  });
});

describe("gate sandbox profile", () => {
  const build = () => buildGateSandboxProfile({ writableRoots: [checkout], home });

  it("makes writes an allowlist and reads a credential denial", () => {
    const profile = build();
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain(`(subpath "${checkout}")`);
    for (const segment of CONFINABLE_SENSITIVE_SEGMENTS) {
      expect(profile).toContain(`/\\${segment}($|/)`);
    }
    expect(profile).toContain(`(subpath "${path.join(home, "Library/Keychains")}")`);
    // The deny comes BEFORE the allow: SBPL is last-match-wins, so a checkout
    // that lives under the home the profile denies must still be writable.
    expect(profile.indexOf("(deny file-write*)")).toBeLessThan(
      profile.indexOf(`(subpath "${checkout}")`),
    );
  });

  it("refuses to build a profile from paths it cannot state unambiguously", () => {
    expect(() => buildGateSandboxProfile({ writableRoots: ["relative/checkout"], home })).toThrow(
      /must be an absolute path/,
    );
    expect(() => buildGateSandboxProfile({ writableRoots: [], home })).toThrow(
      /at least one writable root/,
    );
    // A quoted path is escaped rather than allowed to end the string literal.
    const quoted = path.join(base, 'we"ird');
    fs.mkdirSync(quoted);
    expect(buildGateSandboxProfile({ writableRoots: [quoted], home })).toContain('we\\"ird');
  });
});

describe("gate confinement per node profile", () => {
  const plan = (profile: "mac-restricted" | "linux-restricted" | "lima-trusted", sandboxExec?: string) =>
    planGateConfinement({
      profile,
      writableRoots: [checkout],
      home,
      ...(sandboxExec === undefined ? {} : { sandboxExec }),
    });

  it("wraps a gate in sandbox-exec on mac-restricted", () => {
    const sandboxExec = path.join(base, "sandbox-exec");
    fs.writeFileSync(sandboxExec, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = plan("mac-restricted", sandboxExec);
    expect(result.kind).toBe("sandbox-exec");
    expect(confineGateArgv(result, "/tmp/gate.sb", ["/usr/bin/true", "-x"])).toEqual([
      sandboxExec,
      "-f",
      "/tmp/gate.sb",
      "/usr/bin/true",
      "-x",
    ]);
  });

  /**
   * The refusal is the point: with no OS boundary there is nothing between a
   * gate — which runs whatever the checkout's `vitest.config.ts` says — and the
   * node's home. Deleting the `isExecutable` check turns this green and returns
   * an unconfined plan.
   */
  it("refuses mac-restricted when sandbox-exec is missing", () => {
    expect(() => plan("mac-restricted", path.join(base, "absent"))).toThrow(
      /requires .*absent to confine a quality gate/,
    );
    expect(() => plan("mac-restricted", path.join(base, "absent"))).toThrow(/refusing to run/i);
  });

  /**
   * linux-restricted takes the OTHER option 10 section 3 leaves open: it
   * refuses to host verification. `planLinuxHardening` produces a PLAN
   * (dedicated OS user, rootless container, read-only root) that no code in
   * this process applies, and a profile whose isolation exists only in a
   * document is the exact shape of the defect this round is about.
   */
  it("refuses verification altogether on linux-restricted", () => {
    expect(() => plan("linux-restricted")).toThrow(/no per-child confinement implemented/);
    expect(() => plan("linux-restricted")).toThrow(/PolicyViolation|lima-trusted/);
  });

  it("leaves the argv alone on lima-trusted, where the guest is the boundary", () => {
    const result = plan("lima-trusted");
    expect(result.kind).toBe("vm-boundary");
    expect(confineGateArgv(result, "/tmp/gate.sb", ["/usr/bin/true"])).toEqual(["/usr/bin/true"]);
  });

  it("names the refusal PolicyViolation so a Temporal retry cannot hide it", () => {
    try {
      plan("linux-restricted");
      expect.unreachable("linux-restricted must refuse");
    } catch (error) {
      expect((error as Error).name).toBe("PolicyViolation");
    }
  });
});

/**
 * THE PROFILE, EXECUTED.
 *
 * Why this describe block exists, and why it is the longest one in the file.
 * The SBPL profile is entirely string literals, and `pnpm mutation` cannot
 * mutate a string — so `gate-confinement.ts` is outside the mutation gate BY
 * CONSTRUCTION, and it is the module the whole "the OS boundary carries the
 * weight" theory rests on. String assertions (`expect(profile).toContain(…)`)
 * do not close that: they check that the generator emitted a line, never that
 * the kernel does anything with it. Every test below therefore spawns a REAL
 * child through the REAL `/usr/bin/sandbox-exec` and the REAL generated
 * profile, and asserts what that child could and could not reach.
 *
 * The measured facts these encode, from the round that produced them: a gate
 * confined by the previous profile read `~/.config/gh/hosts.yml`, read the
 * daemon's `clients/*.secret` bearer file, connected to the daemon's control
 * socket, and reached the internet — all of it while the profile's own comment
 * described the residual as "a gate CAN still read ordinary files elsewhere".
 *
 * DETERMINISM: nothing here depends on the internet being reachable. The
 * network assertions target a listener this test starts itself, so a refusal is
 * the KERNEL saying no (EPERM) and not a connection failing for want of a
 * server — and the allowlisted case proves the listener was there all along.
 */
describe.skipIf(process.platform !== "darwin")("the generated profile, as the kernel applies it", () => {
  /** Obvious dummies. No assertion below ever echoes one. */
  const GH_DUMMY = "oauth_token: gho_dummy-not-a-real-token";
  const BEARER_DUMMY = "BEARER-DUMMY-NOT-A-REAL-CREDENTIAL";

  type Reachability = Record<string, string>;

  let daemonDir: string;
  let socketPath: string;
  let worktree: string;
  let server: net.Server;
  let tcp: net.Server;
  let tcpPort: number;

  beforeEach(async () => {
    // The operator's home, as it really looks: the credential stores that moved
    // to `~/.config` years ago and that the segment list had never followed.
    fs.mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), GH_DUMMY);
    fs.mkdirSync(path.join(home, ".aws"), { recursive: true });
    fs.writeFileSync(path.join(home, ".aws", "credentials"), BEARER_DUMMY);
    fs.writeFileSync(path.join(home, "notes.txt"), "not a credential");

    // The daemon's data_dir, exactly as config.example.yaml lays it out: the
    // per-binding bearer files, the control socket, and every workspace's
    // worktrees — one of which is THIS run's checkout.
    daemonDir = path.join(base, "daemon");
    fs.mkdirSync(path.join(daemonDir, "clients"), { recursive: true });
    fs.writeFileSync(path.join(daemonDir, "clients", "work-acme.secret"), BEARER_DUMMY);
    worktree = path.join(daemonDir, "worktrees", "task-1");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, "src.ts"), "the code under test");
    socketPath = path.join(daemonDir, "meidoya.sock");

    server = net.createServer((socket) => socket.end("daemon-accepted\n"));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    tcp = net.createServer((socket) => socket.end("hello\n"));
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    tcpPort = (tcp.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  });

  /**
   * Runs one probe as a real sandboxed child and returns what it could reach.
   *
   * `spawnSync` on purpose: it cannot leave a child behind, and the timeout
   * bounds a probe that somehow blocks. The probe reports errno strings and
   * booleans only — a file's CONTENTS never leave it.
   */
  function reachability(profile: string): Reachability {
    const profilePath = path.join(base, "probe.sb");
    fs.writeFileSync(profilePath, profile);
    const probe = [
      "const fs=require('fs');const net=require('net');",
      "const read=(p)=>{try{return fs.readFileSync(p,'utf8').length>0?'READABLE':'EMPTY'}catch(e){return e.code||'ERROR'}};",
      "const list=(p)=>{try{fs.readdirSync(p);return 'LISTED'}catch(e){return e.code||'ERROR'}};",
      "const write=(p)=>{try{fs.writeFileSync(p,'x');return 'WROTE'}catch(e){return e.code||'ERROR'}};",
      "const dial=(target)=>new Promise((res)=>{",
      "  const s=net.connect(target);",
      "  const done=(v)=>{s.destroy();res(v)};",
      "  s.on('connect',()=>done('CONNECTED'));s.on('error',(e)=>done(e.code||'ERROR'));",
      "});",
      `const home=${JSON.stringify(home)};const daemon=${JSON.stringify(daemonDir)};`,
      `const sock=${JSON.stringify(socketPath)};const worktree=${JSON.stringify(worktree)};`,
      `const port=${JSON.stringify(tcpPort)};`,
      "(async()=>{process.stdout.write(JSON.stringify({",
      "  ghToken: read(home+'/.config/gh/hosts.yml'),",
      "  awsCredentials: read(home+'/.aws/credentials'),",
      "  plainHomeFile: read(home+'/notes.txt'),",
      "  daemonSecret: read(daemon+'/clients/work-acme.secret'),",
      "  daemonListing: list(daemon+'/clients'),",
      "  ownWorktree: read(worktree+'/src.ts'),",
      "  ownWorktreeWrite: write(worktree+'/out.txt'),",
      "  daemonWrite: write(daemon+'/pwned'),",
      "  controlSocket: await dial(sock),",
      "  tcp: await dial({host:'127.0.0.1',port}),",
      "}))})()",
    ].join("\n");
    const result = spawnSync(
      DEFAULT_SANDBOX_EXEC,
      ["-f", profilePath, process.execPath, "-e", probe],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as Reachability;
  }

  const profileFor = (networkAllowlist: readonly string[] = []): string =>
    buildGateSandboxProfile({
      writableRoots: [checkout, worktree],
      home,
      deniedPaths: daemonStateDenials(socketPath),
      networkAllowlist,
    });

  it("denies the credential stores, the daemon's state and its control socket", () => {
    const seen = reachability(profileFor());

    // (a) The `~/.config` half of F1: `gh` keeps an OAuth token there in
    // cleartext, and `.config` was not on the segment list at all.
    expect(seen.ghToken).toBe("EPERM");
    expect(seen.awsCredentials).toBe("EPERM");
    // The daemon's own state: the bearer file that lets any holder call
    // `session.hello` as any binding, and the socket that accepts it.
    expect(seen.daemonSecret).toBe("EPERM");
    expect(seen.daemonListing).toBe("EPERM");
    expect(seen.controlSocket).toBe("EPERM");
    expect(seen.daemonWrite).toBe("EPERM");
  });

  it("still lets the gate read and write the checkout it was given", () => {
    // The reason `.local` is not denied by segment: a task worktree lives
    // INSIDE the daemon's data dir. Deny it flat and the gate cannot read the
    // code it exists to test. The allow-back covers exactly the run's own
    // roots — `daemonSecret` above is denied by the same profile.
    const seen = reachability(profileFor());
    expect(seen.ownWorktree).toBe("READABLE");
    expect(seen.ownWorktreeWrite).toBe("WROTE");
  });

  it("refuses network egress at the syscall, not at the far end", () => {
    // A listener IS running on that port (this test started it), so
    // ECONNREFUSED would mean the profile did nothing and the far end was
    // simply absent. EPERM is the kernel refusing the connect.
    expect(reachability(profileFor()).tcp).toBe("EPERM");
  });

  it("lets an operator allow one address back, and only that one", () => {
    const seen = reachability(profileFor([`localhost:${tcpPort}`]));
    expect(seen.tcp).toBe("CONNECTED");
    // The allowance is an ADDRESS, so the control socket — a unix path, not an
    // address — is not reachable through it.
    expect(seen.controlSocket).toBe("EPERM");
  });

  it("states its residual honestly: an ordinary file elsewhere is still readable", () => {
    // Not a defect being hidden: reads outside this run's roots are NOT denied
    // by path, and an operator has to know that. What changed is that the
    // residual no longer includes the credential stores, the daemon's bearer
    // files, its socket, or the network.
    expect(reachability(profileFor()).plainHomeFile).toBe("READABLE");
  });

  it("refuses an allowance no OS profile can enforce, rather than emitting one", () => {
    // MEASURED: `(remote ip "github.com:443")` is not a stricter rule than
    // `*:443`, it is a parse error — `sandbox-exec` rejects the profile with
    // "host must be * or localhost in network address" and the gate never
    // starts. An allowlist that silently produced that would be a confinement
    // that turns into an outage, so a spelling the kernel cannot enforce is
    // refused where the operator can read the reason.
    expect(() => profileFor(["github.com:443"])).toThrow(/localhost:<port>/);
    expect(() => profileFor(["127.0.0.1:5432"])).toThrow(/no per-host egress allowlist/);
    expect(() => profileFor(["*"])).toThrow(/OS profile can/);
  });
});
