"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { FileDiff, FolderOpen, GitFork, LogOut, Monitor, Moon, Palette, SlidersHorizontal, Sun, X } from "lucide-react";
import type { Appearance } from "./appearance";

function SettingsDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, [tabindex="0"]') || [])];
    focusable()[0]?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keys, true);
    return () => { document.removeEventListener("keydown", keys, true); previous?.focus({ preventScroll: true }); };
  }, []);
  return <div className="settingsBackdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settingsDialog" role="dialog" aria-modal="true" aria-label={title} ref={panel}>
      <header><h2>{title}</h2><button type="button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}><X size={19} /></button></header>
      {children}
    </section>
  </div>;
}

export function AppearanceDialog({ value, onChange, onClose }: { value: Appearance; onChange: (patch: Partial<Appearance>) => void; onClose: () => void }) {
  return <SettingsDialog title="Appearance" onClose={onClose}>
    <fieldset><legend>Color mode</legend><div className="appearanceModes">
      {([ ["light", Sun, "Light"], ["dark", Moon, "Dark"], ["system", Monitor, "System"] ] as const).map(([mode, Icon, label]) =>
        <button key={mode} type="button" aria-pressed={value.mode === mode} onClick={() => onChange({ mode })}><Icon size={19} />{label}</button>)}
    </div></fieldset>
    <fieldset><legend>Accent color</legend><div className="appearanceAccents">
      {(["green", "blue", "purple", "amber"] as const).map(accent =>
        <button key={accent} type="button" aria-pressed={value.accent === accent} onClick={() => onChange({ accent })}><span data-swatch={accent} />{accent[0].toUpperCase() + accent.slice(1)}</button>)}
    </div></fieldset>
    <fieldset><legend>Phone layout</legend><div className="appearanceModes">
      {(["minimal", "detailed"] as const).map(mobileLayout => <button key={mobileLayout} type="button" aria-pressed={value.mobileLayout === mobileLayout} onClick={() => onChange({ mobileLayout })}>{mobileLayout === "minimal" ? "Minimal" : "Detailed"}</button>)}
    </div><p>Desktop keeps the full workspace. Preferences are saved in this browser.</p></fieldset>
  </SettingsDialog>;
}

export function ToolsDialog({ onClose, onView, onAppearance, onDirectory, onFork, onLogout }: {
  onClose: () => void; onView: (view: "files" | "diff" | "runtime") => void;
  onAppearance: () => void; onDirectory: () => void; onFork?: () => void; onLogout: () => void;
}) {
  return <SettingsDialog title="Tools" onClose={onClose}><div className="toolsActions">
    {onFork ? <button type="button" onClick={onFork}><GitFork size={20} />Fork session</button> : null}
    <button type="button" onClick={() => onView("files")}><FolderOpen size={20} />Files</button>
    <button type="button" onClick={() => onView("diff")}><FileDiff size={20} />Changes</button>
    <button type="button" onClick={() => onView("runtime")}><SlidersHorizontal size={20} />Session settings</button>
    <button type="button" onClick={onDirectory}><FolderOpen size={20} />Working directory</button>
    <button type="button" onClick={onAppearance}><Palette size={20} />Appearance</button>
    <button type="button" onClick={onLogout}><LogOut size={20} />Log out</button>
  </div></SettingsDialog>;
}
