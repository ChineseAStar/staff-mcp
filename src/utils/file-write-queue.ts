import * as fs from "fs/promises";
import * as path from "path";

/**
 * Per-path write serialization.
 *
 * edit_file_by_replace performs a read-modify-write cycle: concurrent calls on
 * the same file race — each reads the same old content, then overwrites the
 * others' changes (lost update) — and interleaved fs.writeFile calls on one
 * path can tear a file (mixed blocks, multi-byte UTF-8 chars cut in half).
 *
 * Chaining writes per path eliminates both classes of corruption, while
 * unrelated files still write fully in parallel.
 */
const writeQueues = new Map<string, Promise<unknown>>();

export function enqueueFileWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(filePath) ?? Promise.resolve();
  // Run the task after the previous one settles, even if it failed.
  const next = prev.then(task, task);
  // Store a rejection-safe tail so one failing task cannot poison the chain.
  const tail = next.catch(() => {});
  writeQueues.set(filePath, tail);
  // Best-effort cleanup once the queue drains, to avoid unbounded map growth.
  tail.finally(() => {
    if (writeQueues.get(filePath) === tail) {
      writeQueues.delete(filePath);
    }
  }).catch(() => {});
  return next;
}

/**
 * Atomic file write: write the full content to a sibling temp file, then
 * rename(2) over the target. Rename is atomic on the same filesystem, so
 * readers always see either the complete old content or the complete new
 * content — never a half-written file — and a crash mid-write leaves the
 * original untouched (at worst an orphan .tmp file remains).
 */
export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    // Do not leave the temp file behind on failure.
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}
