import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn, type ChildProcess } from "child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { STAFF_MCP_VERSION } from "../package-info.js";

interface McpSession {
  sessionId: string;
  command: string;
  args: string[];
  process: ChildProcess | null;
  client: Client;
  transport: Transport | null;
  status: "starting" | "ready" | "stopping" | "error" | "exited";
  startController: AbortController;
  cleanup?: Promise<string[]>;
  startedAt: Date;
  error?: string;
}

const sessions = new Map<string, McpSession>();

function assertStarting(session: McpSession): void {
  if (sessions.get(session.sessionId) !== session || session.startController.signal.aborted || session.status !== "starting") {
    throw new Error(session.error || `MCP session '${session.sessionId}' startup was cancelled.`);
  }
}

function watchClientClose(session: McpSession): void {
  const client = session.client;
  client.onclose = () => {
    if (sessions.get(session.sessionId) === session && session.client === client && session.status === "ready") {
      session.status = "exited";
      session.error = "MCP connection closed.";
    }
  };
}

async function closeSessionConnection(session: McpSession): Promise<string[]> {
  const errors: string[] = [];
  try {
    await session.client.close();
  } catch (err) {
    errors.push(`Client close failed: ${String(err)}`);
    // The transport may still own resources when Client.close rejects (including stdio children).
    try {
      await session.transport?.close();
    } catch (transportError) {
      errors.push(`Transport close failed: ${String(transportError)}`);
    }
  }
  return errors;
}

async function cleanupSession(session: McpSession): Promise<string[]> {
  if (session.cleanup) return session.cleanup;
  const cleanup = (async () => {
    const errors = await closeSessionConnection(session);
    // HTTP children are detached: kill the owned group, even if the leader has exited.
    // This must not be skipped when closing the MCP connection fails.
    if (session.process?.pid) {
      try {
        process.kill(process.platform === "win32" ? session.process.pid : -session.process.pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          errors.push(`HTTP process cleanup failed: ${String(err)}`);
        }
      }
    }
    return errors;
  })();
  session.cleanup = cleanup;
  try {
    return await cleanup;
  } finally {
    // A connect which completes after stop needs another close, not a cached cleanup result.
    if (session.cleanup === cleanup) session.cleanup = undefined;
  }
}

