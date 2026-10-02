"use client";

import { useCallback, useEffect, useState } from "react";
import { applyAppearance, appearanceStorageKey, defaultAppearance, parseAppearance, readAppearance, type Appearance } from "./appearance";

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(defaultAppearance);
  useEffect(() => {
    const value = readAppearance();
    setAppearance(value);
    applyAppearance(value);
    const sync = (event: StorageEvent) => {
      if (event.key !== appearanceStorageKey && event.key !== null) return;
      const next = readAppearance();
      setAppearance(next);
      applyAppearance(next);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    if (appearance.mode !== "system") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyAppearance(appearance);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [appearance]);
  const updateAppearance = useCallback((patch: Partial<Appearance>) => {
    setAppearance(current => {
      const next = parseAppearance({ ...current, ...patch });
      applyAppearance(next);
      try { localStorage.setItem(appearanceStorageKey, JSON.stringify(next)); } catch { /* Preferences are optional. */ }
      return next;
    });
  }, []);
  return { appearance, updateAppearance };
}
