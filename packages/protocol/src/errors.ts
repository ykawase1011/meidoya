import { z } from "zod";

export const CONTROL_ERROR_CODES = {
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  internal_error: -32603,
  /** Domain-level errors start at -32000. */
  unauthorized_scope: -32000,
  workspace_id_in_params: -32001,
  not_found: -32002,
  conflict: -32003,
  capability_denied: -32004,
  needs_attention: -32005,
  protocol_version_mismatch: -32006,
} as const;

export type ControlErrorCode = keyof typeof CONTROL_ERROR_CODES;

export const ControlErrorSchema = z.object({
  code: z.number().int(),
  kind: z.enum(
    Object.keys(CONTROL_ERROR_CODES) as [ControlErrorCode, ...ControlErrorCode[]],
  ),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ControlError = z.infer<typeof ControlErrorSchema>;

export class ControlPlaneError extends Error {
  readonly kind: ControlErrorCode;
  readonly code: number;
  readonly details: unknown;

  constructor(kind: ControlErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ControlPlaneError";
    this.kind = kind;
    this.code = CONTROL_ERROR_CODES[kind];
    this.details = details;
  }

  toWire(): ControlError {
    return this.details === undefined
      ? { code: this.code, kind: this.kind, message: this.message }
      : {
          code: this.code,
          kind: this.kind,
          message: this.message,
          details: this.details,
        };
  }
}

export function controlError(
  kind: ControlErrorCode,
  message: string,
  details?: unknown,
): ControlError {
  return new ControlPlaneError(kind, message, details).toWire();
}
