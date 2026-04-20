import { exec, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
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

  // start_background_task
  server.registerTool(
    "start_background_task",
    {
      description: "Start a background process (e.g. dev server) in the workspace.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to start."),
        cwd: z.string().optional().describe("Directory to start from (defaults to workspace root)."),
      }).strict(),
    },
    async ({ command, cwd }) => {
      try {
        const validatedCwd = security.validateDirectory(cwd || ".");
        
        // Use a single string for spawn when shell: true is enabled.
        // This is more cross-platform and handles arguments/quotes better.
        const child = spawn(command, { 
          cwd: validatedCwd,
          shell: true,
          // On Windows, shell: true uses cmd.exe /c.
          // On Unix, shell: true uses /bin/sh -c.
        });

        const taskId = `task_${Math.random().toString(36).substring(2, 9)}`;
        const logs: string[] = [];

        child.stdout?.on("data", (data) => {
          logs.push(data.toString());
          if (logs.length > 1000) logs.shift(); // Keep last 1000 lines
        });

        child.stderr?.on("data", (data) => {
          logs.push(`ERR: ${data.toString()}`);
          if (logs.length > 1000) logs.shift();
        });

        backgroundTasks.set(taskId, { 
          process: child, 
          logs, 
          command, 
          cwd: validatedCwd, 
          startTime: new Date().toISOString() 
        });

        child.on("exit", (code) => {
          logs.push(`[Process exited with code ${code}]`);
          // Note: We don't remove from map yet so logs can be read
        });

        return {
          content: [{ type: "text", text: `Task started with ID: ${taskId}` }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error starting task: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // list_background_tasks
  server.registerTool(
    "list_background_tasks",
    {
      description: "List all currently registered background tasks and their status.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const tasks = Array.from(backgroundTasks.entries()).map(([id, task]) => ({
        taskId: id,
        command: task.command,
        cwd: task.cwd,
        startTime: task.startTime,
        status: task.process.exitCode === null ? "running" : `exited (code: ${task.process.exitCode})`,
      }));

      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: "No background tasks found." }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
      };
    }
  );

  // get_background_task_logs
  server.registerTool(
    "get_background_task_logs",
    {
      description: "Read the latest logs from a running or recently exited background task.",
      inputSchema: z.object({
        taskId: z.string().describe("The ID of the task."),
        tail: z.number().optional().default(100).describe("Number of lines to return from the end."),
      }).strict(),
    },
    async ({ taskId, tail }) => {
      const task = backgroundTasks.get(taskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task ${taskId} not found.` }],
          isError: true,
        };
      }

      const logs = task.logs.slice(-tail);
      return {
        content: [{ type: "text", text: logs.join("") || "(No logs yet)" }],
      };
    }
  );

  // kill_background_task
  server.registerTool(
    "kill_background_task",
    {
      description: "Terminate a background task by its ID.",
      inputSchema: z.object({
        taskId: z.string().describe("The ID of the task to kill."),
      }).strict(),
    },
    async ({ taskId }) => {
      const task = backgroundTasks.get(taskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task ${taskId} not found.` }],
          isError: true,
        };
      }

      task.process.kill();
      backgroundTasks.delete(taskId);
      return {
        content: [{ type: "text", text: `Task ${taskId} killed.` }],
      };
    }
  );
}
