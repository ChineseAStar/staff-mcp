import assert from "node:assert/strict";
import { test, after } from "node:test";
import {
  executeCommandCore,
  getTaskLogsCore,
  stopTaskCore,
  listTasksCore,
  cleanupAllTasks,
} from "../src/tools/shell-tools.js";

const CWD = process.cwd();
const NODE = `"${process.execPath}"`;
const IS_WIN = process.platform === "win32";

after(() => {
  cleanupAllTasks();
});

test("fast command completes within the wait window and leaves no task behind", async () => {
  const result = await executeCommandCore(`${NODE} -e "console.log('hello-from-test')"`, CWD, 5000);

  assert.equal(result.isError, false);
  assert.equal(result.taskId, undefined);
  assert.match(result.text, /Exit Code: 0/);
  assert.match(result.text, /hello-from-test/);

  // one-shot commands are not tracked
  assert.match(listTasksCore().text, /No background tasks found/);
});

test("failing command reports a non-zero exit code as an error", async () => {
  const result = await executeCommandCore(`${NODE} -e "process.exit(3)"`, CWD, 5000);

  assert.equal(result.isError, true);
  assert.match(result.text, /Exit Code: 3/);
});

test("output larger than 1MB completes instead of dying with maxBuffer exceeded", async () => {
  // 2MB of output — the old exec-based implementation failed here (Node default maxBuffer = 1MB)
  const result = await executeCommandCore(
    `${NODE} -e "process.stdout.write('x'.repeat(2 * 1024 * 1024))"`,
    CWD,
    30000
  );

  assert.equal(result.isError, false);
  assert.match(result.text, /Exit Code: 0/);
  // ring buffer (100KB) and result cap (50KB) must have kicked in
  assert.match(result.text, /truncated|dropped/i);
  assert.ok(result.text.length < 200_000, `result should be bounded, got ${result.text.length}`);
});

test("slow command yields a task ID, logs(wait) follows it to completion, stop reports already-exited", async () => {
  const result = await executeCommandCore(
    `${NODE} -e "console.log('started'); setTimeout(() => console.log('finished'), 2500)"`,
    CWD,
    300
  );

  // not killed on timeout: moved to background with a task ID, NOT an error
  assert.equal(result.isError, false);
  assert.ok(result.taskId, "expected a task ID for the still-running process");
  assert.match(result.text, /still running/);
  assert.match(result.text, /NOT killed/);
  assert.match(result.text, /started/);
  assert.match(result.text, new RegExp(result.taskId!));

  // logs(wait) blocks until new output OR exit; poll until the exit is observed
  const t0 = Date.now();
  let logs = await getTaskLogsCore(result.taskId!, 100, 15000);
  for (let i = 0; i < 10 && !/exited \(code: 0\)/.test(logs.text); i++) {
    logs = await getTaskLogsCore(result.taskId!, 100, 15000);
  }
  const elapsed = Date.now() - t0;
  assert.equal(logs.isError, false);
  assert.match(logs.text, /finished/);
  assert.match(logs.text, /exited \(code: 0\)/);
  assert.ok(elapsed < 14000, `logs(wait) returned after ${elapsed}ms, expected early wakeup on exit`);

  // stopping an already-exited task is a no-op, not an error
  const stop = await stopTaskCore(result.taskId!);
  assert.equal(stop.isError, false);
  assert.match(stop.text, /already/);

  // exited task is still listed for postmortem
  assert.match(listTasksCore().text, new RegExp(result.taskId!));
});

test("unknown task ID produces a helpful not-found error", async () => {
  const logs = await getTaskLogsCore("task_does_not_exist", 100, 0);
  assert.equal(logs.isError, true);
  assert.match(logs.text, /not found/);

  const stop = await stopTaskCore("task_does_not_exist");
  assert.equal(stop.isError, true);
  assert.match(stop.text, /not found/);
});

test(
  "stop terminates the whole process group and keeps logs for postmortem",
  { skip: IS_WIN },
  async () => {
    // Parent spawns a grandchild in the same process group, then both idle.
    const result = await executeCommandCore(
      `${NODE} -e "const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); console.log('grandchild:' + g.pid); setInterval(() => {}, 1000);"`,
      CWD,
      300
    );
    assert.equal(result.isError, false);
    assert.ok(result.taskId, "expected a task ID");

    // wait until the grandchild PID shows up in the logs
    let grandchildPid: number | null = null;
    for (let i = 0; i < 20 && grandchildPid === null; i++) {
      const logs = await getTaskLogsCore(result.taskId!, 100, 1000);
      const m = logs.text.match(/grandchild:(\d+)/);
      if (m) grandchildPid = Number(m[1]);
    }
    assert.ok(grandchildPid, "grandchild PID should appear in task logs");

    const stop = await stopTaskCore(result.taskId!);
    assert.equal(stop.isError, false);
    assert.match(stop.text, /stopped/);

    // the grandchild must be gone too (process-group kill, not just the shell)
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `grandchild process ${grandchildPid} should have been killed`);

    // postmortem: logs still available, status reflects the kill
    const postmortem = await getTaskLogsCore(result.taskId!, 100, 0);
    assert.equal(postmortem.isError, false);
    assert.match(postmortem.text, /killed by stop/);
  }
);

test("logs(wait) wakes up early when new output arrives", async () => {
  const result = await executeCommandCore(
    `${NODE} -e "setInterval(() => console.log('tick'), 400); setTimeout(() => process.exit(0), 5000);"`,
    CWD,
    300
  );
  assert.ok(result.taskId);

  const t0 = Date.now();
  const logs = await getTaskLogsCore(result.taskId!, 100, 30000); // generous cap
  const elapsed = Date.now() - t0;

  assert.equal(logs.isError, false);
  assert.match(logs.text, /tick/);
  assert.ok(elapsed < 10000, `logs(wait) should wake on new output, took ${elapsed}ms`);

  await stopTaskCore(result.taskId!);
});
