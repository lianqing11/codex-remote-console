import http from "node:http";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseCursorUsage, type CursorUsageSnapshot } from "../app/cursorUsage";
import { childProcessEnv } from "./codex/stdioSupport";

export type CursorUsageRequest = (url: string, body: string) => Promise<unknown>;

const defaultApiBase = "https://api2.cursor.sh";

function defaultAuthPath() {
  return path.join(homedir(), ".config", "cursor", "auth.json");
}

async function readAccessToken(authPath: string, env: NodeJS.ProcessEnv) {
  const apiKey = env.CURSOR_API_KEY?.trim();
  if (apiKey) return apiKey;
  const parsed = JSON.parse(await readFile(authPath, "utf8")) as { accessToken?: unknown };
  const token = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
  if (!token) throw new Error("Cursor CLI is not logged in.");
  return token;
}

function parseHttpResponse(raw: Buffer) {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("Cursor usage response was truncated.");
  const headerText = raw.subarray(0, headerEnd).toString("utf8");
  const status = Number(/HTTP\/\d(?:\.\d)? (\d+)/.exec(headerText)?.[1] || 0);
  return { status, text: raw.subarray(headerEnd + 4).toString("utf8") };
}

function requestOnce(url: string, options: {
  method: string;
  headers: Record<string, string>;
  body: string;
  proxyUrl?: string | null;
  timeoutMs: number;
}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const target = new URL(url);
    const timer = setTimeout(() => reject(new Error("Cursor usage request timed out.")), options.timeoutMs);
    const done = (value: { status: number; text: string }) => {
      clearTimeout(timer);
      resolve(value);
    };
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const writeRequest = (socket: tls.TLSSocket) => {
      const payload = [
        `${options.method} ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.hostname}`,
        ...Object.entries(options.headers).map(([key, value]) => `${key}: ${value}`),
        `Content-Length: ${Buffer.byteLength(options.body)}`,
        "Connection: close",
        "",
        options.body
      ].join("\r\n");
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => {
        try {
          done(parseHttpResponse(Buffer.concat(chunks)));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", fail);
      socket.write(payload);
    };

    if (!options.proxyUrl) {
      const socket = tls.connect({
        host: target.hostname,
        port: Number(target.port) || 443,
        servername: target.hostname
      }, () => writeRequest(socket));
      socket.on("error", fail);
      return;
    }

    const proxy = new URL(options.proxyUrl);
    const connect = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}` }
    });
    connect.on("connect", (response, socket) => {
      if ((response.statusCode || 500) >= 300) {
        socket.destroy();
        fail(new Error("Cursor usage proxy failed."));
        return;
      }
      const secure = tls.connect({ socket, servername: target.hostname }, () => writeRequest(secure));
      secure.on("error", fail);
    });
    connect.on("error", fail);
    connect.end();
  });
}

export async function fetchCursorUsage(options: {
  authPath?: string;
  apiBase?: string;
  proxyUrl?: string | null;
  env?: NodeJS.ProcessEnv;
  request?: CursorUsageRequest;
  timeoutMs?: number;
} = {}): Promise<CursorUsageSnapshot> {
  const env = options.env || process.env;
  const apiBase = (options.apiBase || env.CURSOR_API_ENDPOINT || defaultApiBase).replace(/\/$/, "");
  const request = options.request || (async (url, body) => {
    const token = await readAccessToken(options.authPath || defaultAuthPath(), env);
    const envProxy = childProcessEnv(env);
    const proxyUrl = options.proxyUrl === undefined
      ? (envProxy.HTTPS_PROXY || envProxy.https_proxy || null)
      : options.proxyUrl;
    const response = await requestOnce(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1"
      },
      body,
      proxyUrl,
      timeoutMs: options.timeoutMs || 12_000
    });
    if (response.status === 401 || response.status === 403) throw new Error("Cursor usage request was unauthorized.");
    if (response.status >= 400) throw new Error(`Cursor usage request failed (${response.status}).`);
    return JSON.parse(response.text);
  });

  const [period, plan] = await Promise.all([
    request(`${apiBase}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, "{}"),
    request(`${apiBase}/aiserver.v1.DashboardService/GetPlanInfo`, "{}").catch(() => null)
  ]);
  const usage = parseCursorUsage(period, plan);
  if (!usage) throw new Error("Cursor usage response was empty.");
  return usage;
}
