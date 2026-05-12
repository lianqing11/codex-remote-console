import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gitWorkingTreeDiff, gitWorkingTreeDiffFromSnapshot, gitWorkingTreeSnapshot } from "../server/gitDiff";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args]);
}

async function makeRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "codex-remote-console-diff-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "codex-remote-console@example.com"]);
  await git(repo, ["config", "user.name", "Codex Remote Console"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function withRepo(fn: (repo: string) => Promise<void>) {
  const repo = await makeRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function main() {
  await withRepo(async (repo) => {
    const result = await gitWorkingTreeDiff(repo);
    assert.equal(result.hasChanges, false);
    assert.equal(result.diff, "");
    assert.deepEqual(result.files, []);
  });

  await withRepo(async (repo) => {
    await writeFile(path.join(repo, "tracked.txt"), "one\ntwo\n");
    const result = await gitWorkingTreeDiff(repo);
    assert.equal(result.hasChanges, true);
    assert.match(result.diff, /diff --git a\/tracked\.txt b\/tracked\.txt/);
    assert.equal(result.files.find((file) => file.path === "tracked.txt")?.additions, 1);
  });

  await withRepo(async (repo) => {
    await writeFile(path.join(repo, "before.txt"), "already here\n");
    const snapshot = await gitWorkingTreeSnapshot(repo);
    await writeFile(path.join(repo, "before.txt"), "already here\nchanged now\n");
    await writeFile(path.join(repo, "after.txt"), "new in turn\n");
    const result = await gitWorkingTreeDiffFromSnapshot(repo, snapshot.tree);
    assert.equal(result.hasChanges, true);
    assert.equal(result.files.some((file) => file.path === "tracked.txt"), false);
    assert.match(result.diff, /diff --git a\/after\.txt b\/after\.txt/);
    assert.match(result.diff, /diff --git a\/before\.txt b\/before\.txt/);
  });

  await withRepo(async (repo) => {
    await writeFile(path.join(repo, "staged.txt"), "staged\n");
    await git(repo, ["add", "staged.txt"]);
    const result = await gitWorkingTreeDiff(repo);
    assert.match(result.diff, /diff --git a\/staged\.txt b\/staged\.txt/);
    assert.equal(result.files.find((file) => file.path === "staged.txt")?.status, "added");
  });

  await withRepo(async (repo) => {
    await writeFile(path.join(repo, "new.txt"), "alpha\nbeta\n");
    const result = await gitWorkingTreeDiff(repo);
    const file = result.files.find((item) => item.path === "new.txt");
    assert.equal(file?.status, "untracked");
    assert.equal(file?.additions, 2);
    assert.match(result.diff, /new file mode 100644/);
    assert.match(result.diff, /\+alpha/);
  });

  await withRepo(async (repo) => {
    await writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    const result = await gitWorkingTreeDiff(repo);
    const file = result.files.find((item) => item.path === "binary.bin");
    assert.equal(file?.binary, true);
    assert.doesNotMatch(result.diff, /binary\.bin/);
  });

  await withRepo(async (repo) => {
    await writeFile(path.join(repo, "large.txt"), `${"x".repeat(300 * 1024)}\n`);
    const result = await gitWorkingTreeDiff(repo);
    const file = result.files.find((item) => item.path === "large.txt");
    assert.equal(file?.tooLarge, true);
    assert.doesNotMatch(result.diff, /large\.txt/);
  });

  const nonGit = await mkdtemp(path.join(tmpdir(), "codex-remote-console-nongit-"));
  try {
    await mkdir(path.join(nonGit, "nested"));
    await assert.rejects(gitWorkingTreeDiff(nonGit), /not inside a git worktree/);
  } finally {
    await rm(nonGit, { recursive: true, force: true });
  }

  console.log("git diff helper ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
