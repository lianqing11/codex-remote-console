"use client";

import { useEffect } from "react";

/** Keep the console above the software keyboard without changing user zoom. */
export function MobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    const touchScreen = window.matchMedia("(any-pointer: coarse)");
    let frame = 0;
    let keyboardOpen = false;

    const reset = () => {
      keyboardOpen = false;
      delete root.dataset.keyboardOpen;
      root.style.removeProperty("--keyboard-viewport-height");
      root.style.removeProperty("--keyboard-viewport-top");
    };

    const update = () => {
      frame = 0;
      if (!touchScreen.matches || window.innerWidth > 1100) {
        reset();
        return;
      }
      // Pinch zoom also shrinks the visual viewport. Leave its geometry alone.
      if (Math.abs(viewport.scale - 1) > 0.05) return;

      const active = document.activeElement;
      const editing = active instanceof HTMLElement && (
        active.matches("textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=file])") ||
        active.isContentEditable
      );
      // Keep tracking the closing animation after the input loses focus.
      keyboardOpen = (editing || keyboardOpen) && window.innerHeight - viewport.height > 100;
      if (!keyboardOpen) {
        reset();
        return;
      }
      root.dataset.keyboardOpen = "true";
      root.style.setProperty("--keyboard-viewport-height", `${viewport.height}px`);
      root.style.setProperty("--keyboard-viewport-top", `${viewport.offsetTop}px`);
    };

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    touchScreen.addEventListener("change", schedule);
    schedule();

    return () => {
      window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      touchScreen.removeEventListener("change", schedule);
      reset();
    };
  }, []);

  return null;
}
