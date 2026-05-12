export type ModeKind = "default" | "plan";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
export type ServiceTier = "fast" | "flex" | null;
export type ApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never"
  | { granular: Record<string, boolean> }
  | null;
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access" | null;

export type SessionRuntimeSettings = {
  mode: ModeKind;
  model: string;
  reasoningEffort: ReasoningEffort;
  serviceTier: ServiceTier;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
};

export type PermissionDraft = {
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
};

export type CollaborationModePreset = {
  name?: string | null;
  mode?: ModeKind | null;
  model?: string | null;
  reasoning_effort?: ReasoningEffort;
};

export const defaultRuntimeSettings: SessionRuntimeSettings = {
  mode: "default",
  model: "",
  reasoningEffort: null,
  serviceTier: null,
  approvalPolicy: null,
  sandboxMode: null
};

export function modeLabel(mode: ModeKind) {
  return mode === "plan" ? "Plan" : "Agent";
}

export function withRuntimeMode(settings: SessionRuntimeSettings, mode: ModeKind) {
  return { ...settings, mode };
}

export function buildCollaborationMode(
  settings: SessionRuntimeSettings,
  presets: CollaborationModePreset[],
  modelOverride?: string,
  turnMode: ModeKind = settings.mode
) {
  const preset =
    presets.find((item) => item.mode === turnMode) ||
    presets.find((item) => String(item.name || "").toLowerCase() === (turnMode === "plan" ? "plan" : "default"));
  const model = preset?.model || modelOverride || settings.model;
  if (!model) return undefined;

  return {
    mode: turnMode,
    settings: {
      model,
      reasoning_effort: preset?.reasoning_effort ?? settings.reasoningEffort,
      developer_instructions: null
    }
  };
}

export function runtimeThreadParams(settings: SessionRuntimeSettings) {
  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
    ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
    ...(settings.sandboxMode ? { sandbox: settings.sandboxMode } : {})
  };
}

export function runtimeTurnParams(settings: SessionRuntimeSettings) {
  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
    ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
    ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {})
  };
}

export function runtimePermissionDraft(settings: SessionRuntimeSettings): PermissionDraft {
  return {
    approvalPolicy: settings.approvalPolicy || "on-request",
    sandboxMode: settings.sandboxMode || "workspace-write"
  };
}
