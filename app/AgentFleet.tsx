"use client";

import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Activity,
  Circle,
  CircleAlert,
  CircleX,
  ListTree,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  X
} from "lucide-react";
import type { FleetSections, FleetSessionView, FleetStatus } from "./fleetModel";
import { AGENT_PROVIDER_LABELS, fastModeLabel, isFastServiceTier } from "./sessionRuntime";
import { epochSeconds } from "./threadModel";

type AgentFleetProps = {
  sections: FleetSections;
  selectedKey: string;
  loadingKey: string | null;
  onSelect: (threadKey: string) => void;
  onTogglePin: (threadKey: string) => void;
  onRename: (threadKey: string) => void;
  onClose: (threadKey: string) => void;
  onManage: (threadKey: string) => void;
};

function statusCopy(status: FleetStatus, queueCount = 0) {
  if (status === "needsInput") return "Needs input";
  if (status === "running") return "Running";
  if (status === "paused") return `Queue paused · ${queueCount} waiting`;
  if (status === "queued") return `${queueCount} queued`;
  if (status === "failed") return "Failed";
  return "Idle";
}

const sameDayTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const otherDayTime = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

function sessionTime(timestamp: number) {
  if (!timestamp) return "Time unavailable";
  const seconds = epochSeconds(timestamp);
  const date = new Date(seconds * 1_000);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return (sameDay ? sameDayTime : otherDayTime).format(date);
}

function StatusIcon({ status }: { status: FleetStatus }) {
  if (status === "needsInput") return <CircleAlert aria-hidden="true" size={15} />;
  if (status === "running") return <LoaderCircle aria-hidden="true" className="fleetSpinner" size={15} />;
  if (status === "paused") return <CircleAlert aria-hidden="true" size={15} />;
  if (status === "queued") return <ListTree aria-hidden="true" size={14} />;
  if (status === "failed") return <CircleX aria-hidden="true" size={15} />;
  return <Circle aria-hidden="true" size={13} />;
}

export type FleetSessionRowProps = {
  thread: FleetSessionView;
  selected: boolean;
  loading: boolean;
  showDirectory: boolean;
  compact?: boolean;
  onSelect: (threadKey: string) => void;
  onTogglePin: (threadKey: string) => void;
  onRename: (threadKey: string) => void;
  onClose: (threadKey: string) => void;
  onManage: (threadKey: string) => void;
};

