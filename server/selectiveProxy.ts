import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

const allowHostSuffixes = ["chatgpt.com", "openai.com", "cursor.sh", "cursor.com", "anthropic.com", "claude.ai"] as const;

export function shouldProxyHost(host: string) {
  const hostname = host.split(":")[0].trim().toLowerCase();
  return allowHostSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function hostPort(authority: string, fallbackPort: number) {
  const [host, port] = authority.split(":");
  return { host, port: Number(port) || fallbackPort };
}

function pipeSockets(left: Duplex, right: Duplex, head: Buffer) {
  if (head.length) right.write(head);
  right.pipe(left);
  left.pipe(right);
}

function fail(socket: Duplex, status: string) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
}

function tunnelDirect(authority: string, client: Duplex, head: Buffer) {
  const { host, port } = hostPort(authority, 443);
  const upstream = net.connect(port, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    pipeSockets(client, upstream, head);
  });
  upstream.on("error", () => fail(client, "502 Bad Gateway"));
  client.on("error", () => upstream.destroy());
}

function tunnelViaProxy(proxy: URL, authority: string, client: Duplex, head: Buffer) {
  const req = http.request({
    protocol: proxy.protocol,
    hostname: proxy.hostname,
    port: proxy.port || 80,
    method: "CONNECT",
    path: authority,
    headers: { Host: authority }
  });
  req.on("connect", (_res, socket) => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    pipeSockets(client, socket, head);
  });
  req.on("error", () => fail(client, "502 Bad Gateway"));
  client.on("error", () => req.destroy());
  req.end();
}

function forwardHttp(req: http.IncomingMessage, res: http.ServerResponse, proxy: URL) {
  const target = new URL(req.url || "", "http://invalid");
  const viaProxy = shouldProxyHost(target.hostname);
  const forwarded = http.request(
    viaProxy
      ? {
          hostname: proxy.hostname,
          port: proxy.port || 80,
          method: req.method,
          path: req.url,
          headers: req.headers
        }
      : {
          hostname: target.hostname,
          port: target.port || 80,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: req.headers
        },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    }
  );
  forwarded.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(forwarded);
}

export function startSelectiveProxy(options: { upstreamUrl: string; port?: number }) {
  const proxy = new URL(options.upstreamUrl);
  const server = http.createServer((req, res) => forwardHttp(req, res, proxy));
  server.on("connect", (req, client, head) => {
    const authority = req.url || "";
    if (shouldProxyHost(authority)) tunnelViaProxy(proxy, authority, client, head);
    else tunnelDirect(authority, client, head);
  });

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("selective proxy failed to bind"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done()))
      });
    });
  });
}

export async function attachSelectiveProxy(source: NodeJS.ProcessEnv = process.env) {
  const upstreamUrl = source.CODEX_WEB_PROXY_URL?.trim();
  if (!upstreamUrl) return null;
  const started = await startSelectiveProxy({ upstreamUrl });
  source.CODEX_WEB_INJECT_PROXY_URL = started.url;
  console.log(`[selective-proxy] ${started.url} allowlist -> ${upstreamUrl}; other traffic direct`);
  return started;
}
