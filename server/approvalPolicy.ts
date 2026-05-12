import path from "node:path";
import type { JsonRpcRequest } from "./types";

type AutoApproval = {
  result: unknown;
  reason: string;
};

const readActionTypes = new Set(["listFiles", "list_files", "read", "search"]);
const readOnlyCommands = new Set([
  "cat",
  "date",
  "df",
  "du",
  "file",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "nl",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sed",
  "stat",
  "tail",
  "wc"
]);
const dangerousGitCommands = new Set(["checkout", "clean", "reset", "restore", "switch"]);

function envEnabled(name: string, defaultValue = true) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function logAutoApproval(message: string) {
  if (envEnabled("CODEX_WEB_APPROVAL_LOG", true)) {
    console.log(`[codex-web approval] ${message}`);
  }
}

function shellWords(command: string) {
  const words = command.match(/"([^"\\]|\\.)*"|'[^']*'|&&|\|\||[;&|()]|[^\s;&|()]+/g) || [];
  return words.map((word) => {
    if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1);
    }
    return word;
  });
}

function commandSegments(command: string) {
  return command
    .split(/\s*(?:&&|\|\||[;|])\s*/g)
    .map((segment) => shellWords(segment).filter(Boolean))
    .filter((segment) => segment.length > 0);
}

function commandText(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;

  const [program, flag, script] = value;
  const executable = program ? path.basename(program) : "";
  if ((executable === "bash" || executable === "sh" || executable === "zsh") && flag === "-lc" && script) {
    return script;
  }

  return value.join(" ");
}

function basename(token: string) {
  return path.basename(token);
}

function executableIndex(tokens: string[]) {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    const command = basename(token);

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index++;
      continue;
    }

    if (["command", "builtin", "time"].includes(command)) {
      index++;
      continue;
    }

    if (command === "sudo") {
      index++;
      while (tokens[index]?.startsWith("-")) index++;
      continue;
    }

    if (command === "env") {
      index++;
      while (tokens[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] || "")) index++;
      continue;
    }

    return index;
  }

  return -1;
}

function hasDangerousGitCommand(tokens: string[]) {
  for (let index = 0; index < tokens.length; index++) {
    if (basename(tokens[index]) !== "git") continue;

    for (let next = index + 1; next < tokens.length; next++) {
      const token = tokens[next];
      if (!token || token === "--") continue;
      if (token === "-C") {
        next++;
        continue;
      }
      if (token.startsWith("-")) continue;
      if (dangerousGitCommands.has(token)) return true;
      break;
    }
  }

  return false;
}

function hasDangerousCommand(command: string) {
  return commandSegments(command).some((segment) => {
    const index = executableIndex(segment);
    if (index === -1) return false;

    const executable = basename(segment[index]);
    return executable === "rm" || (executable === "git" && hasDangerousGitCommand(segment.slice(index)));
  });
}

function hasWriteSyntax(command: string) {
  return /(^|[^<])>{1,2}(?!&)|<|`|\$\(/.test(command);
}

function gitSubcommand(tokens: string[]) {
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "-C") {
      index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }

  return null;
}

function isSafeReadOnlySegment(tokens: string[]) {
  const index = executableIndex(tokens);
  if (index === -1) return false;

  const segment = tokens.slice(index);
  const command = basename(segment[0]);
  if (!readOnlyCommands.has(command)) return false;

  if (command === "find") {
    return !segment.some((token) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(token));
  }

  if (command === "sed") {
    return !segment.some((token) => token === "-i" || token.startsWith("-i") || token === "--in-place");
  }

  if (command === "git") {
    const subcommand = gitSubcommand(segment);
    return Boolean(subcommand && ["diff", "log", "rev-parse", "show", "status"].includes(subcommand));
  }

  return true;
}

function commandLooksReadOnly(command: string) {
  if (!envEnabled("CODEX_WEB_AUTO_APPROVE_READONLY", true)) return false;
  if (hasDangerousCommand(command) || hasWriteSyntax(command)) return false;

  const segments = commandSegments(command);
  return segments.length > 0 && segments.every(isSafeReadOnlySegment);
}

function objectValue(input: unknown, key: string) {
  return input && typeof input === "object" && key in input ? (input as Record<string, unknown>)[key] : undefined;
}

function hasPermissionEscalation(params: unknown) {
  return Boolean(
    objectValue(params, "additionalPermissions") ||
      objectValue(params, "networkApprovalContext") ||
      objectValue(params, "proposedNetworkPolicyAmendments")
  );
}

function readActions(params: unknown) {
  const actions = objectValue(params, "commandActions") || objectValue(params, "parsedCmd");
  if (!Array.isArray(actions)) return [];

  return actions
    .map((action) => (action && typeof action === "object" ? String(objectValue(action, "type") || "") : ""))
    .filter(Boolean);
}

function actionsAreReadOnly(params: unknown) {
  if (!envEnabled("CODEX_WEB_AUTO_APPROVE_READONLY", true)) return false;
  const actions = readActions(params);
  return actions.length > 0 && actions.every((action) => readActionTypes.has(action));
}

function mcpElicitationApproval(params: unknown): AutoApproval | null {
  if (!envEnabled("CODEX_WEB_AUTO_APPROVE_MCP", true)) return null;

  return {
    result: { action: "accept", content: {}, _meta: null },
    reason: `mcp elicitation from ${String(objectValue(params, "serverName") || "unknown server")}`
  };
}

function commandApproval(method: string, params: unknown): AutoApproval | null {
  if (hasPermissionEscalation(params)) return null;

  const command = commandText(objectValue(params, "command"));
  if (command && hasDangerousCommand(command)) return null;

  if (command && commandLooksReadOnly(command)) {
    return {
      result: method === "execCommandApproval" ? { decision: "approved" } : { decision: "accept" },
      reason: "read-only command"
    };
  }

  if (actionsAreReadOnly(params)) {
    return {
      result: method === "execCommandApproval" ? { decision: "approved" } : { decision: "accept" },
      reason: "read-only command actions"
    };
  }

  return null;
}

export function autoApprovalForRequest(request: JsonRpcRequest): AutoApproval | null {
  if (process.env.CODEX_WEB_AUTO_APPROVE === "off") return null;

  if (request.method === "mcpServer/elicitation/request") {
    const approval = mcpElicitationApproval(request.params);
    if (approval) logAutoApproval(approval.reason);
    return approval;
  }

  if (request.method !== "item/commandExecution/requestApproval" && request.method !== "execCommandApproval") {
    return null;
  }

  const approval = commandApproval(request.method, request.params);
  if (approval) {
    logAutoApproval(`${approval.reason}: ${JSON.stringify(objectValue(request.params, "command") || request.id)}`);
  }

  return approval;
}
