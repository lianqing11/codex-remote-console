import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listProjectTree, readProjectAsset, readProjectFile, resolveProject, writeProjectUpload } from "../server/project";

async function* chunks(...values: Array<string | Uint8Array>) {
  for (const value of values) yield value;
}

async function withProject(fn: (project: string, outside: string) => Promise<void>) {
  const project = await mkdtemp(path.join(tmpdir(), "codex-remote-console-project-"));
  const outside = await mkdtemp(path.join(tmpdir(), "codex-remote-console-outside-"));
  try {
    await fn(project, outside);
  } finally {
    await Promise.all([
      rm(project, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true })
    ]);
  }
}

async function main() {
  await withProject(async (project) => {
    await Promise.all([
      mkdir(path.join(project, "src")),
      mkdir(path.join(project, ".git")),
      mkdir(path.join(project, "node_modules")),
      writeFile(path.join(project, "README.md"), "# Reader\n\n- [x] works\n"),
      writeFile(path.join(project, ".env"), "SAFE_FOR_TESTS=yes\n"),
      writeFile(path.join(project, "z.txt"), "last\n")
    ]);
    await writeFile(path.join(project, "src", "main.py"), "def main():\n    return 1\n");

    const root = await listProjectTree(project);
    assert.deepEqual(root.entries.map((entry) => entry.name), ["src", ".env", "README.md", "z.txt"]);
    assert.equal(root.entries.some((entry) => entry.name === ".git"), false);
    assert.equal(root.entries.some((entry) => entry.name === "node_modules"), false);
    assert.equal(root.entries[0].kind, "directory");
    assert.equal(root.parent, null);

    const nested = await listProjectTree(project, "src");
    assert.equal(nested.parent, "");
    assert.equal(nested.entries[0].path, "src/main.py");

    const markdown = await readProjectFile(project, "README.md");
    assert.equal(markdown.viewer, "markdown");
    assert.equal(markdown.language, "markdown");
    assert.match(markdown.content || "", /Reader/);

    const python = await readProjectFile(project, "src/main.py");
    assert.equal(python.viewer, "code");
    assert.equal(python.language, "python");

    const dotFile = await readProjectFile(project, ".env");
    assert.equal(dotFile.viewer, "text");
  });

  await withProject(async (project, outside) => {
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    await writeFile(path.join(project, "inside.txt"), "inside\n");
    await symlink(path.join(project, "inside.txt"), path.join(project, "inside-link.txt"));
    await symlink(path.join(outside, "secret.txt"), path.join(project, "outside-link.txt"));

    assert.equal((await readProjectFile(project, "inside-link.txt")).content, "inside\n");
    const listing = await listProjectTree(project);
    assert.equal(listing.entries.find((entry) => entry.name === "outside-link.txt")?.accessible, false);
    await assert.rejects(readProjectFile(project, "outside-link.txt"), /escapes/);
    await assert.rejects(readProjectFile(project, "../secret.txt"), /project-relative/);
    await assert.rejects(readProjectFile(project, path.join(project, "inside.txt")), /project-relative/);
  });

  await withProject(async (project, outside) => {
    await mkdir(path.join(project, "docs"));
    const rootUpload = await writeProjectUpload(project, chunks("hello", " project\n"), {
      name: "notes.txt",
      maxBytes: 1024,
      contentLength: 14
    });
    assert.equal(rootUpload.path, "notes.txt");
    assert.equal(rootUpload.directory, "");
    assert.equal(rootUpload.overwritten, false);
    assert.equal(rootUpload.size, 14);
    assert.equal(await readFile(path.join(project, "notes.txt"), "utf8"), "hello project\n");
    assert.equal((await stat(path.join(project, "notes.txt"))).mode & 0o777, 0o644);

    const nestedUpload = await writeProjectUpload(project, chunks("nested\n"), {
      directory: "docs",
      name: "guide.md",
      maxBytes: 1024
    });
    assert.equal(nestedUpload.path, "docs/guide.md");
    assert.equal((await listProjectTree(project, "docs")).entries[0].name, "guide.md");

    await chmod(path.join(project, "notes.txt"), 0o600);
    await assert.rejects(
      writeProjectUpload(project, chunks("blocked\n"), { name: "notes.txt", maxBytes: 1024 }),
      (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 409
    );
    const overwritten = await writeProjectUpload(project, chunks("replacement\n"), {
      name: "notes.txt",
      overwrite: true,
      maxBytes: 1024
    });
    assert.equal(overwritten.overwritten, true);
    assert.equal(await readFile(path.join(project, "notes.txt"), "utf8"), "replacement\n");
    assert.equal((await stat(path.join(project, "notes.txt"))).mode & 0o777, 0o600);

    await symlink(outside, path.join(project, "outside-directory"));
    await assert.rejects(
      writeProjectUpload(project, chunks("secret"), { directory: "outside-directory", name: "secret.txt", maxBytes: 1024 }),
      /escapes/
    );
    await assert.rejects(
      writeProjectUpload(project, chunks("bad"), { directory: "../outside", name: "bad.txt", maxBytes: 1024 }),
      /project-relative/
    );
    await assert.rejects(
      writeProjectUpload(project, chunks("bad"), { name: "nested/bad.txt", maxBytes: 1024 }),
      /valid file name/
    );
    await assert.rejects(
      writeProjectUpload(project, chunks("toolarge"), { name: "large.txt", maxBytes: 3 }),
      /3 bytes or smaller/
    );
    assert.equal((await readdir(project)).some((name) => name.includes(".codex-project-upload.")), false);
    assert.equal((await readdir(project)).includes("large.txt"), false);
  });

  await withProject(async (project) => {
    await writeFile(path.join(project, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(project, "large.txt"), "x".repeat(513 * 1024));
    await writeFile(path.join(project, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(project, "vector.svg"), "<svg></svg>");

    const binary = await readProjectFile(project, "binary.bin");
    assert.equal(binary.binary, true);
    assert.equal(binary.viewer, "unsupported");
    assert.equal(binary.content, null);

    const large = await readProjectFile(project, "large.txt");
    assert.equal(large.tooLarge, true);
    assert.equal(large.content, null);

    const image = await readProjectAsset(project, "pixel.png");
    assert.equal(image.contentType, "image/png");
    assert.equal(image.size, 4);
    await assert.rejects(readProjectAsset(project, "vector.svg"), /raster/);
  });

  await withProject(async (project) => {
    await Promise.all(
      Array.from({ length: 505 }, (_, index) => writeFile(path.join(project, `file-${String(index).padStart(3, "0")}.txt`), "x"))
    );
    const listing = await listProjectTree(project);
    assert.equal(listing.entries.length, 500);
    assert.equal(listing.truncated, true);
  });

  await withProject(async (project, outside) => {
    const previous = process.env.CODEX_WEB_PROJECT_ROOTS;
    process.env.CODEX_WEB_PROJECT_ROOTS = project;
    try {
      assert.equal((await resolveProject(project)).exists, true);
      await listProjectTree(project);
      await assert.rejects(resolveProject(outside), /CODEX_WEB_PROJECT_ROOTS/);
      await assert.rejects(listProjectTree(outside), /CODEX_WEB_PROJECT_ROOTS/);
    } finally {
      if (previous === undefined) delete process.env.CODEX_WEB_PROJECT_ROOTS;
      else process.env.CODEX_WEB_PROJECT_ROOTS = previous;
    }
  });

  console.log("project file helper ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
