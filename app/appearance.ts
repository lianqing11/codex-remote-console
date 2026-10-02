export type Appearance = {
  mode: "light" | "dark" | "system";
  accent: "green" | "blue" | "purple" | "amber";
  mobileLayout: "minimal" | "detailed";
};

export const appearanceStorageKey = "coding-agent-console.appearance.v1";
export const defaultAppearance: Appearance = { mode: "light", accent: "green", mobileLayout: "minimal" };

export function parseAppearance(value: unknown): Appearance {
  const input = value && typeof value === "object" ? value as Partial<Appearance> : {};
  return {
    mode: ["light", "dark", "system"].includes(input.mode || "") ? input.mode! : "light",
    accent: ["green", "blue", "purple", "amber"].includes(input.accent || "") ? input.accent! : "green",
    mobileLayout: input.mobileLayout === "detailed" ? "detailed" : "minimal"
  };
}

export function readAppearance(): Appearance {
  try { return parseAppearance(JSON.parse(localStorage.getItem(appearanceStorageKey) || "null")); }
  catch { return { ...defaultAppearance }; }
}

export function applyAppearance(value: Appearance) {
  const root = document.documentElement;
  root.dataset.theme = value.mode === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value.mode;
  root.dataset.accent = value.accent;
  root.dataset.mobileLayout = value.mobileLayout;
}

// Only validated enum values reach DOM attributes; no stored text is executed.
export const appearanceBootstrapScript = `(()=>{let a={};try{a=JSON.parse(localStorage.getItem(${JSON.stringify(appearanceStorageKey)})||'null')||{}}catch{}const r=document.documentElement;const m=['light','dark','system'].includes(a.mode)?a.mode:'light';r.dataset.theme=m==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m;r.dataset.accent=['green','blue','purple','amber'].includes(a.accent)?a.accent:'green';r.dataset.mobileLayout=a.mobileLayout==='detailed'?'detailed':'minimal'})()`;
