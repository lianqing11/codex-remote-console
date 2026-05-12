import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const cookieName = "codex_web_session";
const maxAgeSeconds = 60 * 60 * 24 * 14;

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

export function isAuthenticated(req: IncomingMessage) {
  if (!authEnabled()) return true;

  const cookie = parseCookies(req)[cookieName];
  if (!cookie) return false;

  const [issuedAt, signature] = cookie.split(".");
  if (!issuedAt || !signature || sign(issuedAt) !== signature) return false;

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
  res.setHeader(
    "Set-Cookie",
    `${cookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

export function clearSessionCookie(res: ServerResponse) {
  res.setHeader("Set-Cookie", `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
