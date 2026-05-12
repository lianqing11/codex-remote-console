import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import WebSocket from "ws";
import { BaseCodexGateway } from "./baseGateway";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../types";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate local port."));
      });
    });
    server.on("error", reject);
  });
}

async function waitForReady(port: number, child: ChildProcess) {
  const healthUrl = `http://127.0.0.1:${port}/readyz`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) throw new Error(`codex app-server exited with ${child.exitCode}`);

    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      await delay(150);
    }
  }

  throw new Error("Timed out waiting for codex app-server.");
}

function parseMessage(data: WebSocket.RawData) {
  return JSON.parse(data.toString()) as JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
}

export class WsCodexGateway extends BaseCodexGateway {
  private child: ChildProcess | null = null;
  private ws: WebSocket | null = null;

  protected isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  protected async startTransport(onMessage: (message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse) => void) {
    const port = await freePort();
    const child = spawn("codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;

    child.stdout?.on("data", (data) => process.stdout.write(`[codex-app-server] ${data}`));
    child.stderr?.on("data", (data) => process.stderr.write(`[codex-app-server] ${data}`));
    child.on("exit", (code) => {
      this.ws = null;
      this.child = null;
      this.handleTransportClosed(`codex app-server exited with ${code}`);
    });

    await waitForReady(port, child);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.ws = ws;

      ws.on("open", () => resolve());
      ws.on("message", (data) => onMessage(parseMessage(data)));
      ws.on("error", (error) => {
        this.handleTransportError(error);
        reject(error);
      });
      ws.on("close", () => {
        this.ws = null;
        this.handleTransportClosed();
      });
    });
  }

  protected sendJson(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse) {
    if (!this.isOpen()) throw new Error("Codex app-server WebSocket is not connected.");
    this.ws?.send(JSON.stringify(message));
  }

  protected stopTransport() {
    this.ws?.close();
    this.ws = null;
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}
