import type { IncomingMessage, ServerResponse } from "node:http";

export async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, { error: message });
}
