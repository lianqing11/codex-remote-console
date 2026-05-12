import assert from "node:assert/strict";
import {
  filterSlashCommands,
  findSlashCommand,
  slashCommandDisabledReason,
  slashCommands
} from "../app/slashCommands";

const expectedIds = [
  "model",
  "fast",
  "permissions",
  "keymap",
  "experimental",
  "autoreview",
  "memories",
  "skills",
  "review",
  "rename",
  "new",
  "resume",
  "fork",
  "init",
  "compact",
  "plan",
  "collab",
  "agent",
  "side",
  "copy",
  "diff",
  "mention",
  "status",
  "title",
  "statusline",
  "theme",
  "mcp",
  "plugins",
  "logout",
  "exit",
  "feedback",
  "ps",
  "stop"
];

assert.deepEqual(
  slashCommands.map((command) => command.id),
  expectedIds
);
assert.equal(findSlashCommand("/plan")?.id, "plan");
assert.equal(findSlashCommand("/agent")?.id, "agent");
assert.equal(findSlashCommand("/permission")?.id, "permissions");
assert.equal(findSlashCommand("/permissions")?.id, "permissions");
assert.equal(findSlashCommand("/unknown"), null);
assert.equal(findSlashCommand("/plan now"), null);
assert.ok(filterSlashCommands("/perm").some((command) => command.id === "permissions"));
assert.ok(filterSlashCommands("/sta").some((command) => command.id === "statusline"));
assert.equal(
  slashCommandDisabledReason(findSlashCommand("/init")!, { hasThread: true, activeTurn: false }).length > 0,
  true
);
assert.equal(
  slashCommandDisabledReason(findSlashCommand("/review")!, { hasThread: false, activeTurn: false }),
  "Select or start a session first."
);
assert.equal(
  slashCommandDisabledReason(findSlashCommand("/review")!, { hasThread: true, activeTurn: true }),
  "Wait for the active turn to finish first."
);

console.log(`slash command registry ok (${slashCommands.length} commands)`);
