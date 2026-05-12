export type SlashCommandAction =
  | "set-mode"
  | "open-panel"
  | "toggle-fast"
  | "run-review"
  | "new-thread"
  | "resume-thread"
  | "fork-thread"
  | "side-thread"
  | "compact-thread"
  | "copy-last"
  | "show-diff"
  | "logout"
  | "exit-thread"
  | "stop-work"
  | "unsupported";

export type SlashCommand = {
  id: string;
  aliases?: string[];
  label: string;
  description: string;
  action: SlashCommandAction;
  available: boolean;
  disabledReason?: string;
  requiresThread?: boolean;
  disabledDuringTurn?: boolean;
};

export type SlashCommandContext = {
  hasThread: boolean;
  activeTurn: boolean;
};

const unsupported = (reason: string) => ({
  action: "unsupported" as const,
  available: false,
  disabledReason: reason
});

export const slashCommands: SlashCommand[] = [
  {
    id: "model",
    label: "/model",
    description: "choose what model and reasoning effort to use",
    action: "open-panel",
    available: true
  },
  {
    id: "fast",
    label: "/fast",
    description: "toggle Fast mode to enable fastest inference with increased plan usage",
    action: "toggle-fast",
    available: true
  },
  {
    id: "permissions",
    aliases: ["permission"],
    label: "/permissions",
    description: "choose what Codex is allowed to do",
    action: "open-panel",
    available: true
  },
  {
    id: "keymap",
    label: "/keymap",
    description: "remap TUI shortcuts",
    ...unsupported("Codex Web does not own the terminal TUI keymap.")
  },
  {
    id: "experimental",
    label: "/experimental",
    description: "toggle experimental features",
    action: "open-panel",
    available: true
  },
  {
    id: "autoreview",
    label: "/autoreview",
    description: "approve one retry of a recent auto-review denial",
    ...unsupported("No recent guardian denial event is exposed to Codex Web yet.")
  },
  {
    id: "memories",
    label: "/memories",
    description: "configure memory use and generation",
    action: "open-panel",
    available: true,
    requiresThread: true
  },
  {
    id: "skills",
    label: "/skills",
    description: "use skills to improve how Codex performs specific tasks",
    action: "open-panel",
    available: true
  },
  {
    id: "review",
    label: "/review",
    description: "review my current changes and find issues",
    action: "run-review",
    available: true,
    requiresThread: true,
    disabledDuringTurn: true
  },
  {
    id: "rename",
    label: "/rename",
    description: "rename the current thread",
    action: "open-panel",
    available: true,
    requiresThread: true
  },
  {
    id: "new",
    label: "/new",
    description: "start a new chat during a conversation",
    action: "new-thread",
    available: true,
    disabledDuringTurn: true
  },
  {
    id: "resume",
    label: "/resume",
    description: "resume a saved chat",
    action: "resume-thread",
    available: true
  },
  {
    id: "fork",
    label: "/fork",
    description: "fork the current chat",
    action: "fork-thread",
    available: true,
    requiresThread: true,
    disabledDuringTurn: true
  },
  {
    id: "init",
    label: "/init",
    description: "create an AGENTS.md file with instructions for Codex",
    ...unsupported("AGENTS.md creation is intentionally not bridged through the web slash menu.")
  },
  {
    id: "compact",
    label: "/compact",
    description: "summarize conversation to prevent hitting the context limit",
    action: "compact-thread",
    available: true,
    requiresThread: true,
    disabledDuringTurn: true
  },
  {
    id: "plan",
    label: "/plan",
    description: "switch to Plan mode",
    action: "set-mode",
    available: true
  },
  {
    id: "collab",
    label: "/collab",
    description: "change collaboration mode",
    action: "open-panel",
    available: true
  },
  {
    id: "agent",
    label: "/agent",
    description: "switch to agent execution mode",
    action: "set-mode",
    available: true
  },
  {
    id: "side",
    label: "/side",
    description: "start a side conversation in an ephemeral fork",
    action: "side-thread",
    available: true,
    requiresThread: true,
    disabledDuringTurn: true
  },
  {
    id: "copy",
    label: "/copy",
    description: "copy last response as markdown",
    action: "copy-last",
    available: true
  },
  {
    id: "diff",
    label: "/diff",
    description: "show git diff including untracked files",
    action: "show-diff",
    available: true
  },
  {
    id: "mention",
    label: "/mention",
    description: "mention a file",
    action: "open-panel",
    available: true
  },
  {
    id: "status",
    label: "/status",
    description: "show current session configuration and token usage",
    action: "open-panel",
    available: true
  },
  {
    id: "title",
    label: "/title",
    description: "configure which items appear in the terminal title",
    ...unsupported("Terminal title configuration is specific to the Codex TUI.")
  },
  {
    id: "statusline",
    label: "/statusline",
    description: "configure which items appear in the status line",
    ...unsupported("Status line configuration is specific to the Codex TUI.")
  },
  {
    id: "theme",
    label: "/theme",
    description: "choose a syntax highlighting theme",
    ...unsupported("Theme configuration is specific to the Codex TUI.")
  },
  {
    id: "mcp",
    label: "/mcp",
    description: "list configured MCP tools",
    action: "open-panel",
    available: true
  },
  {
    id: "plugins",
    label: "/plugins",
    description: "browse plugins",
    action: "open-panel",
    available: true
  },
  {
    id: "logout",
    label: "/logout",
    description: "log out of Codex Web",
    action: "logout",
    available: true
  },
  {
    id: "exit",
    label: "/exit",
    description: "close the selected Codex Web session",
    action: "exit-thread",
    available: true
  },
  {
    id: "feedback",
    label: "/feedback",
    description: "send logs to maintainers",
    ...unsupported("Feedback upload is not enabled in this private web console.")
  },
  {
    id: "ps",
    label: "/ps",
    description: "list background terminals",
    ...unsupported("Background terminal listing is not exposed by app-server.")
  },
  {
    id: "stop",
    label: "/stop",
    description: "stop the active turn or all background terminals",
    action: "stop-work",
    available: true
  }
];

export function commandTokens(command: SlashCommand) {
  return [command.id, ...(command.aliases || [])].map((item) => item.toLowerCase());
}

export function findSlashCommand(input: string) {
  const normalized = input.trim().replace(/^\/+/, "").toLowerCase();
  if (!normalized || /\s/.test(normalized)) return null;
  return slashCommands.find((command) => commandTokens(command).includes(normalized)) || null;
}

export function filterSlashCommands(query: string) {
  const normalized = query.trim().replace(/^\/+/, "").toLowerCase();
  if (!normalized) return slashCommands;
  return slashCommands.filter((command) =>
    commandTokens(command).some((token) => token.includes(normalized))
      || command.description.toLowerCase().includes(normalized)
  );
}

export function slashCommandDisabledReason(command: SlashCommand, context: SlashCommandContext) {
  if (!command.available) return command.disabledReason || "This command is not available in Codex Web.";
  if (command.requiresThread && !context.hasThread) return "Select or start a session first.";
  if (command.disabledDuringTurn && context.activeTurn) return "Wait for the active turn to finish first.";
  return "";
}
