import { randomUUID } from "node:crypto";
import { access, chmod, link, lstat, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolveInsideRoot } from "./pathGuard";
import type {
  ProjectDirectoryListing,
  ProjectFilePreview,
  ProjectInfo,
  ProjectSuggestion,
  ProjectTreeEntry,
  ProjectTreeListing,
  ProjectUploadResult
} from "./types";
import { HttpError } from "./http";

const execFileAsync = promisify(execFile);
const hiddenNames = new Set(["__MACOSX", "__pycache__", "node_modules"]);
const generatedDirectoryNames = new Set([".git", ".next", "__pycache__", "build", "dist", "node_modules"]);
const maxProjectTreeEntries = 500;
const maxProjectFileBytes = 512 * 1024;
const maxProjectAssetBytes = 10 * 1024 * 1024;
const projectImageTypes = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);
const codeExtensions = new Set([
  ".bash",
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".jsonl",
  ".mjs",
  ".php",
  ".py",
  ".pyi",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh"
]);
const textExtensions = new Set([".cfg", ".conf", ".csv", ".env", ".ini", ".log", ".properties", ".txt"]);
const codeFileNames = new Set(["Dockerfile", "Makefile", "Procfile"]);

async function canAccess(target: string, mode: number) {
  try {
    await access(target, mode);
    return true;
  } catch {
    return false;
  }
}

async function gitInfo(cwd: string): Promise<ProjectInfo["git"]> {
  try {
    const [inside, branch, root] = await Promise.all([
      execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]),
      execFileAsync("git", ["-C", cwd, "branch", "--show-current"]),
      execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
    ]);

    return {
      insideWorkTree: inside.stdout.trim() === "true",
      branch: branch.stdout.trim() || null,
      root: root.stdout.trim() || null
    };
  } catch {
    return {
      insideWorkTree: false,
      branch: null,
      root: null
    };
  }
}

export async function resolveProject(cwd: string): Promise<ProjectInfo> {
  if (!path.isAbsolute(cwd)) {
    throw new Error("Use an absolute server path.");
  }

  const info = await stat(cwd);
  if (!info.isDirectory()) {
    throw new Error("Path exists but is not a directory.");
  }

  const resolved = await realpath(cwd);
  await assertAllowedProjectRoot(resolved);
  const [readable, writable, git] = await Promise.all([
    canAccess(resolved, constants.R_OK),
    canAccess(resolved, constants.W_OK),
    gitInfo(resolved)
  ]);

  return {
    cwd,
    realpath: resolved,
    exists: true,
    readable,
    writable,
    git
  };
}

function displayLabel(target: string) {
  const name = path.basename(target);
  return name || target;
}

