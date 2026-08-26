import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_A, WORKSPACE_B, twoWorkspaces, type TwoWorkspaceFixture } from "./testing/two-workspaces.js";

/**
 * The credential is the ONLY thing that decides whether a caller is allowed to
 * be the binding it names (scope.ts). So two bindings must never be able to
 * share one — and until this file existed, two of them could: the credential
 * file was named after the ingress PROFILE, and a profile is not an identity.
 *
 * Two CLI bindings in different workspaces may legally carry the same profile
 * (their channels tell them apart), and two bindings with no profile at all
 * both collapsed onto `default.secret`. Either way both workspaces were handed
 * the same secret, and a holder of one workspace's secret could mint a
 * full-authority token for the other by naming the other's channel.
 */

let fixture: TwoWorkspaceFixture | undefined;

function two(options: Parameters<typeof twoWorkspaces>[0]): TwoWorkspaceFixture {
  const created = twoWorkspaces(options);
  fixture = created;
  return created;
}

afterEach(async () => {
  if (fixture !== undefined) await fixture.close();
  fixture = undefined;
});

const cli = (channelRef: string | null, profileRef: string | null) =>
  ({ source: "cli", accountRef: null, channelRef, profileRef }) as const;

describe("credentials of two bindings that share an ingress profile", () => {
  const shared = {
    ingressA: { profile: "shared", channel: "chan-a" },
    ingressB: { profile: "shared", channel: "chan-b" },
  };

  it("are different secrets, in different files", () => {
    const f = two(shared);
    expect(f.credentialFileFor(WORKSPACE_A)).not.toBe(f.credentialFileFor(WORKSPACE_B));
    expect(f.secretFor(WORKSPACE_A)).not.toBe(f.secretFor(WORKSPACE_B));
    // The ambiguous alias belongs to neither of them.
    expect(path.basename(f.credentialFileFor(WORKSPACE_A))).not.toBe("shared.secret");
    for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
      expect(statSync(f.credentialFileFor(workspaceId)).mode & 0o777).toBe(0o600);
      expect(f.secretFor(workspaceId).length).toBe(64);
    }
  });

  it("do not let one workspace's secret mint the other's scope token", () => {
    const f = two(shared);
    const secretA = f.secretFor(WORKSPACE_A);

    // The exploit, spelled exactly as `session.hello` would carry it: A's own
    // secret, B's channel, the profile they share.
    expect(f.scopes.mint(cli("chan-b", "shared"), secretA)).toEqual({ reason: "no-binding" });

    // A's own binding still works, so this is authentication and not breakage.
    expect(f.scopes.mint(cli("chan-a", "shared"), secretA)).toMatchObject({
      workspaceId: WORKSPACE_A,
    });
    // And B's secret is the one that opens B.
    expect(f.scopes.mint(cli("chan-b", "shared"), f.secretFor(WORKSPACE_B))).toMatchObject({
      workspaceId: WORKSPACE_B,
    });
  });

  it("do not let one workspace revoke the other's sessions", () => {
    const f = two(shared);
    const before = f.scopes.epochOf(`cli:${WORKSPACE_B}`);
    expect(
      f.scopes.revoke(cli("chan-b", "shared"), f.secretFor(WORKSPACE_A), { scope: "session" }),
    ).toEqual({ reason: "no-binding" });
    expect(f.scopes.epochOf(`cli:${WORKSPACE_B}`)).toBe(before);
  });
});

describe("credentials of two bindings that declare no profile at all", () => {
  const anonymous = {
    ingressA: { profile: null, channel: "chan-a" },
    ingressB: { profile: null, channel: "chan-b" },
  };

  it("do not both collapse onto default.secret", () => {
    const f = two(anonymous);
    expect(path.basename(f.credentialFileFor(WORKSPACE_A))).not.toBe("default.secret");
    expect(f.credentialFileFor(WORKSPACE_A)).not.toBe(f.credentialFileFor(WORKSPACE_B));
    expect(f.secretFor(WORKSPACE_A)).not.toBe(f.secretFor(WORKSPACE_B));
    expect(f.scopes.mint(cli("chan-b", null), f.secretFor(WORKSPACE_A))).toEqual({
      reason: "no-binding",
    });
  });
});

describe("the ordinary one-binding-per-profile case", () => {
  it("keeps the profile-shaped name the CLI looks for", () => {
    const f = two({});
    expect(path.basename(f.credentialFileFor(WORKSPACE_A))).toBe("profile-a.secret");
    expect(path.basename(f.credentialFileFor(WORKSPACE_B))).toBe("profile-b.secret");
    // Exactly where `meidoya --profile profile-a` looks: <socket dir>/clients.
    expect(f.credentialFileFor(WORKSPACE_A)).toBe(
      path.join(path.dirname(f.socketPath), "clients", "profile-a.secret"),
    );
    expect(readFileSync(f.credentialFileFor(WORKSPACE_A), "utf8").trim().length).toBe(64);
  });

  it("still binds each secret to its own workspace", () => {
    const f = two({});
    expect(f.scopes.mint(cli(null, "profile-b"), f.secretFor(WORKSPACE_A))).toEqual({
      reason: "no-binding",
    });
    expect(f.scopes.mint(cli(null, "profile-b"), f.secretFor(WORKSPACE_B))).toMatchObject({
      workspaceId: WORKSPACE_B,
    });
  });
});