async function connectSession(session: McpSession): Promise<void> {
  assertStarting(session);
  const { signal } = session.startController;
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // SDK connect's signal only covers protocol requests, not transport.start().
  // SSE start can remain pending even after EventSource.close(), so stop must
  // settle our wait without waiting for the underlying connect to finish.
  const connecting = (async () => {
    try {
      await session.client.connect(session.transport!, { signal });
    } finally {
      if (signal.aborted) {
        // A late success or failure may leave resources after the earlier stop.
        // Wait for any in-flight close, then perform a fresh cleanup of this
        // session only; never reinsert it or touch a replacement with the same ID.
        const previousErrors = session.cleanup ? await session.cleanup : [];
        const errors = [...previousErrors, ...(await cleanupSession(session))];
        if (sessions.get(session.sessionId) === session && errors.length > 0) {
          session.status = "error";
          session.error = [session.error, ...errors].filter(Boolean).join("; ");
        }
      }
    }
  })();
  try {
    // Promise.race also observes a late rejection, avoiding unhandled failures.
    await Promise.race([connecting, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Ensures a session exists and is ready
 */
function getReadySession(sessionId: string): McpSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`MCP Session '${sessionId}' not found. Please use 'manage_mcp_session' with action: "list" to check active sessions or start it first.`);
  }
  if (session.status !== "ready") {
    throw new Error(`MCP Session '${sessionId}' is not in ready state. Current status: ${session.status}. It might have failed to start or crashed. Check logs if necessary.`);
  }
  return session;
}

async function listAllTools(client: Client, signal?: AbortSignal): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    // Use the protocol request rather than Client.listTools(): SDK v1 replaces
    // its output-schema/task metadata cache on *every page*, which can affect
    // concurrent tool calls while discovery is still in progress.
    const page = await client.request(
      { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema,
      { signal },
    );
    for (const tool of page.tools) {
      tools.push(tool);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new Error(`Cannot retrieve a complete tool list: repeated pagination cursor '${cursor}'.`);
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);

  // SDK v1's listTools() ordinarily installs per-tool output validators and
  // task metadata, but only for its last page. Install the complete snapshot
  // once after a successful traversal. Do not clear metadata on partial reads.
  // This SDK method is private in TypeScript; keep the compatibility access
  // centralized until the SDK exposes a public full-list metadata API.
  (client as unknown as { cacheToolMetadata(tools: Tool[]): void }).cacheToolMetadata(tools);
  return tools;
}

export function registerMcpClientTools(server: McpServer, options: { maxSessions: number } = { maxSessions: 5 }): void {
  // 1. manage_mcp_session (combines start, stop, list)
  server.registerTool(
    "manage_mcp_session",
    {
      description: "Manage background Model Context Protocol (MCP) server processes. Actions: 'start' (requires sessionId, command, args), 'stop' (requires sessionId), 'list'.",
      inputSchema: z.object({
        action: z.enum(["start", "stop", "list"]).describe("The action to perform on MCP sessions."),
        sessionId: z.string().optional().describe("A unique identifier for this session. Required for 'start' and 'stop'."),
        command: z.string().optional().describe("Required for 'start'. The executable command to run the server."),
        args: z.array(z.string()).optional().describe("Required for 'start'. Arguments to pass to the command."),
        env: z.record(z.string(), z.string()).optional().describe("Optional for 'start'. Additional environment variables to pass to the command. They will be merged with the system environment."),
        transportType: z.enum(["stdio", "http"]).optional().describe("Optional for 'start'. Transport type. Default is 'stdio'. Use 'http' for HTTP/SSE based MCP servers."),
        port: z.number().optional().describe("Required for 'start' if transportType is 'http'. The port number the server is listening on.")
      }).strict(),
    },
    async ({ action, sessionId, command, args, env, transportType, port }) => {
      if (action === "start") {
        if (!sessionId || !command || !args) {
          return { content: [{ type: "text", text: "Error: 'sessionId', 'command', and 'args' are required to start a session." }], isError: true };
        }
        
        // Auto-detect transportType and port if possible
        let effectiveTransport = transportType || "stdio";
        let effectivePort = port;

        // Heuristic: If model forgot transportType but provided port
        if (!transportType && port) {
           effectiveTransport = "http";
        }
        
        // Heuristic: If starting staff-mcp with --transport http but forgot parameters
        if (!transportType && !port && args.includes("--transport") && (args.includes("http") || args.includes("sse"))) {
            effectiveTransport = "http";
            const portIdx = args.indexOf("-p") > -1 ? args.indexOf("-p") : args.indexOf("--port");
            if (portIdx > -1) {
                effectivePort = parseInt(args[portIdx + 1], 10);
            } else {
                effectivePort = 3000;
            }
        }
        if (sessions.has(sessionId)) {
          const existing = sessions.get(sessionId)!;
          return {
            content: [{ type: "text", text: `Session '${sessionId}' already exists with status '${existing.status}'. Please use a different ID or stop it first.` }],
            isError: true
          };
        }

        if (sessions.size >= options.maxSessions) {
          const activeSessions = Array.from(sessions.entries()).map(([id, s]) => 
            `- [${id}] (Command: ${s.command} ${s.args.join(" ")}) - Status: ${s.status}`
          ).join("\n");
          
          return {
            content: [{
              type: "text", 
              text: `Error: Maximum active MCP session limit (${options.maxSessions}) reached.\n` +
                    `Please use the 'stop' action to close an unused session before starting a new one.\n\n` +
                    `Current active sessions:\n${activeSessions}`
            }],
            isError: true
          };
        }

        if (effectiveTransport === "http" && !effectivePort) {
          return { content: [{ type: "text", text: `port is required when transportType is 'http'` }], isError: true };
        }

        const session: McpSession = {
          sessionId, command, args, process: null,
          client: new Client({ name: "staff-mcp-proxy", version: STAFF_MCP_VERSION }, { capabilities: {} }),
          transport: null, status: "starting", startedAt: new Date(),
          startController: new AbortController(),
        };
        // Reserve both the ID and quota before spawning or yielding, for every transport.
        sessions.set(sessionId, session);
        watchClientClose(session);

        try {
          const mergedEnv = { ...process.env, ...env } as Record<string, string>;
          if (effectiveTransport === "http") {
            const child = spawn(command, args, { stdio: "ignore", detached: true, env: mergedEnv });
            session.process = child;
            child.unref();
            child.once("error", (err) => {
              if (sessions.get(sessionId) !== session || session.startController.signal.aborted) return;
              session.status = "error";
              session.error = `HTTP process failed: ${err.message}`;
              session.startController.abort(err);
            });
            child.once("exit", (code, signal) => {
              if (sessions.get(sessionId) !== session || session.startController.signal.aborted) return;
              session.status = "exited";
              session.error = `HTTP process exited (code: ${code}, signal: ${signal}).`;
              session.startController.abort(new Error(session.error));
              // Do not let the HTTP client reconnect after its owned child exits.
              void closeSessionConnection(session).then((errors) => {
                if (sessions.get(sessionId) === session && errors.length > 0) {
                  session.status = "error";
                  session.error += ` ${errors.join("; ")}`;
                }
              });
            });

            await delay(3000, undefined, { signal: session.startController.signal });
            assertStarting(session);
            session.transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${effectivePort}/mcp`));
            try {
              await connectSession(session);
            } catch (err) {
              assertStarting(session);
              const errors = await closeSessionConnection(session);
              assertStarting(session);
              if (errors.length > 0) throw new Error(errors.join("; "));
              // Use a fresh client: callbacks from a failed HTTP candidate must not close the SSE connection.
              session.client = new Client({ name: "staff-mcp-proxy", version: STAFF_MCP_VERSION }, { capabilities: {} });
              watchClientClose(session);
              session.transport = new SSEClientTransport(new URL(`http://127.0.0.1:${effectivePort}/sse`));
              try {
                await connectSession(session);
              } catch (sseError) {
                throw new Error(`Failed to connect using 'http' transport (tried streamable-http and sse on port ${effectivePort}): ${String(sseError)} (streamable-http: ${String(err)})`);
              }
            }
          } else {
            session.transport = new StdioClientTransport({ command, args, env: mergedEnv });
            await connectSession(session);
          }

          assertStarting(session);
          if (!session.client.transport) throw new Error("MCP connection closed during startup.");
          session.status = "ready";
          const via = effectiveTransport === "http" ? "http transport" : "stdio";
          return { content: [{ type: "text", text: `Successfully started and connected to MCP session '${sessionId}' via ${via}. (Active sessions: ${sessions.size}/${options.maxSessions})\nUse 'explore_mcp_session' to discover available tools.` }] };
        } catch (err) {
          const failure = session.error || String(err);
          session.startController.abort(err);
          // Finish any in-flight stop cleanup before reporting the failed start.
          // connectSession also cleans up if the underlying connect settles later.
          const previousErrors = session.cleanup ? await session.cleanup : [];
          const errors = [...previousErrors, ...(await cleanupSession(session))];
          if (sessions.get(sessionId) === session) {
            if (errors.length > 0) {
              session.status = "error";
              session.error = `${failure}; ${errors.join("; ")}`;
            } else {
              sessions.delete(sessionId);
            }
          }
          return { content: [{ type: "text", text: `Failed to start MCP session '${sessionId}': ${failure}${errors.length > 0 ? `; ${errors.join("; ")}` : ""}` }], isError: true };
        }
      } else if (action === "stop") {
        if (!sessionId) {
          return { content: [{ type: "text", text: "Error: 'sessionId' is required to stop a session." }], isError: true };
        }
        const session = sessions.get(sessionId);
        if (!session) {
          return { content: [{ type: "text", text: `Session '${sessionId}' not found.` }] };
        }
        session.status = "stopping";
        session.startController.abort(new Error(`MCP session '${sessionId}' was stopped.`));
        const errors = await cleanupSession(session);
        if (sessions.get(sessionId) === session) {
          if (errors.length > 0) {
            session.status = "error";
            session.error = errors.join("; ");
          } else {
            sessions.delete(sessionId);
          }
        }
        if (errors.length > 0) {
          return { content: [{ type: "text", text: `Failed to fully stop MCP session '${sessionId}': ${errors.join("; ")}. Session retained for cleanup retry.` }], isError: true };
        }
        return { content: [{ type: "text", text: `Session '${sessionId}' successfully stopped. (Active sessions: ${sessions.size}/${options.maxSessions})` }] };
      } else if (action === "list") {
        if (sessions.size === 0) {
          return { content: [{ type: "text", text: `No active MCP sessions. (Active sessions: 0/${options.maxSessions})` }] };
        }
        let output = `Active MCP Sessions (${sessions.size}/${options.maxSessions}):\n`;
        for (const [id, session] of sessions.entries()) {
          output += `- [${id}] Status: ${session.status}, Command: ${session.command} ${session.args.join(" ")}${session.error ? `, Error: ${session.error}` : ""}\n`;
        }
        return { content: [{ type: "text", text: output }] };
      }
      return { content: [{ type: "text", text: `Invalid action: ${action}` }], isError: true };
    }
  );

  // 2. explore_mcp_session
  server.registerTool(
    "explore_mcp_session",
    {
      description: "Explores the available tools exposed by a running MCP session. If toolName is provided, returns detailed schema for that tool.",
      inputSchema: z.object({
        sessionId: z.string().describe("The session ID to explore"),
        toolName: z.string().optional().describe("Optional. The specific tool name to get detailed argument schema for"),
      }).strict(),
    },
    async ({ sessionId, toolName }, extra) => {
      try {
        const session = getReadySession(sessionId);
        
        // Fetch every page before displaying or searching the current tools.
        const tools = await listAllTools(session.client, extra?.signal);

        if (toolName) {
          // --- Detailed view: full schema for ONE specific tool ---
          const tool = tools.find((t) => t.name === toolName);
          if (!tool) {
            let output = `Tool '${toolName}' not found in session '${sessionId}'.\nAvailable Tools (${tools.length} total):\n`;
            if (tools.length === 0) {
              output += "No available tools.\n";
            }
            for (const availableTool of tools) {
              output += `\n[${availableTool.name}]\n${availableTool.description ?? "N/A"}\n`;
            }
            output += `\nTip: Use explore_mcp_session with "toolName" to inspect a specific tool's full schema.`;
            return {
              content: [{ type: "text", text: output }],
              isError: true
            };
          }

          let output = `Tool: ${tool.name}\nDescription: ${tool.description || "N/A"}\n\nArguments Schema (JSON Schema):\n`;
          output += JSON.stringify(tool.inputSchema, null, 2);
          return { content: [{ type: "text", text: output }] };
          
        } else {
          // --- Lightweight overview: ALL tools listed compactly ---
          let output = `Session: ${sessionId}\n`;
          
          // Server identity
          const serverVersion = session.client.getServerVersion();
          if (serverVersion) {
            output += `Server: ${serverVersion.name} v${serverVersion.version}\n`;
          }
          const caps = session.client.getServerCapabilities();
          if (caps) {
            const capNames = Object.keys(caps).filter(k => caps[k as keyof typeof caps]);
            if (capNames.length > 0) {
              output += `Capabilities: ${capNames.join(", ")}\n`;
            }
          }
          output += "\n";
          
          // Server instructions (important context from the MCP server itself)
          try {
            const instructions = await session.client.getInstructions();
            if (instructions) {
              output += `[Server Instructions]\n${instructions}\n\n`;
            }
          } catch (e) {
            // Some MCP servers don't implement getInstructions, skip silently
          }
          
          // List ALL tools with compact info (NO full schemas - those are expensive)
          output += `Available Tools (${tools.length} total):\n`;
          for (const t of tools) {
            const props = t.inputSchema?.properties;
            const argCount = props ? Object.keys(props).length : 0;
            const required = t.inputSchema?.required || [];
            
            output += `\n  [${t.name}]`;
            if (t.description) {
              output += `\n    ${t.description.split('\n')[0]}`;
            }
            if (argCount > 0) {
              output += `\n    Args: ${argCount} parameter(s)`;
              if (required.length > 0) {
                output += ` [required: ${required.join(", ")}]`;
              }
            } else {
              output += `\n    Args: none`;
            }
          }
          
          output += `\n💡 Tip: Use explore_mcp_session with "toolName" to inspect a specific tool's full schema before calling it.`;
          return { content: [{ type: "text", text: output }] };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to explore session: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 5. call_mcp_session_tool
  server.registerTool(
    "call_mcp_session_tool",
    {
      description: "Calls a specific tool on a running MCP session with the required JSON parameters.",
      inputSchema: z.object({
        sessionId: z.string().describe("The session ID"),
        method: z.string().describe("The tool name to call (e.g., 'search_code')"),
        params: z.string().optional().describe("A JSON-encoded string containing the arguments for the tool (e.g., '{\"query\": \"secret\"}')"),
      }).strict(),
    },
    async ({ sessionId, method, params }, extra) => {
      try {
        const session = getReadySession(sessionId);

        // Validate against the complete list, including tools on later pages.
        const tools = await listAllTools(session.client, extra?.signal);
        const tool = tools.find(t => t.name === method);
        
        if (!tool) {
          const availableTools = tools.map(t => t.name).join(", ");
          return {
            content: [{ type: "text", text: `Tool '${method}' not found in session '${sessionId}'. Available tools: ${availableTools}` }],
            isError: true
          };
        }

        let parsedParams = {};
        try {
          if (params && params.trim() !== "") {
            parsedParams = JSON.parse(params);
          }
        } catch (e: any) {
          return {
            content: [{ type: "text", text: `Failed to parse params JSON: ${e.message}\n\nPlease check the required parameters for this tool. Here is the tool schema:\n${JSON.stringify(tool.inputSchema, null, 2)}` }],
            isError: true
          };
        }

        try {
          const result = await session.client.callTool({
            name: method,
            arguments: parsedParams,
          }, undefined, {
            timeout: 3600000, // 1 hour, aligned with the chat-ai MCP client. Nested long-running
            // tools manage their own lifecycle; a short cap here orphans their work.
            signal: extra?.signal, // propagate caller cancellation (e.g. user stop) to the nested call
          });

          // Process and return result
          let isErrorResult = false;
          let contentArray: Array<{type: "text", text: string}> = [];
          
          if (result && Array.isArray(result.content)) {
              contentArray = result.content.map((c: any) => {
                  if (c.type === "text" && "text" in c) {
                      return { type: "text" as const, text: String(c.text) };
                  } else {
                      return { type: "text" as const, text: `[${c.type} content omitted or unsupported]` };
                  }
              });
          }
          
          if (result && (result as any).isError) {
              isErrorResult = true;
              // If it's an error (likely validation or execution), append the schema to help the model correct itself
              contentArray.push({
                type: "text",
                text: `\n\nTool '${method}' execution failed. Please check the required parameters for this tool. Here is the tool schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`
              });
          }

          return { content: contentArray, isError: isErrorResult };
        } catch (callError: any) {
           // Provide detailed error with schema
           const errorMessage = `Failed to call tool '${method}': ${callError.message}\n\nPlease check the required parameters for this tool. Here is the tool schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`;
           return {
             content: [{ type: "text", text: errorMessage }],
             isError: true
           };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `MCP Session Error: ${err.message}` }],
          isError: true
        };
      }
    }
  );
}
