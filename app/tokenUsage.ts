export type TokenUsageSummary = { lifetime: number | null; lastInput: number | null; window: number | null; cached: number | null };
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
export function tokenUsageSummary(value: unknown): TokenUsageSummary {
  const params = value && typeof value === "object" ? value as Record<string, any> : {};
  const wrapper = params.tokenUsage ?? params.usage ?? params;
  const last = wrapper.last;
  const total = wrapper.total;
  return {
    lifetime: number(total?.totalTokens ?? total?.total_tokens),
    lastInput: number(last?.inputTokens ?? last?.input_tokens),
    cached: number(last?.cachedInputTokens ?? last?.cached_input_tokens),
    window: number(wrapper.modelContextWindow ?? params.modelContextWindow)
  };
}

export function formatTokenUsage(value: unknown) {
  const usage = tokenUsageSummary(value);
  const format = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return [
    usage.lastInput !== null ? `Last input ${format(usage.lastInput)} tokens` : "",
    usage.cached !== null ? `${format(usage.cached)} cached` : "",
    usage.window !== null ? `Context limit ${format(usage.window)}` : "",
    usage.lifetime !== null ? `Cumulative usage ${format(usage.lifetime)}` : ""
  ].filter(Boolean).join(" · ");
}