export const FleetSessionRow = memo(function FleetSessionRow({
  thread,
  selected,
  loading,
  showDirectory,
  compact = false,
  onSelect,
  onTogglePin,
  onRename,
  onClose,
  onManage
}: FleetSessionRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const providerLabel = AGENT_PROVIDER_LABELS[thread.provider] || thread.provider;
  const stateLabel = loading ? "Opening…" : thread.requestLabel || statusCopy(thread.status, thread.queueCount);
  const executionModeLabel = thread.mode === "plan" ? "Plan" : thread.mode === "ask" ? "Ask" : "";

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [menuOpen]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
      menuRef.current?.querySelector("summary")?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])];
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(currentIndex + step + items.length) % items.length]?.focus();
  };

  return (
    <div
      className={`fleetSessionRow status-${thread.status} ${compact ? "compact" : ""} ${selected ? "selected" : ""}`}
      data-session-key={thread.key}
      data-session-mode={thread.mode || "default"}
    >
      <button
        aria-current={selected ? "page" : undefined}
        className="fleetSessionMain"
        type="button"
        onClick={() => onSelect(thread.key)}
      >
        <span className="fleetSessionCopy">
          <span className="fleetSessionTitleLine">
            <span className="fleetStatus" aria-label={statusCopy(thread.status, thread.queueCount)}>
              <StatusIcon status={thread.status} />
            </span>
            <strong title={thread.title}>{thread.title}</strong>
          </span>
          {showDirectory ? (
            <span className="fleetSessionPath" dir="ltr" title={thread.cwd} translate="no">
              {thread.cwd || thread.directory}
            </span>
          ) : null}
          <small className="fleetSessionMeta" aria-label={[providerLabel, stateLabel].join(", ")}>
            {compact ? null : (
              <time dateTime={thread.updatedAt ? new Date((thread.updatedAt > 1e12 ? Math.floor(thread.updatedAt / 1000) : thread.updatedAt) * 1_000).toISOString() : undefined}>
                {sessionTime(thread.updatedAt)}
              </time>
            )}
            {compact ? null : <span aria-hidden="true" className="fleetSessionSeparator">·</span>}
            <span className="fleetSessionProvider">{providerLabel}</span>
            <span aria-hidden="true" className="fleetSessionSeparator">·</span>
            <span className="fleetSessionState">{stateLabel}</span>
            {executionModeLabel ? (
              <span className="fleetSessionRuntime fleetSessionMode">{executionModeLabel}</span>
            ) : null}
            {thread.model ? (
              <span className="fleetSessionRuntime fleetSessionModel" title={`Model: ${thread.model}`}>
                {thread.model}
              </span>
            ) : null}
            {compact ? null : thread.reasoningEffort ? (
              <span
                className="fleetSessionRuntime fleetSessionThinking"
                data-thinking-effort={thread.reasoningEffort}
                title={`Thinking effort: ${thread.reasoningEffort}`}
              >
                Thinking {thread.reasoningEffort}
              </span>
            ) : null}
            {thread.provider === "codex" && thread.serviceTier ? (
              <span
                className={`fleetSessionRuntime fleetSessionFast ${isFastServiceTier(thread.serviceTier) ? "enabled" : ""}`}
                data-service-tier={thread.serviceTier}
                title={`${isFastServiceTier(thread.serviceTier) ? "Fast mode enabled" : "Fast mode disabled"} · Service tier: ${thread.serviceTier}`}
              >
                {fastModeLabel(thread.serviceTier)}
              </span>
            ) : null}
          </small>
        </span>
      </button>
      <details
        className="fleetRowMenu"
        open={menuOpen}
        ref={menuRef}
        onKeyDown={handleMenuKeyDown}
        onToggle={(event) => setMenuOpen(event.currentTarget.open)}
      >
        <summary aria-label={`Session actions for ${thread.title}`} title="Session actions">
          <MoreHorizontal aria-hidden="true" size={16} />
        </summary>
        <div className="fleetRowMenuPopover" role="menu">
          <button role="menuitem" type="button" onClick={() => { onTogglePin(thread.key); setMenuOpen(false); }}>
            {thread.pinned ? <PinOff aria-hidden="true" size={14} /> : <Pin aria-hidden="true" size={14} />}
            {thread.pinned ? "Unpin session" : "Pin session"}
          </button>
          <button role="menuitem" type="button" onClick={() => { onRename(thread.key); setMenuOpen(false); }}>
            <Pencil aria-hidden="true" size={14} />
            Rename
          </button>
          <button role="menuitem" type="button" onClick={() => { onManage(thread.key); setMenuOpen(false); }}>
            <ListTree aria-hidden="true" size={14} />
            Session Manager
          </button>
          <button className="dangerMenuItem" role="menuitem" type="button" onClick={() => { onClose(thread.key); setMenuOpen(false); }}>
            <X aria-hidden="true" size={14} />
            Close
          </button>
        </div>
      </details>
    </div>
  );
});

function FleetSection({
  label,
  icon,
  threads,
  compact,
  ...rowProps
}: Omit<AgentFleetProps, "sections"> & {
  label: string;
  icon: ReactNode;
  threads: FleetSessionView[];
  compact?: boolean;
}) {
  if (!threads.length) return null;
  return (
    <section className="fleetSection" aria-label={label}>
      <header className="fleetSectionHeader">
        <span>{icon}{label}</span>
        <small>{threads.length}</small>
      </header>
      <div className="fleetSectionRows">
        {threads.map((thread) => (
          <FleetSessionRow
            key={`${label}-${thread.key}`}
            thread={thread}
            selected={rowProps.selectedKey === thread.key}
            loading={rowProps.loadingKey === thread.key}
            showDirectory={false}
            compact={compact}
            {...rowProps}
          />
        ))}
      </div>
    </section>
  );
}

export const AgentFleet = memo(function AgentFleet(props: AgentFleetProps) {
  const shared = {
    selectedKey: props.selectedKey,
    loadingKey: props.loadingKey,
    onSelect: props.onSelect,
    onTogglePin: props.onTogglePin,
    onRename: props.onRename,
    onClose: props.onClose,
    onManage: props.onManage
  };

  if (!props.sections.needsYou.length && !props.sections.running.length && !props.sections.queued.length) return null;

  return (
    <div className="agentFleet">
      <header className="fleetNowHeader">
        <span>Now</span>
        <small>Live work stays here until it finishes</small>
      </header>
      <FleetSection
        label="Needs You"
        icon={<CircleAlert aria-hidden="true" size={14} />}
        threads={props.sections.needsYou}
        compact
        {...shared}
      />
      <FleetSection
        label="Running"
        icon={<Activity aria-hidden="true" size={14} />}
        threads={props.sections.running}
        compact
        {...shared}
      />
      <FleetSection
        label="Queued"
        icon={<ListTree aria-hidden="true" size={14} />}
        threads={props.sections.queued}
        compact
        {...shared}
      />
    </div>
  );
});
