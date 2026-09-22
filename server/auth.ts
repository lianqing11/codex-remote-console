import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const cookieName = "coding_agent_console_session";
const maxAgeSeconds = 60 * 60 * 24 * 14;
const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() || "";
const cookiePath = configuredBasePath ? `${configuredBasePath.replace(/\/+$/, "")}/` : "/";

function secret() {
  return process.env.CODEX_WEB_SECRET || process.env.CODEX_WEB_PASSWORD || process.env.CODEX_WEB_TOKEN || "dev-secret";
}

export function authEnabled() {
  return Boolean(process.env.CODEX_WEB_PASSWORD || process.env.CODEX_WEB_TOKEN || process.env.CODEX_WEB_AUTH === "on");
}

export function requireProductionAuth() {
  if (process.env.NODE_ENV === "production" && !authEnabled()) {
    throw new Error("Set CODEX_WEB_PASSWORD or CODEX_WEB_TOKEN before running in production.");
  }
}

function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function parseCookies(req: IncomingMessage) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1
          ? [part, ""]
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const loginWindowMs = 60_000;
const loginMaxAttempts = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export function allowLoginAttempt(req: IncomingMessage) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = loginAttempts.get(ip);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + loginWindowMs });
    return true;
  }
  current.count += 1;
  return current.count <= loginMaxAttempts;
}

function cookieSecure() {
  const value = process.env.CODEX_WEB_COOKIE_SECURE;
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function isAuthenticated(req: IncomingMessage) {
  if (!authEnabled()) return true;

  const cookie = parseCookies(req)[cookieName];
  if (!cookie) return false;

  const [issuedAt, signature] = cookie.split(".");
  if (!issuedAt || !signature || !safeEqual(sign(issuedAt), signature)) return false;

  const ageMs = Date.now() - Number(issuedAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeSeconds * 1000;
}

export function validateLogin(input: unknown) {
  if (!authEnabled()) return true;
  if (!input || typeof input !== "object") return false;

  const value = "password" in input ? input.password : "token" in input ? input.token : undefined;
  if (typeof value !== "string") return false;

  const expected = process.env.CODEX_WEB_PASSWORD || process.env.CODEX_WEB_TOKEN || "";
  return Boolean(expected) && safeEqual(value, expected);
}

export function setSessionCookie(res: ServerResponse) {
  const issuedAt = String(Date.now());
  const value = `${issuedAt}.${sign(issuedAt)}`;
  const flags = `Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSecure() ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", `${cookieName}=${encodeURIComponent(value)}; ${flags}`);
}

export function clearSessionCookie(res: ServerResponse) {
  const flags = `Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure() ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", `${cookieName}=; ${flags}`);
}