async function existingDirectory(target: string) {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function nearestExistingDirectory(target: string) {
  let current = target;

  while (true) {
    try {
      const info = await stat(current);
      if (info.isDirectory()) return current;
    } catch {
      // Walk upward until a real parent can be shown in the picker.
    }

    const parent = path.dirname(current);
    if (parent === current) throw new Error("No existing parent directory found.");
    current = parent;
  }
}

async function trustedCodexProjects() {
  const configPath = path.join(homedir(), ".codex", "config.toml");
  try {
    const config = await readFile(configPath, "utf8");
    return [...config.matchAll(/^\[projects\."([^"]+)"\]/gm)].map((match) => match[1]);
  } catch {
    return [];
  }
}

function configuredProjectRoots() {
  return (process.env.CODEX_WEB_PROJECT_ROOTS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function assertAllowedProjectRoot(cwd: string) {
  const roots = configuredProjectRoots();
  if (!roots.length) return;

  const resolved = await realpath(cwd);
  for (const root of roots) {
    const allowed = await realpath(root).catch(() => null);
    if (!allowed) continue;
    const relative = path.relative(allowed, resolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return;
  }
  throw new Error("Project is outside CODEX_WEB_PROJECT_ROOTS.");
}

export async function projectSuggestions(): Promise<ProjectSuggestion[]> {
  const candidates = [
    process.cwd(),
    homedir(),
    path.join(homedir(), "projects"),
    path.join(homedir(), "src"),
    ...configuredProjectRoots(),
    ...(await trustedCodexProjects())
  ];

  const seen = new Set<string>();
  const suggestions: ProjectSuggestion[] = [];

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved || seen.has(resolved) || !(await existingDirectory(resolved))) continue;
    seen.add(resolved);
    suggestions.push({ label: displayLabel(resolved), path: resolved });
  }

  return suggestions.slice(0, 60);
}

export async function listProjectDirectory(cwd: string): Promise<ProjectDirectoryListing> {
  if (!path.isAbsolute(cwd)) {
    throw new Error("Use an absolute server path.");
  }

  const existing = await nearestExistingDirectory(cwd);
  const resolved = await realpath(existing);
  await assertAllowedProjectRoot(resolved);
  const entries = await readdir(resolved, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !hiddenNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolved, entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .slice(0, 300);

  const parent = path.dirname(resolved);

  return {
    cwd,
    realpath: resolved,
    parent: parent === resolved ? null : parent,
    entries: directories
  };
}

function projectRelativePath(input: string, allowRoot = false) {
  if (input.includes("\0") || path.isAbsolute(input) || input.split(/[\\/]+/).includes("..")) {
    throw new Error("Use a project-relative path.");
  }

  const normalized = path.posix.normalize(input.replace(/\\/g, "/") || ".");
  if (normalized === ".") {
    if (allowRoot) return "";
    throw new Error("Use a project-relative file path.");
  }
  if (normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error("Project path escapes the selected root.");
  }
  return normalized;
}

function assertInsideProject(root: string, target: string) {
  resolveInsideRoot(root, path.relative(root, target) || ".");
}

async function projectRoot(cwd: string) {
  if (!path.isAbsolute(cwd)) throw new Error("Use an absolute server path.");
  const root = await realpath(cwd);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error("Project root is not a directory.");
  await access(root, constants.R_OK);
  await assertAllowedProjectRoot(root);
  return root;
}

async function projectTarget(cwd: string, relativePath: string, allowRoot = false) {
  const root = await projectRoot(cwd);
  const projectPath = projectRelativePath(relativePath, allowRoot);
  const requested = path.resolve(root, projectPath);
  assertInsideProject(root, requested);
  const resolved = await realpath(requested);
  assertInsideProject(root, resolved);
  return { root, projectPath, requested, resolved };
}

type ProjectUploadOptions = {
  directory?: string;
  name: string;
  overwrite?: boolean;
  contentLength?: number | null;
  maxBytes: number;
};

function projectUploadName(value: string) {
  const name = String(value || "").normalize("NFC");
  if (
    !name
    || name === "."
    || name === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(name)
    || Buffer.byteLength(name) > 255
  ) {
    throw new HttpError(400, "Use a valid file name without directory separators.");
  }
  return name;
}

function uploadConflict(name: string) {
  return new HttpError(409, `${name} already exists in this project directory.`);
}

export async function writeProjectUpload(
  cwd: string,
  body: AsyncIterable<Uint8Array | string>,
  options: ProjectUploadOptions
): Promise<ProjectUploadResult> {
  if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
    throw new HttpError(500, "Project upload size limit is invalid.");
  }
  if (options.contentLength !== null && options.contentLength !== undefined) {
    if (!Number.isFinite(options.contentLength) || options.contentLength < 0) {
      throw new HttpError(400, "Invalid upload size.");
    }
    if (options.contentLength > options.maxBytes) {
      throw new HttpError(413, `Files must be ${options.maxBytes} bytes or smaller.`);
    }
  }

  const root = await projectRoot(cwd);
  let directory: string;
  try {
    directory = projectRelativePath(options.directory || "", true);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  const requestedDirectory = path.resolve(root, directory);
  assertInsideProject(root, requestedDirectory);
  const resolvedDirectory = await realpath(requestedDirectory);
  assertInsideProject(root, resolvedDirectory);
  const directoryInfo = await stat(resolvedDirectory);
  if (!directoryInfo.isDirectory()) throw new HttpError(400, "Project upload target is not a directory.");
  try {
    await access(resolvedDirectory, constants.W_OK);
  } catch {
    throw new HttpError(403, "Project upload target is not writable.");
  }

  const name = projectUploadName(options.name);
  const target = path.join(resolvedDirectory, name);
  assertInsideProject(root, target);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw uploadConflict(name);
  }
  if (existing && !options.overwrite) throw uploadConflict(name);

  const tmpPath = path.join(resolvedDirectory, `.codex-project-upload.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let size = 0;
  try {
    handle = await open(tmpPath, "wx", 0o600);
    for await (const rawChunk of body) {
      const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
      size += chunk.length;
      if (size > options.maxBytes) {
        throw new HttpError(413, `Files must be ${options.maxBytes} bytes or smaller.`);
      }
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    const mode = existing ? existing.mode & 0o777 : 0o644;
    await chmod(tmpPath, mode);
    if (existing) {
      await rename(tmpPath, target);
    } else {
      try {
        await link(tmpPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw uploadConflict(name);
        throw error;
      }
      await rm(tmpPath, { force: true });
    }

    const written = await stat(target);
    return {
      root,
      directory,
      path: directory ? `${directory}/${name}` : name,
      name,
      size,
      modifiedAt: written.mtimeMs,
      overwritten: Boolean(existing)
    };
  } finally {
    await handle?.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

function fileViewer(filePath: string): Pick<ProjectFilePreview, "viewer" | "language"> {
  const extension = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if ([".markdown", ".md", ".mdx"].includes(extension)) return { viewer: "markdown", language: "markdown" };
  if ([".py", ".pyi"].includes(extension)) return { viewer: "code", language: "python" };
  if ([".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extension)) return { viewer: "code", language: "typescript" };
  if ([".json", ".jsonl"].includes(extension)) return { viewer: "code", language: "json" };
  if ([".bash", ".sh", ".zsh"].includes(extension)) return { viewer: "code", language: "shell" };
  if ([".css", ".scss"].includes(extension)) return { viewer: "code", language: "css" };
  if ([".yaml", ".yml"].includes(extension)) return { viewer: "code", language: "yaml" };
  if (codeExtensions.has(extension) || codeFileNames.has(name)) return { viewer: "code", language: extension.slice(1) || "text" };
  if (textExtensions.has(extension) || !extension) return { viewer: "text", language: "text" };
  return { viewer: "text", language: "text" };
}

async function treeEntry(root: string, directory: string, name: string): Promise<ProjectTreeEntry> {
  const absolutePath = path.join(directory, name);
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  const linkInfo = await lstat(absolutePath);
  const symlink = linkInfo.isSymbolicLink();
  let accessible = true;
  let info = linkInfo;

  if (symlink) {
    try {
      const resolved = await realpath(absolutePath);
      assertInsideProject(root, resolved);
      info = await stat(resolved);
    } catch {
      accessible = false;
    }
  }

  const kind = accessible && info.isDirectory() ? "directory" : "file";
  return {
    name,
    path: relativePath,
    kind,
    size: kind === "file" ? info.size : null,
    modifiedAt: info.mtimeMs || null,
    extension: kind === "file" ? path.extname(name).toLowerCase() || null : null,
    symlink,
    accessible
  };
}

export async function listProjectTree(cwd: string, relativeDirectory = ""): Promise<ProjectTreeListing> {
  const { root, projectPath, resolved } = await projectTarget(cwd, relativeDirectory, true);
  const directoryInfo = await stat(resolved);
  if (!directoryInfo.isDirectory()) throw new Error("Project path is not a directory.");

  const names = (await readdir(resolved, { withFileTypes: true }))
    .filter((entry) => !generatedDirectoryNames.has(entry.name))
    .map((entry) => entry.name);
  const entries = await Promise.all(names.map((name) => treeEntry(root, resolved, name)));
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });

  const parentPath = projectPath ? path.posix.dirname(projectPath) : null;
  return {
    root,
    path: projectPath,
    parent: parentPath === "." ? "" : parentPath,
    entries: entries.slice(0, maxProjectTreeEntries),
    truncated: entries.length > maxProjectTreeEntries
  };
}

export async function readProjectFile(cwd: string, relativePath: string): Promise<ProjectFilePreview> {
  const { root, projectPath, resolved } = await projectTarget(cwd, relativePath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Project path is not a file.");
  const view = fileViewer(projectPath);
  const base = {
    root,
    path: projectPath,
    name: path.basename(projectPath),
    size: info.size,
    modifiedAt: info.mtimeMs,
    ...view
  };

  if (info.size > maxProjectFileBytes) {
    return { ...base, content: null, binary: false, tooLarge: true };
  }

  const buffer = await readFile(resolved);
  let content: string;
  try {
    if (buffer.includes(0)) throw new Error("Binary file");
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { ...base, content: null, binary: true, tooLarge: false, viewer: "unsupported", language: "text" };
  }
  return { ...base, content, binary: false, tooLarge: false };
}

export async function readProjectAsset(cwd: string, relativePath: string) {
  const { projectPath, resolved } = await projectTarget(cwd, relativePath);
  const contentType = projectImageTypes.get(path.extname(projectPath).toLowerCase());
  if (!contentType) throw new Error("Only supported raster images can be previewed.");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Project asset is not a file.");
  if (info.size > maxProjectAssetBytes) throw new Error("Project asset is too large to preview.");
  return { buffer: await readFile(resolved), contentType, size: info.size, modifiedAt: info.mtimeMs };
}
