import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeVerificationActivity,
  loadNodeConfig,
  nodeFilesystemBindings,
} from "meidoya-node";
import type { VerificationPlan } from "@meidoya/domain";
import type { QualityGateCatalog } from "@meidoya/task-engine";
import { loadControlPlaneConfig, resolveControlPlaneConfig } from "../config.js";

/**
 * The shipped examples, executed.
 *
 * WHAT THIS EXISTS FOR. `docs/design/config.example.yaml` declared a workspace
 * catalog of `npm test` / `npm run lint` / `npm run typecheck` while
 * `docs/design/node.example.yaml` declared a node allowlist of
 * `/usr/local/bin/vitest run --reporter=dot` and friends. A node justifies the
 * incoming argv against its own list token for token, so an operator who
 * followed both files literally got 100% refusal of every verification — and
 * the whole suite was green, because the only test that read either file
 * PARSED it. Parsing is not agreement, and agreement between two files is not
 * something either file can state on its own. So this test boots BOTH shipped
 * files verbatim, through the real loaders (`loadControlPlaneConfig` +
 * `resolveControlPlaneConfig`, `loadNodeConfig`), and runs a verification
 * through the real `createNodeVerificationActivity`.
 *
 * WHAT IS VERBATIM: EVERYTHING, argv[0] INCLUDED. That is the F10 fix, and it
 * is the whole difference between this version of the file and the last one.
 * This test used to substitute each `argv[0]` with a recording stub keyed by
 * `sha256(path)`, on the theory that the substitution "preserves disagreement".
 * It did preserve disagreement — and it hid a total failure: the examples named
 * `/usr/local/bin/vitest`, `/usr/local/bin/eslint` and `/usr/local/bin/tsc`,
 * none of which exists on a stock machine. Patching `stubFor` to the identity
 * function turned this green test red with `exit-71` — `spawn ENOENT` laundered
 * through a gate exit code — which is exactly what an operator following the
 * documentation got, from a retried Temporal activity, with no path anywhere in
 * the message. Nothing validated that `argv[0]` resolved; `refuseStructurally`
 * only ever checked that it was ABSOLUTE.
 *
 * So the examples now name `/usr/bin/make`, which is at the same absolute path
 * on every machine, and this test spawns it — the real binary, the examples'
 * own argv, token for token including token zero. The one thing the test
 * provides is what an operator's PROJECT provides: a Makefile in the checkout
 * with the three targets the gates invoke, which records the argv it was given.
 *
 * The only substitution left is HOME: `~` is expanded against a temp directory
 * instead of the operator's home, which is what `resolveControlPlaneConfig(
 * config, home)` and `loadNodeConfig(file, home)` take a home parameter for.
 *
 * And a non-resolving `argv[0]` is now DETECTED rather than papered over: see
 * "refuses at startup when a gate's binary is not installed" below, which is
 * the assertion that would have failed on the shipped `/usr/local/bin/vitest`.
 */

const designDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "docs",
  "design",
);

const CONFIG_EXAMPLE = path.join(designDir, "config.example.yaml");
const NODE_EXAMPLE = path.join(designDir, "node.example.yaml");

/** The workspace both example files describe, with its project checkout. */
const WORKSPACE = "work-grammarxiv";

let home: string;

