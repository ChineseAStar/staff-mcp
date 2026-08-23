import { spawn, execSync, ChildProcess } from "child_process";
import * as os from "os";
import * as fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SecurityManager } from "../security.js";
import {
  DEFAULT_TIMEOUT,
  MAX_WAIT_TIMEOUT,
  TASK_LOG_MAX_CHUNKS,
  TASK_LOG_MAX_CHARS,
  TASK_EXITED_KEEP,
  LOGS_WAIT_MAX,
  YIELD_TAIL_LINES,
  STOP_GRACE_MS,
  RESULT_MAX_CHARS,
} from "../constants.js";

// ============================================================
//  Unified shell execution with background task follow-up
//
//  Design (modeled after OpenAI Codex's "unified exec"):
//  - execute_command is the SINGLE entry point for running commands.
//  - It waits up to `timeout` ms for the process to finish. If the
//    process is still running, it is NOT killed — it is registered
//    as a background task and the call returns a task ID + recent
//    output. The caller follows up via manage_background_task.
//  - manage_background_task provides logs (optionally blocking via
//    `wait` until new output or exit), stop (kills the whole process
//    group, logs stay available), and list.
// ============================================================

export interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  /** null after the process exits */
  process: ChildProcess | null;
  startTime: string;
  startedAt: number;
  exitCode: number | null;
  exitSignal: string | null;
  exitedAt: number | null;
  /** true once stop was requested */
  killed: boolean;
  /** ring buffer of output chunks (stdout chunks, stderr chunks prefixed with "ERR: ") */
  logs: string[];
  logChars: number;
  droppedChars: number;
  /** callbacks woken on any new output or on exit (for logs `wait`) */
  waiters: Array<() => void>;
}

const backgroundTasks = new Map<string, BackgroundTask>();

/**
 * Determine the optimal shell to use for executing commands.
 * Prioritizes bash on POSIX systems, falling back to sh (like in Alpine).
 */
function getOptimalShell(): string | undefined {
  if (os.platform() === "win32") {
    return undefined; // Let Node.js determine the best shell (cmd.exe) on Windows
  }
  if (fs.existsSync("/bin/bash")) {
    return "/bin/bash";
  }
  return "/bin/sh";
}

const DEFAULT_SHELL = getOptimalShell();
const IS_WIN = os.platform() === "win32";

// ============================================================
//  Core helpers (exported for tests)
// ============================================================

function newTaskId(): string {
  return `task_${Math.random().toString(36).substring(2, 9)}`;
}

function pushLog(task: BackgroundTask, chunk: string): void {
  // Cap a single chunk so one huge write can't blow the budget
  if (chunk.length > TASK_LOG_MAX_CHARS) {
    task.droppedChars += chunk.length - TASK_LOG_MAX_CHARS;
    chunk = chunk.slice(-TASK_LOG_MAX_CHARS);
  }
  task.logs.push(chunk);
  task.logChars += chunk.length;
  while (task.logs.length > TASK_LOG_MAX_CHUNKS || task.logChars > TASK_LOG_MAX_CHARS) {
    const dropped = task.logs.shift()!;
    task.logChars -= dropped.length;
    task.droppedChars += dropped.length;
  }
  // Wake any logs(wait) callers
  const waiters = task.waiters.splice(0);
  for (const fn of waiters) fn();
}

/** Idempotent finalization on process exit (or spawn error). */
function finalizeTask(task: BackgroundTask, code: number | null, signal: string | null): void {
  if (task.exitedAt !== null) return;
  task.exitCode = code;
  task.exitSignal = signal;
  task.exitedAt = Date.now();
  task.process = null;
  pushLog(task, `[Process exited with code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}]`);
  evictOldExitedTasks();
}

/** Keep at most TASK_EXITED_KEEP exited tasks for postmortem inspection. */
function evictOldExitedTasks(): void {
  const exited = Array.from(backgroundTasks.values())
    .filter((t) => t.exitedAt !== null)
    .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));
  while (exited.length > TASK_EXITED_KEEP) {
    const oldest = exited.shift()!;
    backgroundTasks.delete(oldest.id);
  }
}

/**
 * Spawn a command and register it as a tracked task.
 * On POSIX the child is detached into its own process group so the whole
 * tree (shell → npm → node, ...) can be killed at once later.
 */
