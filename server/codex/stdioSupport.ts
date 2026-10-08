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

// The console's own settings and secrets must not reach agent shells: they leaked the
// login password, and PORT/NODE_ENV changed how agents' own projects build and serve.
const serverOnlyVariable = /^(CODEX_WEB_|CODE_SERVER_|CODING_AGENT_CONSOLE_|NEXT_)|^(PORT|NODE_ENV)$/;

// Lets Codex ask structured questions (item/tool/requestUserInput) outside Plan mode too.
export const codexFeatureArgs = ["--enable", "default_mode_request_user_input"];

export function codexAppServerArgs(source: Record<string, string | undefined>) {
  const value = source.CODEX_WEB_AUTO_COMPACT_TOKEN_LIMIT?.trim() || "200000";
  const args = ["app-server", "--listen", "stdio://", ...codexFeatureArgs];
  if (value === "inherit") return args;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 10000) {
    throw new Error("CODEX_WEB_AUTO_COMPACT_TOKEN_LIMIT must be an integer >= 10000, or inherit.");
  }
  return [...args, "-c", `model_auto_compact_token_limit=${Number(value)}`];
}

export function childProcessEnv(source: NodeJS.ProcessEnv = process.env) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) if (serverOnlyVariable.test(name)) delete environment[name];
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
