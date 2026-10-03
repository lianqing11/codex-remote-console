import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile, realpath, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CURSOR_FORK_VERSION = "2026.09.28-64d2043";
export function cursorForkSupported(version: string) { return version.trim() === CURSOR_FORK_VERSION; }
export function cursorChatsRoot(cwd: string, env = process.env) {
  const config = env.CURSOR_CONFIG_DIR?.trim() || (env.XDG_CONFIG_HOME?.trim() ? path.join(env.XDG_CONFIG_HOME, "cursor") : path.join(homedir(), ".cursor"));
  return path.join(config, "chats", createHash("md5").update(path.resolve(cwd)).digest("hex"));
}

export function decodeCursorMetadata(encoded: unknown): Record<string, any> {
  if (typeof encoded !== "string" || !/^(?:[a-f\d]{2})+$/i.test(encoded)) throw new Error("Unsupported Cursor metadata encoding.");
  const value = JSON.parse(Buffer.from(encoded, "hex").toString("utf8"));
  if (!value || typeof value.agentId !== "string" || typeof value.name !== "string" || !Number.isFinite(value.createdAt)
    || !/^[a-f\d]{64}$/i.test(value.latestRootBlobId || "") || !["default", "plan", "debug", "search"].includes(value.mode)
    || typeof value.isRunEverything !== "boolean") throw new Error("Unsupported or empty Cursor session metadata.");
  return value;
}
export function encodeCursorMetadata(value: Record<string, any>) { return Buffer.from(JSON.stringify(value)).toString("hex"); }

/** Versioned equivalent of Cursor's native fork-chat-session implementation. */
export async function forkCursorStore(options: { sourceId: string; cwd: string; title: string; version: string; root?: string }) {
  if (!cursorForkSupported(options.version)) throw new Error(`Cursor fork requires compatible CLI ${CURSOR_FORK_VERSION}; found ${options.version}.`);
  if (!/^[\da-f-]{36}$/i.test(options.sourceId)) throw new Error("Invalid Cursor session ID.");
  const root = await realpath(options.root || cursorChatsRoot(options.cwd));
  const sourceFile = await realpath(path.join(root, options.sourceId, "store.db"));
  if (sourceFile !== path.join(root, options.sourceId, "store.db")) throw new Error("Cursor source store must not be a symlink.");
  const id = randomUUID();
  const temp = path.join(root, `.fork-${id}`);
  const destination = path.join(root, id);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  let target: DatabaseSync | undefined;
  let committed = false;
  try {
    const version = source.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version !== 1) throw new Error("Unsupported Cursor database version.");
    for (const [table, expected] of [["blobs", "id,data"], ["meta", "key,value"]]) {
      const columns = source.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (columns.map(c => c.name).join(",") !== expected) throw new Error("Unsupported Cursor database structure.");
    }
    const dataVersion = () => Number((source.prepare("PRAGMA data_version").get() as any).data_version);
    const before = dataVersion();
    source.exec("BEGIN");
    const metadata = decodeCursorMetadata((source.prepare("SELECT value FROM meta WHERE key='0'").get() as any)?.value);
    if (metadata.agentId !== options.sourceId) throw new Error("Cursor source ID does not match its store.");
    if (!source.prepare("SELECT id FROM blobs WHERE id=?").get(metadata.latestRootBlobId)) throw new Error("Cursor context root blob is missing.");
    await mkdir(temp, { mode: 0o700 });
    target = new DatabaseSync(path.join(temp, "store.db"));
    target.exec("PRAGMA user_version=1; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); BEGIN");
    const insert = target.prepare("INSERT INTO blobs VALUES (?,?)");
    let count = 0;
    for (const row of source.prepare("SELECT id,data FROM blobs").iterate() as Iterable<{ id: string; data: Uint8Array }>) {
      if (!(row.data instanceof Uint8Array)) throw new Error("Cursor context contains a missing blob.");
      insert.run(row.id, row.data);
      if (++count % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    const next: Record<string, any> = { agentId: id, name: options.title, createdAt: Date.now(), blobEncryptionKey: randomBytes(32).toString("hex") };
    for (const key of ["latestRootBlobId", "mode", "isRunEverything", "approvalMode", "lastUsedModel", "lastDebugServerPort", "currentPlanUri"]) if (metadata[key] !== undefined) next[key] = metadata[key];
    target.prepare("INSERT INTO meta VALUES ('0',?)").run(encodeCursorMetadata(next));
    target.exec("COMMIT");
    target.close(); target = undefined;
    await chmod(path.join(temp, "store.db"), 0o600);
    source.exec("COMMIT");
    if (before !== dataVersion()) throw new Error("Cursor source changed during fork. Retry when it is idle.");
    await writeFile(path.join(temp, "meta.json"), JSON.stringify({ schemaVersion: 1, title: next.name, createdAtMs: next.createdAt, updatedAtMs: next.createdAt, hasConversation: true, cwd: options.cwd }), { mode: 0o600 });
    await rename(temp, destination);
    committed = true;
    return { id, directory: destination };
  } finally {
    target?.close(); source.close();
    if (!committed) await rm(temp, { recursive: true, force: true });
  }
}
