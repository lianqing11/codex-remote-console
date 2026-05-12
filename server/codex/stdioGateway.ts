import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { BaseCodexGateway } from "./baseGateway";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../types";

export class StdioCodexGateway extends BaseCodexGateway {
  private child: ChildProcess | null = null;
  private lines: readline.Interface | null = null;

  protected isOpen() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null && this.child.stdin && !this.child.stdin.destroyed);
  }

  protected startTransport(onMessage: (message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse) => void) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;

      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };

      this.lines = readline.createInterface({
        input: child.stdout!,
        crlfDelay: Infinity
      });
      this.lines.on("line", (line) => {
        if (!line.trim()) return;
        try {
          onMessage(JSON.parse(line) as JsonRpcRequest | JsonRpcNotification | JsonRpcResponse);
        } catch (error) {
          this.handleTransportError(
            new Error(`Could not parse codex app-server message: ${error instanceof Error ? error.message : String(error)}`)
          );
        }
      });

      child.stderr?.on("data", (data) => process.stderr.write(`[codex-app-server] ${data}`));
      child.on("spawn", () => settle(resolve));
      child.on("error", (error) => {
        this.handleTransportError(error);
        settle(() => reject(error));
      });
      child.on("exit", (code) => {
        this.lines?.close();
        this.lines = null;
        this.child = null;
        this.handleTransportClosed(`codex app-server exited with ${code}`);
      });
    });
  }

  protected sendJson(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse) {
    if (!this.isOpen() || !this.child?.stdin) throw new Error("Codex app-server stdio is not connected.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  protected stopTransport() {
    this.lines?.close();
    this.lines = null;
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}
