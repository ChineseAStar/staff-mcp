import { exec, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SecurityManager } from "../security.js";
import { DEFAULT_TIMEOUT } from "../constants.js";

const execAsync = promisify(exec);

// Store for background tasks
interface BackgroundTask {
  process: ChildProcess;
  logs: string[];
  command: string;
  cwd: string;
  startTime: string;
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

/**
 * Registers shell-related tools using the latest registerTool API.
 */
export function registerShellTools(server: McpServer, security: SecurityManager) {
  server.registerTool(
    "execute_command",
    {
      description: "Execute a shell command in a specified directory (sandboxed) with an optional timeout.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute."),
        cwd: z.string().optional().describe("Directory to execute command from (must be allowed). Defaults to the workspace root."),
        timeout: z.number().optional().default(DEFAULT_TIMEOUT).describe(`Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}ms).`),
      }).strict(),
    },
    async ({ command, cwd, timeout }) => {
      try {
        const validatedCwd = security.validateDirectory(cwd || ".");

        const { stdout, stderr } = await execAsync(command, {
          cwd: validatedCwd,
          timeout: timeout,
          shell: DEFAULT_SHELL, // use the precise shell string or undefined for windows
        });

        // Truncate output if too long
        const formatOutput = (out: string) => {
          const lines = out.split(/\r?\n/);
          if (lines.length > 500) {
            return lines.slice(0, 100).join("\n") + 
                   `\n\n...[${lines.length - 200} lines truncated for brevity]...\n\n` + 
                   lines.slice(-100).join("\n");
          }
          return out;
        };

        const output = [
          stdout ? `STDOUT:\n${formatOutput(stdout)}` : "",
          stderr ? `STDERR:\n${formatOutput(stderr)}` : "",
        ].filter(Boolean).join("\n\n");

        return {
          content: [{ type: "text", text: output || "(No output from command)" }],
        };
      } catch (error: any) {
        // If timed out or error occurred, still try to return what we have or a meaningful error
        let errorMessage = error.message;
        if (error.killed && error.signal === 'SIGTERM') {
          errorMessage = `Command timed out after ${timeout}ms.`;
        }
        return {
          content: [{ type: "text", text: `Command execution failed or timed out: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  // manage_background_task (combines start, list, logs, kill)
  server.registerTool(
    "manage_background_task",
    {
      description: "Manage background processes (e.g. dev servers) in the workspace. Use 'start' to start a new task, 'list' to view tasks, 'logs' to read output, and 'stop' to terminate.",
      inputSchema: z.object({
        action: z.enum(["start", "list", "logs", "stop"]).describe("The action to perform."),
        command: z.string().optional().describe("Required for 'start'. The shell command to start."),
        cwd: z.string().optional().describe("Optional for 'start'. Directory to start from (defaults to workspace root)."),
        taskId: z.string().optional().describe("Required for 'logs' and 'stop'. The ID of the task."),
        tail: z.number().optional().default(100).describe("Optional for 'logs'. Number of lines to return from the end."),
      }).strict(),
    },
    async ({ action, command, cwd, taskId, tail }) => {
      if (action === "start") {
        if (!command) {
          return { content: [{ type: "text", text: "Error: 'command' is required for action 'start'." }], isError: true };
        }
        try {
          const validatedCwd = security.validateDirectory(cwd || ".");
          const child = spawn(command, { 
            cwd: validatedCwd,
            shell: DEFAULT_SHELL || true,
          });

          const newTaskId = `task_${Math.random().toString(36).substring(2, 9)}`;
          const logs: string[] = [];

          child.stdout?.on("data", (data) => {
            logs.push(data.toString());
            if (logs.length > 1000) logs.shift();
          });

          child.stderr?.on("data", (data) => {
            logs.push(`ERR: ${data.toString()}`);
            if (logs.length > 1000) logs.shift();
          });

          backgroundTasks.set(newTaskId, { 
            process: child, 
            logs, 
            command, 
            cwd: validatedCwd, 
            startTime: new Date().toISOString() 
          });

          child.on("exit", (code) => {
            logs.push(`[Process exited with code ${code}]`);
          });

          return { content: [{ type: "text", text: `Task started with ID: ${newTaskId}` }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error starting task: ${error.message}` }], isError: true };
        }
      } else if (action === "list") {
        const tasks = Array.from(backgroundTasks.entries()).map(([id, task]) => ({
          taskId: id,
          command: task.command,
          cwd: task.cwd,
          startTime: task.startTime,
          status: task.process.exitCode === null ? "running" : `exited (code: ${task.process.exitCode})`,
        }));

        if (tasks.length === 0) {
          return { content: [{ type: "text", text: "No background tasks found." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
      } else if (action === "logs") {
        if (!taskId) {
          return { content: [{ type: "text", text: "Error: 'taskId' is required for action 'logs'." }], isError: true };
        }
        const task = backgroundTasks.get(taskId);
        if (!task) {
          return { content: [{ type: "text", text: `Task ${taskId} not found.` }], isError: true };
        }
        const taskLogs = task.logs.slice(-(tail || 100));
        return { content: [{ type: "text", text: taskLogs.join("") || "(No logs yet)" }] };
      } else if (action === "stop") {
        if (!taskId) {
          return { content: [{ type: "text", text: "Error: 'taskId' is required for action 'stop'." }], isError: true };
        }
        const task = backgroundTasks.get(taskId);
        if (!task) {
          return { content: [{ type: "text", text: `Task ${taskId} not found.` }], isError: true };
        }
        task.process.kill();
        backgroundTasks.delete(taskId);
        return { content: [{ type: "text", text: `Task ${taskId} killed.` }] };
      }
      return { content: [{ type: "text", text: `Invalid action: ${action}` }], isError: true };
    }
  );
}
