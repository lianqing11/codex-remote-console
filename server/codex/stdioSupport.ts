import type { CodexGatewayDiagnostic } from "../types";

type DiagnosticInput = Omit<CodexGatewayDiagnostic, "occurredAt">;

const proxyVariables = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "WSS_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "wss_proxy"
] as const;

const defaultNoProxy = "localhost,127.0.0.1,::1";

export function childProcessEnv(source: NodeJS.ProcessEnv = process.env) {
  const environment = { ...source };
  const injectUrl = source.CODEX_WEB_INJECT_PROXY_URL?.trim();
  const fallbackUrl = source.CODEX_WEB_PROXY_URL?.trim();
  const proxyUrl = injectUrl || fallbackUrl;
  if (proxyUrl) {
    if (injectUrl) {
      for (const variable of proxyVariables) environment[variable] = injectUrl;
    } else {
      for (const variable of proxyVariables) environment[variable] ||= proxyUrl;
    }
    environment.NO_PROXY ||= defaultNoProxy;
  }
  for (const [upper, lower] of [
    ["HTTP_PROXY", "http_proxy"],
    ["HTTPS_PROXY", "https_proxy"],
    ["ALL_PROXY", "all_proxy"],
    ["WSS_PROXY", "wss_proxy"],
    ["NO_PROXY", "no_proxy"]
  ] as const) {
    if (environment[upper] && !environment[lower]) environment[lower] = environment[upper];
    if (environment[lower] && !environment[upper]) environment[upper] = environment[lower];
  }
  return environment;
}

export function codexChildEnvironment(source: NodeJS.ProcessEnv) {
  return childProcessEnv(source);
}

export function codexDiagnosticFromStderr(output: string): DiagnosticInput | null {
  const normalized = output.toLowerCase();
  const mentionsResponsesTransport =
    normalized.includes("responses_websocket") ||
    normalized.includes("backend-api/codex/responses") ||
    normalized.includes("wss://chatgpt.com");
  const looksLikeUpstreamFailure =
    normalized.includes("failed to connect") ||
    normalized.includes("connection reset") ||
    normalized.includes("connection closed") ||
    normalized.includes("tls handshake") ||
    normalized.includes("i/o timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("deadline exceeded");

  if (!mentionsResponsesTransport || !looksLikeUpstreamFailure) return null;

  return {
    code: "upstream_connection",
    title: "Codex cannot reach OpenAI",
    detail:
      "Upstream chat connection failed (proxy/node). The console is still online — retry the message or switch to a healthier Singapore node.",
    retrying: true
  };
}