export function spawnTask(command: string, cwd: string): BackgroundTask {
  ensureExitCleanupHook();
  const child = spawn(command, {
    cwd,
    shell: DEFAULT_SHELL || true,
    detached: !IS_WIN,
  });

  const task: BackgroundTask = {
    id: newTaskId(),
    command,
    cwd,
    process: child,
    startTime: new Date().toISOString(),
    startedAt: Date.now(),
    exitCode: null,
    exitSignal: null,
    exitedAt: null,
    killed: false,
    logs: [],
    logChars: 0,
    droppedChars: 0,
    waiters: [],
  };
  backgroundTasks.set(task.id, task);

  child.stdout?.on("data", (data) => pushLog(task, data.toString()));
  child.stderr?.on("data", (data) => pushLog(task, `ERR: ${data.toString()}`));
  child.on("error", (err) => {
    pushLog(task, `[Process error: ${err.message}]`);
    finalizeTask(task, -1, null);
  });
  child.on("exit", (code, signal) => finalizeTask(task, code, signal));

  return task;
}

/** Resolve true when the task exits within `ms`, false otherwise. */
export function waitForExit(task: BackgroundTask, ms: number): Promise<boolean> {
  if (task.exitedAt !== null) return Promise.resolve(true);
  const child = task.process;
  if (!child) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/** Block up to `waitMs` until new output arrives or the process exits. */
function awaitTaskActivity(task: BackgroundTask, waitMs: number): Promise<void> {
  const wait = Math.min(Math.max(0, waitMs), LOGS_WAIT_MAX);
  if (wait <= 0 || task.exitedAt !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      task.waiters = task.waiters.filter((w) => w !== done);
      resolve();
    };
    const timer = setTimeout(done, wait);
    task.waiters.push(done);
  });
}

/**
 * Kill the whole process tree of a task.
 * POSIX: negative pid targets the process group (child was spawned detached).
 * Windows: taskkill /T walks the tree.
 */
