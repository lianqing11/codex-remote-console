import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveUploadedInputs, UploadStore } from "../server/uploads";

async function* chunks(...values: Array<string | Uint8Array>) {
  for (const value of values) yield value;
}

function privateMode(mode: number) {
  return mode & 0o777;
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-console-uploads-"));
  try {
    const store = new UploadStore({ root, maxBytes: 1024 });
    const document = await store.save(chunks("hello", " server"), {
      name: "../../notes.txt",
      contentType: "text/plain; charset=utf-8",
      contentLength: 12
    });
    assert.equal(document.name, "notes.txt");
    assert.equal(document.contentType, "text/plain");
    assert.equal(document.size, 12);
    assert.equal(document.image, false);
    assert.equal(await readFile(document.filePath, "utf8"), "hello server");
    assert.equal(privateMode((await stat(root)).mode), 0o700);
    assert.equal(privateMode((await stat(document.filePath)).mode), 0o600);
    assert.equal("filePath" in store.toPublic(document), false);

    const resolvedDocument = await resolveUploadedInputs({
      threadId: "thread-1",
      input: [{ type: "text", text: "Read it" }, { type: "uploadedFile", uploadId: document.id }]
    }, store) as any;
    assert.deepEqual(resolvedDocument.input[0], { type: "text", text: "Read it" });
    assert.deepEqual(resolvedDocument.input[1], {
      type: "mention",
      name: "notes.txt",
      path: document.filePath
    });

    const image = await store.save(chunks(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), {
      name: "pixel.png",
      contentType: "image/png",
      contentLength: 4
    });
    const resolvedImage = await resolveUploadedInputs({
      input: [{ type: "uploadedFile", uploadId: image.id }]
    }, store) as any;
    assert.deepEqual(resolvedImage.input[0], { type: "localImage", path: image.filePath });

    const resolvedImageAsFile = await resolveUploadedInputs({
      input: [{ type: "uploadedFile", uploadId: image.id, asImage: false }]
    }, store) as any;
    assert.deepEqual(resolvedImageAsFile.input[0], {
      type: "mention",
      name: "pixel.png",
      path: image.filePath
    });

    await store.remove(document.id);
    await assert.rejects(store.get(document.id), /Upload not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const limitedRoot = await mkdtemp(path.join(tmpdir(), "coding-agent-console-upload-limit-"));
  try {
    const limited = new UploadStore({ root: limitedRoot, maxBytes: 3 });
    await assert.rejects(
      limited.save(chunks("abcd"), { name: "large.bin", contentType: "application/octet-stream" }),
      /3 bytes or smaller/
    );
    assert.deepEqual(await readdir(limitedRoot), []);
    await assert.rejects(limited.get("../../etc/passwd"), /Upload not found/);
  } finally {
    await rm(limitedRoot, { recursive: true, force: true });
  }

  console.log("server upload tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
