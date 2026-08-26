import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FrameDecoder, okResponse, encodeFrame } from "@meidoya/protocol";
import {
  parseControlPlaneEndpoint,
  SocketControlPlaneClient,
} from "./control-plane-client.js";

let server: net.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

describe("control plane endpoint", () => {
  it("parses Unix and TCP endpoints", () => {
    expect(parseControlPlaneEndpoint("unix:///tmp/meidoya.sock")).toEqual({
      kind: "unix",
      path: "/tmp/meidoya.sock",
    });
    expect(parseControlPlaneEndpoint("tcp://host.lima.internal:47777")).toEqual({
      kind: "tcp",
      host: "host.lima.internal",
      port: 47777,
    });
  });

  it("refuses malformed TCP endpoints", () => {
    expect(() => parseControlPlaneEndpoint("tcp://host.lima.internal/path")).toThrow();
    expect(() => parseControlPlaneEndpoint("tcp://user@host.lima.internal:47777")).toThrow();
  });

  it("connects and performs the protocol handshake over TCP", async () => {
    server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          const request = frame as { id: string };
          socket.write(
            encodeFrame(
              okResponse(request.id, {
                controlProtocolVersion: 1,
                nodeProtocolVersion: 1,
                environmentId: "tcp-test",
              }),
            ),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing TCP address");

    const client = await SocketControlPlaneClient.connect({
      kind: "tcp",
      host: "127.0.0.1",
      port: address.port,
    });
    await expect(client.systemInfo()).resolves.toEqual({
      controlProtocolVersion: 1,
      nodeProtocolVersion: 1,
      environmentId: "tcp-test",
    });
    client.close();
  });
});
