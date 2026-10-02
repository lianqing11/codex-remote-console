// History payloads go to phones on every session open. Tool output dominates them
// (84% of a large Codex session), so long output keeps only its head and tail.
export function clipOutput(text: string, head = 3_000, tail = 1_000) {
  if (text.length <= head + tail + 200) return text;
  return `${text.slice(0, head)}\n\n… ${text.length - head - tail} characters omitted from history …\n\n${text.slice(-tail)}`;
}

export function clipCodexHistory(result: unknown) {
  const turns = (result as { thread?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> } } | null)?.thread?.turns;
  for (const item of (turns || []).flatMap((turn) => turn.items || [])) {
    if (typeof item.aggregatedOutput === "string") item.aggregatedOutput = clipOutput(item.aggregatedOutput);
  }
  return result;
}
