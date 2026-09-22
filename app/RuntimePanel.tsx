"use client";

import { BarChart3, Bot, Box, Cpu, Gauge, ServerCog, ShieldCheck, SlidersHorizontal, Wifi } from "lucide-react";
import { memo } from "react";

export type RuntimePanelData = {
  provider: string;
  version: string;
  connection: string;
  cwd: string;
  threadId: string;
  mode: string;
  model: string;
  reasoning?: string;
  serviceTier?: string;
  usage?: string;
  approval?: string;
  sandbox?: string;
  warning?: string;
  supportsPermissions: boolean;
  supportsMcp: boolean;
};

export const RuntimePanel = memo(function RuntimePanel({
  data,
  onOpenProvider,
  onOpenModel,
  onOpenPermissions,
  onOpenMcp,
  onOpenStatus
}: {
  data: RuntimePanelData;
  onOpenProvider: () => void;
  onOpenModel: () => void;
  onOpenPermissions: () => void;
  onOpenMcp: () => void;
  onOpenStatus: () => void;
}) {
  const facts = [
    { icon: <Bot aria-hidden="true" size={15} />, label: "Provider", value: `${data.provider} · ${data.version}` },
    { icon: <Wifi aria-hidden="true" size={15} />, label: "Connection", value: data.connection },
    { icon: <Cpu aria-hidden="true" size={15} />, label: "Model", value: data.model },
    { icon: <SlidersHorizontal aria-hidden="true" size={15} />, label: "Mode", value: data.mode },
    ...(data.reasoning ? [{ icon: <Gauge aria-hidden="true" size={15} />, label: "Reasoning", value: data.reasoning }] : []),
    ...(data.serviceTier ? [{ icon: <Gauge aria-hidden="true" size={15} />, label: "Service tier", value: data.serviceTier }] : []),
    ...(data.usage ? [{ icon: <BarChart3 aria-hidden="true" size={15} />, label: "Usage", value: data.usage }] : []),
    ...(data.approval ? [{ icon: <ShieldCheck aria-hidden="true" size={15} />, label: "Approval", value: data.approval }] : []),
    ...(data.sandbox ? [{ icon: <Box aria-hidden="true" size={15} />, label: "Sandbox", value: data.sandbox }] : [])
  ];

  return (
    <section className="runtimePanel" aria-label="Session runtime">
      {data.warning ? <p className="runtimeWarning">{data.warning}</p> : null}
      <dl className="runtimeFacts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.icon}<span>{fact.label}</span></dt>
            <dd>{fact.value || "Not reported"}</dd>
          </div>
        ))}
      </dl>
      <div className="runtimeIdentity">
        <span>Session</span>
        <code>{data.threadId || "none"}</code>
        <span>Working directory</span>
        <code>{data.cwd || "none"}</code>
      </div>
      <div className="runtimeActions">
        <button type="button" onClick={onOpenProvider}><ServerCog aria-hidden="true" size={15} />Provider details</button>
        <button type="button" onClick={onOpenModel}><Cpu aria-hidden="true" size={15} />Model</button>
        {data.supportsPermissions ? <button type="button" onClick={onOpenPermissions}><ShieldCheck aria-hidden="true" size={15} />Permissions</button> : null}
        {data.supportsMcp ? <button type="button" onClick={onOpenMcp}><ServerCog aria-hidden="true" size={15} />MCP servers</button> : null}
        <button type="button" onClick={onOpenStatus}><SlidersHorizontal aria-hidden="true" size={15} />Full status</button>
      </div>
    </section>
  );
});
