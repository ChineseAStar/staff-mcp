import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { enqueueFileWrite, atomicWriteFile } from "../src/utils/file-write-queue.js";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fwq-test-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("concurrent read-modify-write cycles lose no updates", async () => {
  const file = path.join(tmpDir, "concurrent.txt");
  await fs.writeFile(file, "", "utf-8");

  // The regression this guards against: N concurrent read-modify-write
  // cycles (the edit_file_by_replace pattern) must all survive.
  const N = 50;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      enqueueFileWrite(file, async () => {
        const content = await fs.readFile(file, "utf-8");
        await atomicWriteFile(file, content + `line-${i}\n`);
      })
    )
  );

  const final = await fs.readFile(file, "utf-8");
  const lines = final.trim().split("\n");
  assert.equal(lines.length, N, "all appends must survive");
  for (let i = 0; i < N; i++) {
    assert.ok(lines.includes(`line-${i}`), `missing line-${i}`);
  }
});

test("atomic write never produces torn content under concurrency", async () => {
  const file = path.join(tmpDir, "atomic.txt");
  const bigA = "A".repeat(200_000);
  const bigB = "B".repeat(200_000);

  await Promise.all([
    enqueueFileWrite(file, () => atomicWriteFile(file, bigA)),
    enqueueFileWrite(file, () => atomicWriteFile(file, bigB)),
    enqueueFileWrite(file, () => atomicWriteFile(file, bigA)),
    enqueueFileWrite(file, () => atomicWriteFile(file, bigB)),
  ]);

  const final = await fs.readFile(file, "utf-8");
  assert.ok(final === bigA || final === bigB, "content must be one complete version, never mixed");
});

test("writes to different paths still run in parallel", async () => {
  const fileA = path.join(tmpDir, "a.txt");
  const fileB = path.join(tmpDir, "b.txt");

  let aRunning = false;
  let overlapObserved = false;

  await Promise.all([
    enqueueFileWrite(fileA, async () => {
      aRunning = true;
      await new Promise((r) => setTimeout(r, 50));
      aRunning = false;
      await atomicWriteFile(fileA, "a");
    }),
    enqueueFileWrite(fileB, async () => {
      if (aRunning) overlapObserved = true;
      await atomicWriteFile(fileB, "b");
    }),
  ]);

  assert.equal(overlapObserved, true, "different paths must not block each other");
  assert.equal(await fs.readFile(fileA, "utf-8"), "a");
  assert.equal(await fs.readFile(fileB, "utf-8"), "b");
});

test("a failing task does not poison the queue", async () => {
  const file = path.join(tmpDir, "poison.txt");

  await assert.rejects(
    enqueueFileWrite(file, async () => {
      throw new Error("boom");
    }),
    /boom/
  );

  // Subsequent task on the same path must still run.
  const result = await enqueueFileWrite(file, async () => {
    await atomicWriteFile(file, "alive");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(await fs.readFile(file, "utf-8"), "alive");
});

test("atomicWriteFile leaves no temp file behind", async () => {
  const file = path.join(tmpDir, "clean.txt");
  await atomicWriteFile(file, "content-中文-🎉");

  assert.equal(await fs.readFile(file, "utf-8"), "content-中文-🎉");
  const siblings = await fs.readdir(tmpDir);
  assert.ok(
    !siblings.some((name) => name.endsWith(".tmp")),
    `temp file leaked: ${siblings.join(", ")}`
  );
});

test("atomicWriteFile cleans up temp file when write fails", async () => {
  const dirFile = path.join(tmpDir, "is-a-dir");
  await fs.mkdir(dirFile); // rename onto an existing non-empty path is fine, but writing INTO a dir path fails below
  const blocked = path.join(dirFile, "sub.txt");
  await fs.writeFile(blocked, "x");

  // rename(file, existing-empty-dir) is OK on POSIX, so force failure differently:
  // make the directory read-only so the temp file cannot be created.
  const roDir = path.join(tmpDir, "read-only");
  await fs.mkdir(roDir);
  await fs.chmod(roDir, 0o500);
  try {
    await assert.rejects(atomicWriteFile(path.join(roDir, "x.txt"), "data"));
    const leftovers = await fs.readdir(roDir);
    assert.deepEqual(leftovers, [], "temp file must be cleaned up on failure");
  } finally {
    await fs.chmod(roDir, 0o700);
  }
});