/** Directories the examples' paths point at; created so the loaders accept them. */
const HOME_DIRECTORIES = [
  path.join("Workspace", "Repositories", "GrammarXiv"),
  path.join("Workspace", "Repositories", "product-a"),
  path.join("Workspace", "Repositories", "product-b"),
  path.join("Workspace", "Repositories", "shared-library"),
  path.join(".local", "share", "meidoya", "worktrees"),
];

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "meidoya-examples-")));
  for (const directory of HOME_DIRECTORIES) {
    fs.mkdirSync(path.join(home, directory), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** The checkout the examples bind `work-grammarxiv/grammarxiv` to. */
function checkout(): string {
  return path.join(home, "Workspace", "Repositories", "GrammarXiv");
}

/** Where the checkout's Makefile records the goal `make` was asked for. */
function recordingPath(gateName: string): string {
  return path.join(checkout(), `argv-${gateName}.txt`);
}

/**
 * What the PROJECT provides: a Makefile with the targets the shipped gates
 * invoke, each recording the goal it was given.
 *
 * This is the operator's side of the contract, not a substitution for anything
 * in the examples — the binary that runs is `/usr/bin/make` itself, spawned
 * from the examples' own `argv[0]`. A checkout without these targets makes the
 * gates FAIL, loudly and with make's own message, which is the correct
 * behaviour and the one the old `/usr/local/bin/vitest` pairing could not
 * produce.
 */
function installProjectMakefile(targets: readonly string[]): void {
  const rules = targets.map(
    (target) => `${target}:\n\t@printf '%s\\n' $(MAKECMDGOALS) > argv-${target}.txt\n`,
  );
  fs.writeFileSync(path.join(checkout(), "Makefile"), `${rules.join("\n")}`);
}

function argvByName(catalog: readonly { name: string; argv: readonly string[] }[]): Record<
  string,
  string[]
> {
  return Object.fromEntries(catalog.map((gate) => [gate.name, [...gate.argv]]));
}

describe("the shipped example configs", () => {
  it("agrees token for token and runs its gates for real", async () => {
    const controlPlane = resolveControlPlaneConfig(loadControlPlaneConfig(CONFIG_EXAMPLE), home);
    const node = loadNodeConfig(NODE_EXAMPLE, home);

    const workspace = controlPlane.workspaces.find((w) => w.workspaceId === WORKSPACE);
    const workspaceCatalog = workspace?.qualityGates;

    // The workspace ships a catalog at all. `quality_gates:` used to claim that
    // omitting it "falls back to the built-in defaults"; it does not — an empty
    // block yields `undefined` here and the workflow pauses the task with
    // `no-quality-gate-catalog`.
    expect(workspaceCatalog, "config.example.yaml declares no quality gates").toBeDefined();
    const catalog = workspaceCatalog as QualityGateCatalog;
    expect(catalog.length).toBeGreaterThan(0);
    expect(node.qualityGates.length).toBeGreaterThan(0);

    // THE PROPERTY F2 VIOLATED. The two shipped files must name the same gates
    // with the same argv, token for token, because that is the only comparison
    // `justifyQualityGate` makes. Changing either file alone fails here.
    expect(
      argvByName(catalog),
      "docs/design/config.example.yaml and docs/design/node.example.yaml must declare the same" +
        " gate names and the same argv, token for token, or the node refuses every verification",
    ).toEqual(argvByName(node.qualityGates));

    // And the node's own structural floor, which the examples must also
    // satisfy — plus the one nobody was checking: argv[0] has to EXIST. A
    // shipped example that names a binary this machine does not have fails
    // every gate with exit 71 and no diagnosable message.
    for (const gate of catalog) {
      expect(path.isAbsolute(gate.argv[0] as string), `${gate.name} argv[0] must be absolute`).toBe(
        true,
      );
      expect(() => fs.accessSync(gate.argv[0] as string, fs.constants.X_OK)).not.toThrow();
    }

    const { sandbox, projects, truncated } = nodeFilesystemBindings(node);
    expect(Object.keys(projects[WORKSPACE] ?? {})).toEqual(["grammarxiv"]);

    // The project under test supplies the targets its gates invoke. Taken from
    // the examples' own argv, so renaming a target in either file without the
    // other fails here rather than silently running nothing.
    installProjectMakefile(catalog.flatMap((gate) => gate.argv.slice(1)));

    // The plan SELECTS every gate the workspace configured, by name only.
    const plan: VerificationPlan = { commands: catalog.map((gate) => ({ name: gate.name })) };

    const activity = createNodeVerificationActivity({
      sandbox,
      profile: node.config.node.profile,
      home,
      projects,
      truncatedWorkspaces: truncated,
      grantedWorkspaces: new Set([WORKSPACE]),
      nodeId: node.config.node.id,
      // Each side comes from its OWN file, unmodified: agreement is something
      // the two shipped files have to state, not something the test restores.
      nodeQualityGates: node.qualityGates,
      envAllowlist: node.qualityGateEnv,
      networkAllowlist: node.qualityGateNetwork,
      timeoutMs: 60_000,
    });
    const verify = async (): Promise<Awaited<ReturnType<typeof activity>>> =>
      activity({ workspaceId: WORKSPACE, plan, qualityGates: catalog });

    if (process.platform === "darwin") {
      // `node.example.yaml` says `profile: mac-restricted`, which REQUIRES
      // `/usr/bin/sandbox-exec`: the gates run, confined, and pass.
      const result = await verify();
      expect(result.failureSignature ?? "", JSON.stringify(result)).toBe("");
      expect(result.status).toBe("passed");

      // Every token after argv[0] reached the child exactly as the examples
      // wrote it, and argv[0] itself was the real `/usr/bin/make`.
      for (const gate of catalog) {
        const recorded = fs
          .readFileSync(recordingPath(gate.argv[1] as string), "utf8")
          .split("\n")
          .filter((line) => line.length > 0);
        expect(recorded, `gate ${gate.name} argv`).toEqual([...gate.argv.slice(1)]);
      }
    } else {
      // Everywhere else there is no `sandbox-exec`, and a `mac-restricted` node
      // REFUSES rather than running a gate unconfined. That refusal is the
      // documented behaviour, so it is asserted rather than skipped.
      await expect(verify()).rejects.toMatchObject({
        name: "PolicyViolation",
        message: expect.stringContaining("sandbox-exec"),
      });
    }
  }, 30_000);

  /**
   * F10, as a signal rather than as a stub.
   *
   * The shipped file, edited only where an operator would edit it — the gate's
   * binary — to name the path this repository actually shipped for months. The
   * node must refuse at STARTUP, naming the path, instead of starting happily
   * and answering `exit-71` to every verification for the rest of its life.
   *
   * Deleting `assertNodeQualityGatesResolvable` from `loadNodeConfig` fails
   * here.
   */
  it("refuses at startup when a gate's binary is not installed on this node", () => {
    const absent = path.join(home, "not-installed", "vitest");
    const edited = path.join(home, "node.yaml");
    fs.writeFileSync(
      edited,
      fs.readFileSync(NODE_EXAMPLE, "utf8").replace(/\/usr\/bin\/make/gu, absent),
    );

    expect(() => loadNodeConfig(edited, home)).toThrow(/is not an executable file on this node/);
    expect(() => loadNodeConfig(edited, home)).toThrow(new RegExp(absent.replace(/\//gu, "\\/")));
    // And the shipped file itself passes the same check, which is what "the
    // examples are executable as shipped" means operationally.
    expect(() => loadNodeConfig(NODE_EXAMPLE, home)).not.toThrow();
  });

  it("refuses the pre-fix pairing, so the two files cannot silently drift", async () => {
    // The exact F2 shape: the workspace says `npm test`, the node says what the
    // node example says. Nothing runs, and the refusal names the mismatch.
    const node = loadNodeConfig(NODE_EXAMPLE, home);
    const { sandbox, projects, truncated } = nodeFilesystemBindings(node);
    const activity = createNodeVerificationActivity({
      sandbox,
      profile: node.config.node.profile,
      home,
      projects,
      truncatedWorkspaces: truncated,
      grantedWorkspaces: new Set([WORKSPACE]),
      nodeId: node.config.node.id,
      nodeQualityGates: node.qualityGates,
      envAllowlist: node.qualityGateEnv,
      timeoutMs: 60_000,
    });

    await expect(
      activity({
        workspaceId: WORKSPACE,
        plan: { commands: [{ name: "test" }] },
        qualityGates: [{ name: "test", argv: ["npm", "test"] }],
      }),
    ).rejects.toMatchObject({
      name: "PolicyViolation",
      message: expect.stringContaining("does not match this node's configured argv"),
    });
  });

  it("lets a node host a subset of the workspace's gates", async () => {
    // A node that configures `test` but not `lint` serves a plan selecting only
    // `test`. Entry-by-entry justification refused this, naming a gate nobody
    // asked to run, which made a heterogeneous fleet unusable.
    const node = loadNodeConfig(NODE_EXAMPLE, home);
    const { sandbox, projects, truncated } = nodeFilesystemBindings(node);
    const controlPlane = resolveControlPlaneConfig(loadControlPlaneConfig(CONFIG_EXAMPLE), home);
    const catalog = controlPlane.workspaces.find((w) => w.workspaceId === WORKSPACE)
      ?.qualityGates as QualityGateCatalog;
    const nodeSubset = node.qualityGates.filter((gate) => gate.name === "test");
    expect(nodeSubset).toHaveLength(1);
    installProjectMakefile(catalog.flatMap((gate) => gate.argv.slice(1)));

    const activity = createNodeVerificationActivity({
      sandbox,
      profile: node.config.node.profile,
      home,
      projects,
      truncatedWorkspaces: truncated,
      grantedWorkspaces: new Set([WORKSPACE]),
      nodeId: node.config.node.id,
      nodeQualityGates: nodeSubset,
      envAllowlist: node.qualityGateEnv,
      timeoutMs: 60_000,
    });
    const verify = async (): Promise<Awaited<ReturnType<typeof activity>>> =>
      activity({
        workspaceId: WORKSPACE,
        plan: { commands: [{ name: "test" }] },
        qualityGates: catalog,
      });

    if (process.platform === "darwin") {
      expect((await verify()).status).toBe("passed");
    } else {
      await expect(verify()).rejects.toMatchObject({ name: "PolicyViolation" });
    }

    // Selecting the gate this node does NOT host is still refused, loudly, at
    // the moment a plan actually asks for it.
    await expect(
      activity({
        workspaceId: WORKSPACE,
        plan: { commands: [{ name: "lint" }] },
        qualityGates: catalog,
      }),
    ).rejects.toMatchObject({
      name: "PolicyViolation",
      message: expect.stringContaining("not in this node's configured quality_gates"),
    });
  });
});
