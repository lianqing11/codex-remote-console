import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maxInlineUntrackedBytes = 256 * 1024;

export type GitDiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  tooLarge?: boolean;
};

export type GitDiffResult = {
  root: string;
  branch: string | null;
  status: string;
  diff: string;
  files: GitDiffFile[];
  additions: number;
  deletions: number;
  hasChanges: boolean;
};

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitWithEnv(cwd: string, args: string[], env: Record<string, string>) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout;
}

async function gitRoot(cwd: string) {
  if (!path.isAbsolute(cwd)) throw new Error("Use an absolute server path.");
  const cwdInfo = await stat(cwd);
  if (!cwdInfo.isDirectory()) throw new Error("Path exists but is not a directory.");
  await access(cwd, constants.R_OK);

  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"])
    .then((value) => value.trim())
    .catch(() => "false");
  if (inside !== "true") throw new Error("Selected directory is not inside a git worktree.");
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

function assertInsideRoot(root: string, relativePath: string) {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Git path escapes repository root: ${relativePath}`);
  return target;
}

function parseStatus(status: string) {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3);
      const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() || rawPath : rawPath;
      return { code, path: filePath };
    });
}

function updateFile(files: Map<string, GitDiffFile>, filePath: string, patch: Partial<GitDiffFile>) {
  const current = files.get(filePath) || { path: filePath, status: "changed", additions: 0, deletions: 0 };
  files.set(filePath, {
    ...current,
    ...patch,
    additions: current.additions + (patch.additions || 0),
    deletions: current.deletions + (patch.deletions || 0),
    binary: current.binary || patch.binary,
    tooLarge: current.tooLarge || patch.tooLarge
  });
}

function applyNumstat(files: Map<string, GitDiffFile>, output: string) {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split("\t");
    const filePath = rest.join("\t");
    const binary = added === "-" || deleted === "-";
    updateFile(files, filePath, {
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary
    });
  }
}

function applyNameStatus(files: Map<string, GitDiffFile>, output: string) {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [rawStatus, ...paths] = line.split("\t");
    const filePath = paths.at(-1) || "";
    const status =
      rawStatus === "A"
        ? "added"
        : rawStatus === "D"
          ? "deleted"
          : rawStatus.startsWith("R")
            ? "renamed"
            : "modified";
    updateFile(files, filePath, { status });
  }
}

function applyStatus(files: Map<string, GitDiffFile>, status: string) {
  for (const entry of parseStatus(status)) {
    const label =
      entry.code === "??"
        ? "untracked"
        : entry.code.includes("D")
          ? "deleted"
          : entry.code.includes("A")
            ? "added"
            : entry.code.includes("R")
              ? "renamed"
              : "modified";
    updateFile(files, entry.path, { status: label });
  }
}

function isBinary(buffer: Buffer) {
  return buffer.includes(0);
}

function syntheticNewFileDiff(filePath: string, text: string) {
  const lines = text.split("\n");
  const hasTrailingNewline = text.endsWith("\n");
  const body = lines
    .slice(0, hasTrailingNewline ? lines.length - 1 : lines.length)
    .map((line) => `+${line}`)
    .join("\n");
  const noNewline = hasTrailingNewline ? "" : "\n\\ No newline at end of file";
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${Math.max(1, lines.length - (hasTrailingNewline ? 1 : 0))} @@`,
    `${body}${noNewline}`
  ].join("\n");
}

async function diffBetweenTrees(root: string, beforeTree: string, afterTree: string) {
  const [branch, diff, numstat, nameStatus] = await Promise.all([
    git(root, ["branch", "--show-current"]).then((value) => value.trim() || null),
    git(root, ["diff", "--no-ext-diff", "--find-renames", beforeTree, afterTree]),
    git(root, ["diff", "--numstat", "--find-renames", beforeTree, afterTree]),
    git(root, ["diff", "--name-status", "--find-renames", beforeTree, afterTree])
  ]);
  const files = new Map<string, GitDiffFile>();
  applyNameStatus(files, nameStatus);
  applyNumstat(files, numstat);
  const fileList = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  const additions = fileList.reduce((sum, file) => sum + file.additions, 0);
  const deletions = fileList.reduce((sum, file) => sum + file.deletions, 0);

  return {
    root,
    branch,
    status: nameStatus,
    diff,
    files: fileList,
    additions,
    deletions,
    hasChanges: fileList.length > 0
  };
}

