import { describe, expect, it } from "vitest";
import { formatDoctorReport, parseTemporalAddress, runDoctor } from "./doctor.js";

describe("doctor", () => {
  it("reports a healthy local installation", async () => {
    const report = await runDoctor(
      {
        configFile: "/config.yaml",
        nodeConfigFile: "/node.yaml",
        temporalAddress: "temporal:7233",
        socketPath: "/meidoya.sock",
        profile: "work",
        env: { PATH: "/bin" },
      },
      {
        fileAccessible: () => true,
        executable: (name) => `/bin/${name}`,
        temporal: async () => undefined,
        credential: () => "secret",
        connect: async () => ({
          systemInfo: async () => ({
            controlProtocolVersion: 1,
            nodeProtocolVersion: 1,
            environmentId: "personal",
          }),
          hello: async () => ({
            scopeToken: "token",
            workspaceId: "work",
            projects: ["project"],
            role: "operator",
          }),
          scoped: async () => ({ nodes: [{ nodeId: "local", status: "online" }] }),
          close: () => undefined,
        }),
        nodeVersion: "20.12.0",
      },
    );

    expect(report.exitCode).toBe(0);
    expect(formatDoctorReport(report)).toContain("[ok  ] execution node: local");
  });

  it("aggregates failures instead of stopping at the first one", async () => {
    const report = await runDoctor(
      { configFile: "/missing", nodeConfigFile: "/missing-node", env: {} },
      {
        fileAccessible: () => false,
        executable: () => undefined,
        temporal: async () => {
          throw new Error("refused");
        },
        credential: () => undefined,
        connect: async () => {
          throw new Error("missing socket");
        },
        nodeVersion: "18.0.0",
      },
    );

    expect(report.exitCode).toBe(1);
    expect(report.checks.filter((item) => item.status === "fail").length).toBeGreaterThan(5);
    expect(formatDoctorReport(report)).toContain("missing socket");
  });

  it("parses hostname and bracketed IPv6 Temporal addresses", () => {
    expect(parseTemporalAddress("localhost:7233")).toEqual({ host: "localhost", port: 7233 });
    expect(parseTemporalAddress("[::1]:7233")).toEqual({ host: "::1", port: 7233 });
    expect(() => parseTemporalAddress("localhost")).toThrow(/host:port/);
  });
});
