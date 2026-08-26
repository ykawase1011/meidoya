import {
  ControlRequestSchema,
  errorResponse,
  okResponse,
  type ControlRequest,
  type ControlResponse,
} from "./envelope.js";
import { ControlPlaneError, controlError } from "./errors.js";
import {
  CONTROL_METHODS,
  isControlMethod,
  type ControlMethod,
  type MethodParams,
  type MethodResult,
} from "./methods.js";
import { findWorkspaceSelector, type ResolvedScope } from "./scope.js";

export type MethodHandlers = {
  [M in ControlMethod]?: (typeof CONTROL_METHODS)[M]["scoped"] extends true
    ? (scope: ResolvedScope, params: MethodParams<M>) => Promise<MethodResult<M>>
    : (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

type AnyHandler = (...args: unknown[]) => Promise<unknown>;

export type ScopeResolver = (token: string) => Promise<ResolvedScope | undefined>;

export type DispatcherOptions = {
  resolveScope: ScopeResolver;
  handlers: MethodHandlers;
  /** Optional authorization hook using the method's declared capability. */
  authorize?: (scope: ResolvedScope, capability: string) => boolean;
};

export async function dispatchRequest(
  raw: unknown,
  options: DispatcherOptions,
): Promise<ControlResponse> {
  const parsed = ControlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      typeof (raw as { id?: unknown })?.id === "string"
        ? (raw as { id: string }).id
        : "unknown",
      controlError("invalid_request", "malformed control request", parsed.error.issues),
    );
  }
  const request: ControlRequest = parsed.data;

  try {
    return okResponse(request.id, await invoke(request, options));
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return errorResponse(request.id, error.toWire());
    }
    return errorResponse(
      request.id,
      controlError(
        "internal_error",
        error instanceof Error ? error.message : "unknown error",
      ),
    );
  }
}

async function invoke(
  request: ControlRequest,
  options: DispatcherOptions,
): Promise<unknown> {
  if (!isControlMethod(request.method)) {
    throw new ControlPlaneError(
      "method_not_found",
      `unknown method: ${request.method}`,
    );
  }
  const method: ControlMethod = request.method;
  const spec = CONTROL_METHODS[method];
  const handler = options.handlers[method];
  if (handler === undefined) {
    throw new ControlPlaneError("method_not_found", `no handler: ${method}`);
  }

  if (spec.scoped) {
    // Checked before schema parsing so the rejection reason is unambiguous.
    const smuggled = findWorkspaceSelector(request.params);
    if (smuggled !== undefined) {
      throw new ControlPlaneError(
        "workspace_id_in_params",
        `workspace scope must arrive as a scope token, not a "${smuggled}" parameter`,
      );
    }
    if (request.scopeToken === undefined) {
      throw new ControlPlaneError(
        "unauthorized_scope",
        `${method} requires a scope token`,
      );
    }
    const scope = await options.resolveScope(request.scopeToken);
    if (scope === undefined) {
      throw new ControlPlaneError("unauthorized_scope", "invalid scope token");
    }
    if (options.authorize && !options.authorize(scope, spec.capability)) {
      throw new ControlPlaneError(
        "capability_denied",
        `role ${scope.role} lacks ${spec.capability}`,
      );
    }
    const params = parseParams(spec.params, request.params);
    return (handler as AnyHandler)(scope, params);
  }

  const params = parseParams(spec.params, request.params);
  return (handler as AnyHandler)(params);
}

function parseParams(
  schema: (typeof CONTROL_METHODS)[ControlMethod]["params"],
  raw: unknown,
): unknown {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ControlPlaneError(
      "invalid_params",
      "params failed validation",
      result.error.issues,
    );
  }
  return result.data;
}