export async function gitWorkingTreeSnapshot(cwd: string) {
  const root = await gitRoot(cwd);
  const temp = await mkdtemp(path.join(tmpdir(), "codex-web-index-"));
  const indexPath = path.join(temp, "index");
  const env = { GIT_INDEX_FILE: indexPath };

  try {
    await git(root, ["rev-parse", "--verify", "HEAD^{tree}"])
      .then(() => gitWithEnv(root, ["read-tree", "HEAD"], env))
      .catch(() => gitWithEnv(root, ["read-tree", "--empty"], env));
    await gitWithEnv(root, ["add", "-A", "--", "."], env);
    const tree = (await gitWithEnv(root, ["write-tree"], env)).trim();
    return { root, tree };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function gitWorkingTreeDiffFromSnapshot(cwd: string, baseTree: string): Promise<GitDiffResult> {
  if (!/^[0-9a-f]{40,64}$/i.test(baseTree)) throw new Error("Invalid git tree snapshot.");
  const root = await gitRoot(cwd);
  const snapshot = await gitWorkingTreeSnapshot(root);
  return diffBetweenTrees(root, baseTree, snapshot.tree);
}

async function untrackedDiffs(root: string, entries: Array<{ code: string; path: string }>, files: Map<string, GitDiffFile>) {
  const chunks: string[] = [];
  for (const entry of entries.filter((item) => item.code === "??")) {
    const absolutePath = assertInsideRoot(root, entry.path);
    const info = await stat(absolutePath);
    if (!info.isFile()) continue;

    if (info.size > maxInlineUntrackedBytes) {
      updateFile(files, entry.path, { status: "untracked", tooLarge: true });
      continue;
    }

    const buffer = await readFile(absolutePath);
    if (isBinary(buffer)) {
      updateFile(files, entry.path, { status: "untracked", binary: true });
      continue;
    }

    const text = buffer.toString("utf8");
    const additions = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    updateFile(files, entry.path, { status: "untracked", additions });
    chunks.push(syntheticNewFileDiff(entry.path, text));
  }
  return chunks.join("\n\n");
}

export async function gitWorkingTreeDiff(cwd: string): Promise<GitDiffResult> {
  const root = await gitRoot(cwd);
  const [branch, status, stagedDiff, unstagedDiff, stagedNumstat, unstagedNumstat] = await Promise.all([
    git(root, ["branch", "--show-current"]).then((value) => value.trim() || null),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(root, ["diff", "--cached", "--no-ext-diff", "--find-renames"]),
    git(root, ["diff", "--no-ext-diff", "--find-renames"]),
    git(root, ["diff", "--cached", "--numstat", "--find-renames"]),
    git(root, ["diff", "--numstat", "--find-renames"])
  ]);

  const files = new Map<string, GitDiffFile>();
  applyStatus(files, status);
  applyNumstat(files, stagedNumstat);
  applyNumstat(files, unstagedNumstat);

  const statusEntries = parseStatus(status);
  const untracked = await untrackedDiffs(root, statusEntries, files);
  const diff = [stagedDiff.trimEnd(), unstagedDiff.trimEnd(), untracked.trimEnd()].filter(Boolean).join("\n\n");
  const fileList = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  const additions = fileList.reduce((sum, file) => sum + file.additions, 0);
  const deletions = fileList.reduce((sum, file) => sum + file.deletions, 0);

  return {
    root,
    branch,
    status,
    diff,
    files: fileList,
    additions,
    deletions,
    hasChanges: status.trim().length > 0
  };
}
