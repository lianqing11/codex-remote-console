import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { HttpError } from "./http";

const defaultMaxUploadBytes = 50 * 1024 * 1024;
const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rasterImageTypes = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

type UploadMetadata = {
  id: string;
  name: string;
  storedName: string;
  contentType: string;
  size: number;
  createdAt: number;
};

export type StoredUpload = Omit<UploadMetadata, "storedName"> & {
  filePath: string;
  image: boolean;
};

export type PublicUpload = Omit<StoredUpload, "filePath">;

type SaveUploadOptions = {
  name: string;
  contentType?: string | null;
  contentLength?: number | null;
};

function stateRoot() {
  const configured = process.env.CODING_AGENT_CONSOLE_STATE_DIR?.trim();
  return configured || path.join(homedir(), ".local", "share", "coding-agent-console");
}

function configuredMaxUploadBytes() {
  const configured = Number(process.env.CODEX_WEB_UPLOAD_MAX_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) return defaultMaxUploadBytes;
  return Math.min(100 * 1024 * 1024, Math.max(1024, Math.round(configured)));
}

function safeFileName(value: string) {
  const basename = path.basename(value || "upload");
  const cleaned = basename
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\]+/g, "_")
    .replace(/^\.+$/, "upload")
    .trim()
    .slice(0, 160);
  return cleaned || "upload";
}

function normalizedContentType(value?: string | null) {
  const candidate = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(candidate)
    ? candidate
    : "application/octet-stream";
}

function metadataPath(root: string, id: string) {
  return path.join(root, id, "metadata.json");
}

function validateUploadId(id: string) {
  if (!uploadIdPattern.test(id)) throw new HttpError(404, "Upload not found.");
}

function publicUpload(upload: StoredUpload): PublicUpload {
  const { filePath: _filePath, ...result } = upload;
  return result;
}

export class UploadStore {
  readonly root: string;
  readonly maxBytes: number;

  constructor(options: { root?: string; maxBytes?: number } = {}) {
    this.root = options.root || path.join(stateRoot(), "uploads");
    this.maxBytes = options.maxBytes || configuredMaxUploadBytes();
  }

  async save(body: AsyncIterable<Uint8Array | string>, options: SaveUploadOptions) {
    const name = safeFileName(options.name);
    const contentType = normalizedContentType(options.contentType);
    const contentLength = options.contentLength;
    if (contentLength !== null && contentLength !== undefined) {
      if (!Number.isFinite(contentLength) || contentLength < 0) throw new HttpError(400, "Invalid upload size.");
      if (contentLength > this.maxBytes) throw new HttpError(413, `Files must be ${this.maxBytes} bytes or smaller.`);
    }

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => {});
    const id = randomUUID();
    const dir = path.join(this.root, id);
    const tmpPath = path.join(dir, `.upload.${process.pid}.${randomUUID()}.tmp`);
    const filePath = path.join(dir, name);
    await mkdir(dir, { recursive: false, mode: 0o700 });

    let handle;
    let size = 0;
    try {
      handle = await open(tmpPath, "wx", 0o600);
      for await (const rawChunk of body) {
        const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
        size += chunk.length;
        if (size > this.maxBytes) throw new HttpError(413, `Files must be ${this.maxBytes} bytes or smaller.`);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmpPath, filePath);
      await chmod(filePath, 0o600).catch(() => {});

      const metadata: UploadMetadata = {
        id,
        name,
        storedName: name,
        contentType,
        size,
        createdAt: Date.now()
      };
      const metaPath = metadataPath(this.root, id);
      await writeFile(metaPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(metaPath, 0o600).catch(() => {});
      return this.get(id);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async get(id: string): Promise<StoredUpload> {
    validateUploadId(id);
    let metadata: UploadMetadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath(this.root, id), "utf8")) as UploadMetadata;
    } catch {
      throw new HttpError(404, "Upload not found.");
    }

    if (
      metadata.id !== id
      || metadata.storedName !== safeFileName(metadata.storedName)
      || !metadata.name
      || !Number.isFinite(metadata.size)
      || metadata.size < 0
    ) {
      throw new HttpError(500, "Upload metadata is invalid.");
    }

    const filePath = path.join(this.root, id, metadata.storedName);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      throw new HttpError(404, "Upload file is missing.");
    }
    if (!fileStat.isFile() || fileStat.size !== metadata.size) throw new HttpError(500, "Upload file is invalid.");

    return {
      id,
      name: metadata.name,
      contentType: normalizedContentType(metadata.contentType),
      size: metadata.size,
      createdAt: metadata.createdAt,
      filePath,
      image: rasterImageTypes.has(normalizedContentType(metadata.contentType))
    };
  }

  async remove(id: string) {
    validateUploadId(id);
    const existing = await this.get(id);
    await rm(path.dirname(existing.filePath), { recursive: true, force: true });
    return { ok: true };
  }

  toPublic(upload: StoredUpload) {
    return publicUpload(upload);
  }
}

export async function resolveUploadedInputs(params: unknown, uploads: UploadStore) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const input = (params as { input?: unknown }).input;
  if (!Array.isArray(input)) return params;

  const resolved = await Promise.all(input.map(async (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (record.type !== "uploadedFile") return item;
    const uploadId = typeof record.uploadId === "string" ? record.uploadId : "";
    const upload = await uploads.get(uploadId);
    if (upload.image && record.asImage !== false) {
      return { type: "localImage", path: upload.filePath };
    }
    return { type: "mention", name: upload.name, path: upload.filePath };
  }));

  return { ...params, input: resolved };
}
