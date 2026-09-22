import type { ProviderId } from "./sessionRuntime";
import { epochSeconds, sessionPhaseClaimsRunning } from "./threadModel";

export type FleetProvider = ProviderId;

export type FleetStatus = "needsInput" | "running" | "queued" | "paused" | "failed" | "idle";

export type FleetThreadSource = {
  key: string;
  provider: FleetProvider;
  title: string;
  cwd: string;
  directory: string;
  updatedAt: number;
  statusLabel: string;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  mode?: string | null;
  queueCount?: number;
  queuePaused?: boolean;
};

export type FleetRequestSource = {
  threadKey: string;
  label: string;
};

export type FleetSessionView = FleetThreadSource & {
  status: FleetStatus;
  requestCount: number;
  requestLabel: string;
  pinned: boolean;
};

export type FleetSections = {
  all: FleetSessionView[];
  needsYou: FleetSessionView[];
  running: FleetSessionView[];
  queued: FleetSessionView[];
  pinned: FleetSessionView[];
};

export { epochSeconds };

type BuildFleetSectionsInput = {
  threads: FleetThreadSource[];
  requests?: FleetRequestSource[];
  activeThreadKeys?: Iterable<string>;
  pendingLiveThreadKeys?: Iterable<string>;
  pinnedThreadKeys?: string[];
};

const failedLabels = new Set(["error", "failed", "failed-after-restart"]);

function normalizedStatusLabel(value: string) {
  return value.replace(/[\s_-]+/g, "").toLowerCase();
}

export function threadStatusClaimsRunning(value: string) {
  return sessionPhaseClaimsRunning(value);
}

export function reconcileActiveTurns<T>(
  current: Record<string, T>,
  threads: Array<Pick<FleetThreadSource, "key" | "statusLabel">>,
  keepKeys: Iterable<string> = []
): Record<string, T> {
  const keep = new Set(keepKeys);
  let next = current;
  for (const thread of threads) {
    if (!(thread.key in next) || threadStatusClaimsRunning(thread.statusLabel) || keep.has(thread.key)) continue;
    if (next === current) next = { ...current };
    delete next[thread.key];
  }
  return next;
}

function statusForThread(
  source: FleetThreadSource,
  activeKeys: Set<string>,
  pendingLiveKeys: Set<string>,
  requestCount: number
): FleetStatus {
  if (requestCount > 0) return "needsInput";
  if (activeKeys.has(source.key) || sessionPhaseClaimsRunning(source.statusLabel)) return "running";
  if (source.queueCount && source.queuePaused) return "paused";
  if (source.queueCount || pendingLiveKeys.has(source.key)) return "queued";
  if (failedLabels.has(normalizedStatusLabel(source.statusLabel))) return "failed";
  return "idle";
}

function recentFirst(left: FleetSessionView, right: FleetSessionView) {
  return right.updatedAt - left.updatedAt || left.title.localeCompare(right.title);
}

export function buildFleetSections({
  threads,
  requests = [],
  activeThreadKeys = [],
  pendingLiveThreadKeys = [],
  pinnedThreadKeys = []
}: BuildFleetSectionsInput): FleetSections {
  const activeKeys = new Set(activeThreadKeys);
  const pendingLiveKeys = new Set(pendingLiveThreadKeys);
  const requestLabels = new Map<string, string[]>();
  for (const request of requests) {
    if (!request.threadKey) continue;
    const labels = requestLabels.get(request.threadKey) || [];
    labels.push(request.label);
    requestLabels.set(request.threadKey, labels);
  }

  const pinnedOrder = new Map(pinnedThreadKeys.map((key, index) => [key, index]));
  const all = threads.map((source) => {
    const labels = requestLabels.get(source.key) || [];
    return {
      ...source,
      status: statusForThread(source, activeKeys, pendingLiveKeys, labels.length),
      requestCount: labels.length,
      requestLabel: [...new Set(labels)].join(" · "),
      pinned: pinnedOrder.has(source.key)
    } satisfies FleetSessionView;
  });

  return {
    all,
    needsYou: all.filter((thread) => thread.status === "needsInput" || thread.status === "paused").sort(recentFirst),
    running: all.filter((thread) => thread.status === "running").sort(recentFirst),
    queued: all.filter((thread) => thread.status === "queued").sort(recentFirst),
    pinned: all
      .filter((thread) => thread.pinned)
      .sort((left, right) => (pinnedOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (pinnedOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER))
  };
}

/** Sessions already shown in the live Now tray. Keep them out of the history list. */
export function attentionThreadKeys(sections: Pick<FleetSections, "needsYou" | "running" | "queued">) {
  return new Set(
    [...sections.needsYou, ...sections.running, ...sections.queued].map((thread) => thread.key)
  );
}
