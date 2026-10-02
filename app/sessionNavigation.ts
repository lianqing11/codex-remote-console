import { useEffect, useRef, useState } from "react";
import { isAgentProviderId, type ProviderId } from "./sessionRuntime";

export type SessionLocation = { provider: ProviderId; session: string; view: "chat" | "files" | "diff" | "runtime" };
const lastLocationKey = "coding-agent-console.location.v1";
const views = new Set(["chat", "files", "diff", "runtime"]);

export function parseSessionLocation(search: string): SessionLocation | null {
  const params = new URLSearchParams(search);
  const provider = params.get("provider");
  if (!isAgentProviderId(provider)) return null;
  const view = params.get("view") || "chat";
  return { provider, session: params.get("session") || "", view: views.has(view) ? view as SessionLocation["view"] : "chat" };
}

export function sessionHref(location: SessionLocation, base = "") {
  const query = new URLSearchParams({ provider: location.provider });
  if (location.session) query.set("session", location.session);
  if (location.view !== "chat") query.set("view", location.view);
  return `${base}?${query}`;
}

export function useSessionNavigation(
  ready: boolean,
  current: SessionLocation,
  restore: (location: SessionLocation) => Promise<void>
) {
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const [restoring, setRestoring] = useState(true);
  const last = useRef("");
  const restoringRef = useRef(true);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let generation = 0;
    async function apply(initial: boolean) {
      const request = ++generation;
      restoringRef.current = true;
      setRestoring(true);
      let target = parseSessionLocation(window.location.search);
      if (initial && !target && !window.location.search) {
        try { target = parseSessionLocation(sessionStorage.getItem(lastLocationKey) || ""); } catch { /* Private browsing. */ }
      }
      if (!target && !initial) target = { provider: "codex", session: "", view: "chat" };
      if (target) await restoreRef.current(target);
      if (disposed || request !== generation) return;
      last.current = ""; // Replace the restored entry; don't add a duplicate Back step.
      restoringRef.current = false;
      setRestoring(false);
    }
    void apply(true);
    const pop = () => { void apply(false); };
    window.addEventListener("popstate", pop);
    return () => { disposed = true; window.removeEventListener("popstate", pop); };
  }, [ready]);

  useEffect(() => {
    if (!ready || restoring || restoringRef.current) return;
    const query = sessionHref(current);
    if (query === last.current) return;
    const url = `${window.location.pathname}${query}${window.location.hash}`;
    if (last.current) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    last.current = query;
    try { sessionStorage.setItem(lastLocationKey, query); } catch { /* Optional persistence. */ }
  }, [ready, restoring, current.provider, current.session, current.view]);
}
