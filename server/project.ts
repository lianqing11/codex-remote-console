import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import type { ProjectDirectoryListing, ProjectInfo, ProjectSuggestion } from "./types";

const execFileAsync = promisify(execFile);
const hiddenNames = new Set(["__MACOSX", "__pycache__", "node_modules"]);

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
