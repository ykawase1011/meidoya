import { z } from "zod";

/**
 * A scope token is the only carrier of workspace identity across the Control
 * Plane API. It is minted from an immutable Ingress Binding and is never
 * derived from LLM output (04-roles-and-scopes.md section 8).
 */
declare const scopeTokenBrand: unique symbol;
export type ScopeToken = string & { readonly [scopeTokenBrand]: "ScopeToken" };

export const ScopeTokenSchema = z
  .string()
  .min(1)
  .transform((v) => v as ScopeToken);

export function asScopeToken(raw: string): ScopeToken {
  return ScopeTokenSchema.parse(raw);
}

/**
 * Resolved server-side view of a scope token. Only the Control Plane holds it;
 * it is never accepted as an API parameter.
 */
export type ResolvedScope = {
  readonly workspaceId: string;
  readonly role: "head-maid" | "maid" | "manager" | "worker";
  readonly capabilities: readonly string[];
};

/**
 * Marks a params type as workspace-scoped: `workspaceId` (and its common
 * aliases) become statically un-passable, so `createTask({ workspaceId })`
 * cannot typecheck.
 */
export type NoWorkspaceId<T> = T & {
  readonly workspaceId?: never;
  readonly workspace?: never;
  readonly workspace_id?: never;
};

export const FORBIDDEN_SCOPE_KEYS = [
  "workspaceId",
  "workspace",
  "workspace_id",
  "scopeToken",
  "scope_token",
] as const;

export type ForbiddenScopeKey = (typeof FORBIDDEN_SCOPE_KEYS)[number];

export class WorkspaceIdInParamsError extends Error {
  constructor(public readonly key: string) {
    super(
      `workspace scope must arrive as a scope token, not a "${key}" parameter`,
    );
    this.name = "WorkspaceIdInParamsError";
  }
}

/**
 * Runtime counterpart of NoWorkspaceId: a payload that smuggles a workspace
 * selector is rejected rather than silently ignored, so a model-generated
 * value can never widen scope.
 */
export function assertNoWorkspaceSelector(params: unknown): void {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return;
  }
  for (const key of FORBIDDEN_SCOPE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      throw new WorkspaceIdInParamsError(key);
    }
  }
}

export function findWorkspaceSelector(params: unknown): string | undefined {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  return FORBIDDEN_SCOPE_KEYS.find((key) =>
    Object.prototype.hasOwnProperty.call(params, key),
  );
}

/** Zod guard applied to every workspace-scoped params schema. */
export function scopedParams<T extends z.ZodTypeAny>(schema: T) {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      const key = findWorkspaceSelector(value);
      if (key !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `workspace scope must arrive as a scope token, not a "${key}" parameter`,
        });
      }
    })
    .pipe(schema);
}
