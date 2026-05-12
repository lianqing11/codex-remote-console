import { autoApprovalForRequest } from "../approvalPolicy";
import type {
  BrowserEvent,
  CodexGatewaySnapshot,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse
} from "../types";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const requestTimeoutMs = 120_000;

export abstract class BaseCodexGateway {
  private requestSeq = 1;
  private startPromise: Promise<void> | null = null;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private serverRequests = new Map<JsonRpcId, JsonRpcRequest>();
  private subscribers = new Set<(event: BrowserEvent) => void>();
  private initializeInfo: unknown = null;
  private collaborationModes: unknown[] = [];

  subscribe(callback: (event: BrowserEvent) => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getSnapshot(): CodexGatewaySnapshot {
    return {
      initializeInfo: this.initializeInfo,
      collaborationModes: this.collaborationModes,
      pendingServerRequests: Array.from(this.serverRequests.values())
    };
  }

  async ensureStarted() {
    if (this.isOpen()) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async request(method: string, params?: unknown) {
    await this.ensureStarted();
    if (!this.isOpen()) throw new Error("Codex app-server is not connected.");

    const id = this.requestSeq++;
    const payload = params === undefined ? { id, method } : { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.sendJson(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async respondToServerRequest(id: JsonRpcId, result: unknown) {
    await this.ensureStarted();
    if (!this.isOpen()) throw new Error("Codex app-server is not connected.");

    this.sendJson({ id, result });
    this.serverRequests.delete(id);
    this.broadcast({ type: "codex:serverRequestResolved", requestId: id });
  }

  stop() {
    this.stopTransport();
    this.rejectPending(new Error("Codex gateway stopped."));
    this.serverRequests.clear();
  }

  protected abstract isOpen(): boolean;
  protected abstract startTransport(onMessage: (message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse) => void): Promise<void>;
  protected abstract sendJson(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void;
  protected abstract stopTransport(): void;

  protected handleTransportClosed(detail?: string) {
    this.rejectPending(new Error(detail || "Codex app-server connection closed."));
    this.serverRequests.clear();
    this.broadcast({ type: "gateway:state", status: "disconnected", detail });
  }

  protected handleTransportError(error: Error) {
    this.broadcast({ type: "gateway:state", status: "error", detail: error.message });
  }

  private async start() {
    this.broadcast({ type: "gateway:state", status: "starting" });
    await this.startTransport((message) => this.handleMessage(message));

    this.initializeInfo = await this.request("initialize", {
      clientInfo: { name: "codex-web", version: "0.1.0" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] }
    });
    this.notify({ method: "initialized" });

    try {
      const modes = await this.request("collaborationMode/list", {});
      this.collaborationModes =
        modes && typeof modes === "object" && "data" in modes && Array.isArray(modes.data) ? modes.data : [];
    } catch (error) {
      this.collaborationModes = [];
      this.broadcast({
        type: "gateway:state",
        status: "error",
        detail: error instanceof Error ? error.message : String(error)
      });
    }

    this.broadcast({ type: "gateway:state", status: "connected" });
  }

  private handleMessage(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse) {
    if ("id" in message && !("method" in message)) {
      this.handleResponse(message);
      return;
    }

    if ("id" in message && "method" in message) {
      const autoApproval = autoApprovalForRequest(message);
      if (autoApproval) {
        this.sendJson({ id: message.id, result: autoApproval.result });
        this.broadcast({ type: "codex:serverRequestResolved", requestId: message.id });
        return;
      }

      this.serverRequests.set(message.id, message);
      this.broadcast({ type: "codex:serverRequest", request: message });
      return;
    }

    if ("method" in message) this.handleNotification(message);
  }

  private handleResponse(response: JsonRpcResponse) {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.error) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result);
  }

  private handleNotification(notification: JsonRpcNotification) {
    if (notification.method === "serverRequest/resolved") {
      const params = notification.params;
      if (params && typeof params === "object" && "requestId" in params) {
        const requestId = params.requestId as JsonRpcId;
        this.serverRequests.delete(requestId);
        this.broadcast({ type: "codex:serverRequestResolved", requestId });
      }
    }

    this.broadcast({ type: "codex:notification", message: notification });
  }

  private notify(notification: JsonRpcNotification) {
    this.sendJson(notification);
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private broadcast(event: BrowserEvent) {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}