function killTaskTree(task: BackgroundTask, signal: "SIGTERM" | "SIGKILL"): void {
  const child = task.process;
  if (!child || child.pid == null) return;
  if (IS_WIN) {
    // /F forces termination; no TERM/FKILL distinction on Windows
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { /* best effort */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Synchronous variant for the process-exit cleanup hook. */
function killTaskTreeSync(task: BackgroundTask, signal: "SIGTERM" | "SIGKILL"): void {
  const child = task.process;
  if (!child || child.pid == null) return;
  if (IS_WIN) {
    try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" }); } catch { /* best effort */ }
    return;
  }
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

/** Kill every still-running task immediately (used on shutdown and in tests). */
export function cleanupAllTasks(): void {
  for (const task of backgroundTasks.values()) {
    if (task.exitedAt === null) killTaskTreeSync(task, "SIGKILL");
  }
}

let exitHookRegistered = false;
function ensureExitCleanupHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on("exit", () => {
    for (const task of backgroundTasks.values()) {
      if (task.exitedAt === null) killTaskTreeSync(task, "SIGKILL");
    }
  });
}

// ============================================================
//  Formatting helpers
// ============================================================

function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

/** Truncate long output: cap by lines, then by characters, keeping head + tail. */
function formatOutput(out: string): string {
  let result = out;
  const lines = result.split(/\r?\n/);
  if (lines.length > 500) {
    result =
      lines.slice(0, 100).join("\n") +
      `\n\n...[${lines.length - 200} lines truncated for brevity]...\n\n` +
      lines.slice(-100).join("\n");
  }
  if (result.length > RESULT_MAX_CHARS) {
    const head = Math.floor(RESULT_MAX_CHARS * 0.4);
    const tail = RESULT_MAX_CHARS - head;
    result =
      result.slice(0, head) +
      `\n\n...[${result.length - RESULT_MAX_CHARS} characters truncated for brevity]...\n\n` +
      result.slice(-tail);
  }
  return result;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export function formatTaskStatus(task: BackgroundTask): string {
  if (task.exitedAt === null) {
    return `running (pid ${task.process?.pid ?? "unknown"}, up ${formatDuration(Date.now() - task.startedAt)})`;
  }
  const parts = [
    `exited (code: ${task.exitCode ?? "unknown"}${task.exitSignal ? `, signal: ${task.exitSignal}` : ""})`,
  ];
  if (task.killed) parts.push("killed by stop");
  return parts.join(", ");
}

// ============================================================
//  Tool-facing core operations
// ============================================================

export interface CoreResult {
  text: string;
  isError: boolean;
  taskId?: string;
}

/**
 * Run a command, waiting up to `timeout` ms for completion.
 * - Finished within the window → exit code + output (isError when exit code != 0).
 * - Still running → NOT killed; returns task ID + recent output, isError = false.
 */
export async function executeCommandCore(
  command: string,
  cwd: string,
  timeout: number
): Promise<CoreResult> {
  const task = spawnTask(command, cwd);
  const exited = await waitForExit(task, timeout);

  if (exited) {
    const logs = task.logs.join("");
    const statusLine =
      task.exitCode === 0
        ? "Exit Code: 0"
        : `Exit Code: ${task.exitCode ?? "unknown"}${task.exitSignal ? ` (signal ${task.exitSignal})` : ""}`;
    const droppedNote =
      task.droppedChars > 0 ? `\n\n[Note: ${task.droppedChars} characters of earlier output were dropped]` : "";
    const text = logs.trim()
      ? `${statusLine}\n\n${formatOutput(logs)}${droppedNote}`
      : `${statusLine}\n(No output from command)`;
    // One-shot command: nobody holds the task ID, drop the record.
    backgroundTasks.delete(task.id);
    return { text, isError: task.exitCode !== 0 };
  }

  const tail = tailLines(task.logs.join(""), YIELD_TAIL_LINES);
  const droppedNote =
    task.droppedChars > 0 ? `\n[Note: ${task.droppedChars} characters of earlier output were dropped]` : "";
  const text = [
    `[Process still running after ${timeout}ms — moved to background]`,
    `Task ID: ${task.id}`,
    `The process was NOT killed; it continues running in the background.`,
    `Next steps: use manage_background_task with this taskId — action "logs" (optionally set "wait" to block until new output or exit, "tail" for line count), action "stop" to terminate the whole process group, or action "list" to see all tasks.`,
    ``,
    `--- recent output (last ${YIELD_TAIL_LINES} lines) ---`,
    tail || "(no output yet)",
  ].join("\n");
  return { text: text + droppedNote, isError: false, taskId: task.id };
}

export function listTasksCore(): CoreResult {
  const tasks = Array.from(backgroundTasks.entries()).map(([id, task]) => ({
    taskId: id,
    command: task.command,
    cwd: task.cwd,
    startTime: task.startTime,
    status: formatTaskStatus(task),
  }));
  if (tasks.length === 0) {
    return { text: "No background tasks found.", isError: false };
  }
  return { text: JSON.stringify(tasks, null, 2), isError: false };
}

function taskNotFoundResult(taskId: string): CoreResult {
  const known = Array.from(backgroundTasks.keys());
  const hint = known.length > 0 ? ` Known tasks: ${known.join(", ")}.` : " No tasks are currently tracked.";
  return {
    text: `Task ${taskId} not found. It may have finished within execute_command's wait window (no task ID issued) or been evicted after exit.${hint}`,
    isError: true,
  };
}

export async function getTaskLogsCore(
  taskId: string,
  tail: number,
  wait: number
): Promise<CoreResult> {
  const task = backgroundTasks.get(taskId);
  if (!task) return taskNotFoundResult(taskId);

  await awaitTaskActivity(task, wait);

  const tailCount = tail > 0 ? tail : 100;
  const body = tailLines(task.logs.join(""), tailCount);
  const droppedNote =
    task.droppedChars > 0 ? `\n[Note: ${task.droppedChars} characters of earlier output were dropped]` : "";
  const text = [
    `Status: ${formatTaskStatus(task)}`,
    `Command: ${task.command}`,
    `cwd: ${task.cwd} (started: ${task.startTime})`,
    `--- last ${tailCount} lines ---`,
    body || "(No logs yet)",
  ].join("\n");
  return { text: text + droppedNote, isError: false };
}

export async function stopTaskCore(taskId: string): Promise<CoreResult> {
  const task = backgroundTasks.get(taskId);
  if (!task) return taskNotFoundResult(taskId);

  if (task.exitedAt !== null) {
    return {
      text: `Task ${taskId} has already ${formatTaskStatus(task)}. Its logs remain available via action "logs".`,
      isError: false,
    };
  }

  task.killed = true;
  pushLog(task, `[Stop requested: sending SIGTERM to process group]`);
  killTaskTree(task, "SIGTERM");

  let exited = await waitForExit(task, STOP_GRACE_MS);
  if (!exited) {
    pushLog(task, `[Process did not exit within ${STOP_GRACE_MS}ms, escalating to SIGKILL]`);
    killTaskTree(task, "SIGKILL");
    exited = await waitForExit(task, 1000);
  }

  const status = exited ? formatTaskStatus(task) : "termination signal sent (exit not observed)";
  const tail = tailLines(task.logs.join(""), 20);
  const text = [
    `Task ${taskId} stopped. Status: ${status}.`,
    `Logs remain available via manage_background_task action "logs".`,
    ``,
    `--- final output (last 20 lines) ---`,
    tail || "(no output)",
  ].join("\n");
  return { text, isError: false };
}

// ============================================================
//  Tool registration
// ============================================================

/**
 * Registers shell-related tools using the latest registerTool API.
 */
export function registerShellTools(server: McpServer, security: SecurityManager) {
  server.registerTool(
    "execute_command",
    {
      description:
        "Execute a shell command in a specified directory (sandboxed). Single entry point for ALL command execution: quick commands, builds, tests, and long-running processes (dev servers, watchers). If the command finishes within the timeout, returns its exit code and output. If it is still running when the timeout elapses, the process is NOT killed — it keeps running in the background and the call returns a task ID plus recent output; follow up with manage_background_task (actions: logs/stop/list).",
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute."),
        cwd: z.string().optional().describe("Directory to execute command from (must be allowed). Defaults to the workspace root."),
        timeout: z.number().optional().default(DEFAULT_TIMEOUT).describe(`How long to wait (in milliseconds) for the command to finish before it is moved to the background (default: ${DEFAULT_TIMEOUT}ms). The process is NOT killed when this elapses — you receive a task ID to follow up via manage_background_task. Values above ${MAX_WAIT_TIMEOUT}ms are clamped to ${MAX_WAIT_TIMEOUT}ms; for longer waits, poll via manage_background_task (action: logs, with wait).`),
      }).strict(),
    },
    async ({ command, cwd, timeout }, extra) => {
      try {
        const validatedCwd = security.validateDirectory(cwd || ".");
        // Clamp the blocking wait so the tool always responds well before any MCP
        // client-side request timeout (chat-ai: 1 hour). Otherwise the caller gives
        // up first and the auto-backgrounded task's ID is lost (orphaned task).
        const waitMs = Math.min(timeout, MAX_WAIT_TIMEOUT);
        const onAbort = () => console.error("[shell-tools] MCP request cancelled while the command may still be " +
          "running; it continues and auto-backgrounds on its own (locate it via manage_background_task, " +
          `action: list). command: ${command.slice(0, 200)}`);
        extra?.signal?.addEventListener("abort", onAbort, { once: true });
        const result = await executeCommandCore(command, validatedCwd, waitMs);
        extra?.signal?.removeEventListener("abort", onAbort);
        return {
          content: [{ type: "text", text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error executing command: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "manage_background_task",
    {
      description:
        "Follow up on background processes that execute_command returned a task ID for (e.g. dev servers, long builds). Actions: 'logs' reads recent output (optionally blocking via 'wait' until new output arrives or the process exits), 'stop' terminates the whole process group (SIGTERM, then SIGKILL after a grace period; logs remain available afterwards), 'list' shows all tracked tasks. Note: commands are started exclusively via execute_command — there is no 'start' action.",
      inputSchema: z.object({
        action: z.enum(["list", "logs", "stop"]).describe("The action to perform."),
        taskId: z.string().optional().describe("Required for 'logs' and 'stop'. The task ID returned by execute_command (or shown by 'list')."),
        tail: z.number().optional().default(100).describe("Optional for 'logs'. Number of lines to return from the end (default: 100)."),
        wait: z.number().optional().default(0).describe(`Optional for 'logs'. Block up to this many milliseconds until new output arrives or the process exits, instead of polling repeatedly (max: ${LOGS_WAIT_MAX}ms, default: 0).`),
      }).strict(),
    },
    async ({ action, taskId, tail, wait }) => {
      try {
        if (action === "list") {
          const result = listTasksCore();
          return { content: [{ type: "text", text: result.text }] };
        }
        if (!taskId) {
          return {
            content: [{ type: "text", text: `Error: 'taskId' is required for action '${action}'.` }],
            isError: true,
          };
        }
        const result =
          action === "logs"
            ? await getTaskLogsCore(taskId, tail, wait)
            : await stopTaskCore(taskId);
        return {
          content: [{ type: "text", text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error in manage_background_task (${action}): ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
