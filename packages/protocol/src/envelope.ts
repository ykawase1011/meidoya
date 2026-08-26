import { z } from "zod";
import { ControlErrorSchema } from "./errors.js";

export const CONTROL_PROTOCOL_VERSION = 1 as const;

/** Newline-delimited JSON over the unix socket; no HTTP framework involved. */
export const MAX_FRAME_BYTES = 1_048_576;

export const ControlRequestSchema = z.object({
  v: z.literal(CONTROL_PROTOCOL_VERSION),
  id: z.string().min(1),
  method: z.string().min(1),
  /** Present only for workspace-scoped methods; never a workspace id. */
  scopeToken: z.string().min(1).optional(),
  params: z.unknown(),
});
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

export const ControlResponseSchema = z.union([
  z.object({
    v: z.literal(CONTROL_PROTOCOL_VERSION),
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    v: z.literal(CONTROL_PROTOCOL_VERSION),
    id: z.string().min(1),
    ok: z.literal(false),
    error: ControlErrorSchema,
  }),
]);
export type ControlResponse = z.infer<typeof ControlResponseSchema>;

/** Server-initiated frame (progress, task events). Carries no request id. */
export const ControlNotificationSchema = z.object({
  v: z.literal(CONTROL_PROTOCOL_VERSION),
  event: z.string().min(1),
  payload: z.unknown(),
});
export type ControlNotification = z.infer<typeof ControlNotificationSchema>;

export const ControlFrameSchema = z.union([
  ControlRequestSchema,
  ControlResponseSchema,
  ControlNotificationSchema,
]);
export type ControlFrame = z.infer<typeof ControlFrameSchema>;

export function encodeFrame(frame: ControlFrame): string {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(`control frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return `${line}\n`;
}

export class FrameTooLargeError extends Error {
  constructor(limit: number) {
    super(`control frame exceeds ${limit} bytes`);
    this.name = "FrameTooLargeError";
  }
}

/**
 * Bounded NDJSON decoder: an unterminated oversized frame fails closed rather
 * than buffering without limit.
 */
export class FrameDecoder {
  private buffer = "";

  constructor(private readonly maxBytes: number = MAX_FRAME_BYTES) {}

  push(chunk: string | Buffer): unknown[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const frames: unknown[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) {
        if (Buffer.byteLength(line, "utf8") > this.maxBytes) {
          throw new FrameTooLargeError(this.maxBytes);
        }
        frames.push(JSON.parse(line));
      }
      index = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBytes) {
      this.buffer = "";
      throw new FrameTooLargeError(this.maxBytes);
    }
    return frames;
  }
}

export function okResponse(id: string, result: unknown): ControlResponse {
  return { v: CONTROL_PROTOCOL_VERSION, id, ok: true, result };
}

export function errorResponse(
  id: string,
  error: z.infer<typeof ControlErrorSchema>,
): ControlResponse {
  return { v: CONTROL_PROTOCOL_VERSION, id, ok: false, error };
}
