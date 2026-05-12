export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type BrowserMessage =
  | {
      type: "codex:request";
      requestId: string;
      method: string;
      params?: unknown;
    }
  | {
      type: "codex:serverResponse";
      requestId: string;
      serverRequestId: JsonRpcId;
      result: unknown;
    }
  | {
      type: "project:resolve";
      requestId: string;
      cwd: string;
    };

export type BrowserReply = {
  type: "reply";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type BrowserEvent =
  | {
      type: "codex:notification";
      message: JsonRpcNotification;
    }
  | {
      type: "codex:serverRequest";
      request: JsonRpcRequest;
    }
  | {
      type: "codex:serverRequestResolved";
      requestId: JsonRpcId;
    }
    | {
        type: "gateway:state";
        status: "starting" | "connected" | "disconnected" | "error";
        detail?: string;
      };

export type CodexGatewaySnapshot = {
  initializeInfo?: unknown;
  collaborationModes?: unknown[];
  pendingServerRequests?: JsonRpcRequest[];
};

export type ProjectInfo = {
  cwd: string;
  realpath: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  git?: {
    insideWorkTree: boolean;
    branch: string | null;
    root: string | null;
  };
};

export type ProjectDirectoryEntry = {
  name: string;
  path: string;
};

export type ProjectDirectoryListing = {
  cwd: string;
  realpath: string;
  parent: string | null;
  entries: ProjectDirectoryEntry[];
};

export type ProjectSuggestion = {
  label: string;
  path: string;
};
