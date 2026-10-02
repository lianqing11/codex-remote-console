const prefix = "coding-agent-console.draft.v1:";

function storage() {
  try { return typeof window === "undefined" ? null : window.sessionStorage; }
  catch { return null; }
}

export function readSessionDraft(key: string): string {
  try { return storage()?.getItem(prefix + key) || ""; }
  catch { return ""; }
}

export function saveSessionDraft(key: string, text: string) {
  try {
    const target = storage();
    if (text) target?.setItem(prefix + key, text);
    else target?.removeItem(prefix + key);
  } catch { /* Storage denial/quota must not prevent typing or sending. */ }
}
