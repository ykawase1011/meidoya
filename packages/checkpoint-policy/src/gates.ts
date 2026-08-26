export type ClarificationMode = "never" | "when-needed" | "always";
export type PlanMode = "never" | "on-risk" | "always";
export type ReviewMode = "never" | "on-findings" | "before-complete" | "always";
export type SideEffectMode = "policy" | "always";

export type GateKind = "clarification" | "plan" | "review" | "side-effect";

export type GateModes = {
  clarification: ClarificationMode;
  plan: PlanMode;
  review: ReviewMode;
  "side-effect": SideEffectMode;
};

export type GateOverrides = Partial<GateModes>;

export type PolicyLayerName =
  | "mandatory-security"
  | "task-override"
  | "workspace"
  | "pipeline"
  | "environment-default";

/** Section 2 precedence, strongest first. */
export const POLICY_PRECEDENCE: readonly PolicyLayerName[] = [
  "mandatory-security",
  "task-override",
  "workspace",
  "pipeline",
  "environment-default",
];

/** Weakest to strongest. A lower layer may raise this rank, never lower it. */
const STRICTNESS: { [K in GateKind]: readonly GateModes[K][] } = {
  clarification: ["never", "when-needed", "always"],
  plan: ["never", "on-risk", "always"],
  review: ["never", "on-findings", "before-complete", "always"],
  "side-effect": ["policy", "always"],
};

export const GATE_KINDS: readonly GateKind[] = ["clarification", "plan", "review", "side-effect"];

export function gateStrictness<K extends GateKind>(kind: K, mode: GateModes[K]): number {
  return (STRICTNESS[kind] as readonly string[]).indexOf(mode as string);
}

export type LayeredGatePolicy = {
  mandatorySecurity?: GateOverrides;
  taskOverride?: GateOverrides;
  workspace?: GateOverrides;
  pipeline?: GateOverrides;
  environmentDefault: GateModes;
};

export type ResolvedGate<K extends GateKind = GateKind> = {
  kind: K;
  mode: GateModes[K];
  source: PolicyLayerName;
  mandatory: boolean;
  mandatoryFloor?: GateModes[K];
  relaxationBlocked: boolean;
};

export type ResolvedGates = { [K in GateKind]: ResolvedGate<K> };

export function resolveGate<K extends GateKind>(
  kind: K,
  policy: LayeredGatePolicy,
): ResolvedGate<K> {
  const layers: { name: PolicyLayerName; mode: GateModes[K] | undefined }[] = [
    { name: "task-override", mode: policy.taskOverride?.[kind] },
    { name: "workspace", mode: policy.workspace?.[kind] },
    { name: "pipeline", mode: policy.pipeline?.[kind] },
    { name: "environment-default", mode: policy.environmentDefault[kind] },
  ];

  let chosenName: PolicyLayerName = "environment-default";
  let chosenMode: GateModes[K] = policy.environmentDefault[kind];
  for (const layer of layers) {
    if (layer.mode !== undefined) {
      chosenName = layer.name;
      chosenMode = layer.mode;
      break;
    }
  }

  const floor = policy.mandatorySecurity?.[kind];
  if (floor === undefined) {
    return {
      kind,
      mode: chosenMode,
      source: chosenName,
      mandatory: false,
      relaxationBlocked: false,
    };
  }

  const relaxationBlocked = gateStrictness(kind, chosenMode) < gateStrictness(kind, floor);
  return {
    kind,
    mode: relaxationBlocked ? floor : chosenMode,
    source: relaxationBlocked ? "mandatory-security" : chosenName,
    mandatory: true,
    mandatoryFloor: floor,
    relaxationBlocked,
  };
}

export function resolveGates(policy: LayeredGatePolicy): ResolvedGates {
  return {
    clarification: resolveGate("clarification", policy),
    plan: resolveGate("plan", policy),
    review: resolveGate("review", policy),
    "side-effect": resolveGate("side-effect", policy),
  };
}
