import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn, ChildProcess } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface McpSession {
  sessionId: string;
  command: string;
  args: string[];
  process: ChildProcess;
  client: Client;
  transport: StdioClientTransport;
  status: "starting" | "ready" | "error" | "exited";
  startedAt: Date;
  error?: string;
}

const sessions = new Map<string, McpSession>();

/**
 * Ensures a session exists and is ready
 */
function getReadySession(sessionId: string): McpSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`MCP Session '${sessionId}' not found.`);
  }
  if (session.status !== "ready") {
    throw new Error(`MCP Session '${sessionId}' is not ready. Current status: ${session.status}`);
  }
  return session;
}

export function registerMcpClientTools(server: McpServer): void {
  // 1. start_mcp_session
  server.tool(
    "start_mcp_session",
    "Starts a background Model Context Protocol (MCP) server process using the provided command and arguments. Returns a unique sessionId.",
    {
      sessionId: z.string().describe("A unique identifier you choose for this session (e.g. 'jadx_1')"),
      command: z.string().describe("The executable command to run the server (e.g. 'npx', 'uv', 'java')"),
      args: z.array(z.string()).describe("Arguments to pass to the command"),
    },
    async ({ sessionId, command, args }) => {
      if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId)!;
        return {
          content: [
            { type: "text", text: `Session '${sessionId}' already exists with status '${existing.status}'. Please use a different ID or stop it first.` }
          ],
          isError: true
        };
      }

      try {
        const transport = new StdioClientTransport({ command, args });
        const client = new Client(
          { name: "staff-mcp-proxy", version: "1.0.0" },
          { capabilities: {} }
        );

        const sessionProcess = spawn(command, args, {
          // StdioClientTransport handles stdio automatically, but we need the process reference for lifecycle
          // Wait, StdioClientTransport internalizes the process spawning. 
          // We can't directly grab the ChildProcess from StdioClientTransport easily without hacking its internals.
          // However, we CAN just rely on the transport to manage the process!
        });
        // We will just let StdioClientTransport handle the spawn, so we don't need `spawn` manually.
        // Let's refine this below.
        
        // Actually, StdioClientTransport takes { command, args } and spawns it internally on `connect()`.
        
        sessions.set(sessionId, {
          sessionId,
          command,
          args,
          process: null as any, // We won't track the raw process, transport does it
          client,
          transport,
          status: "starting",
          startedAt: new Date()
        });

        await client.connect(transport);
        
        const session = sessions.get(sessionId)!;
        session.status = "ready";

        return {
          content: [
            { type: "text", text: `Successfully started and connected to MCP session '${sessionId}'. Use 'explore_mcp_session' to discover available tools.` }
          ]
        };
      } catch (err: any) {
        sessions.delete(sessionId);
        return {
          content: [{ type: "text", text: `Failed to start MCP session '${sessionId}': ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 2. stop_mcp_session
  server.tool(
    "stop_mcp_session",
    "Stops a running MCP session and releases its resources.",
    {
      sessionId: z.string().describe("The unique identifier of the session to stop"),
    },
    async ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return {
          content: [{ type: "text", text: `Session '${sessionId}' not found.` }]
        };
      }

      try {
        await session.client.close();
        // transport.close() is usually called by client.close() or handles process killing
      } catch (e) {
        // ignore close errors
      } finally {
        sessions.delete(sessionId);
      }

      return {
        content: [{ type: "text", text: `Session '${sessionId}' successfully stopped.` }]
      };
    }
  );

  // 3. list_mcp_sessions
  server.tool(
    "list_mcp_sessions",
    "Lists all currently active MCP sessions managed by this proxy.",
    {},
    async () => {
      if (sessions.size === 0) {
        return { content: [{ type: "text", text: "No active MCP sessions." }] };
      }

      let output = "Active MCP Sessions:\n";
      for (const [id, session] of sessions.entries()) {
        output += `- [${id}] Status: ${session.status}, Command: ${session.command} ${session.args.join(" ")}\n`;
      }

      return { content: [{ type: "text", text: output }] };
    }
  );

  // 4. explore_mcp_session
  server.tool(
    "explore_mcp_session",
    "Explores the available tools exposed by a running MCP session. If toolName is provided, returns detailed schema for that tool.",
    {
      sessionId: z.string().describe("The session ID to explore"),
      toolName: z.string().optional().describe("Optional. The specific tool name to get detailed argument schema for"),
    },
    async ({ sessionId, toolName }) => {
      try {
        const session = getReadySession(sessionId);
        const toolsResult = await session.client.listTools();

        if (toolName) {
          const tool = toolsResult.tools.find((t) => t.name === toolName);
          if (!tool) {
            return {
              content: [{ type: "text", text: `Tool '${toolName}' not found in session '${sessionId}'.` }],
              isError: true
            };
          }

          let output = `Tool: ${tool.name}\nDescription: ${tool.description || "N/A"}\n\nArguments Schema (JSON Schema):\n`;
          output += JSON.stringify(tool.inputSchema, null, 2);
          return { content: [{ type: "text", text: output }] };
        } else {
          let output = `Available tools for session '${sessionId}':\n`;
          toolsResult.tools.forEach((t) => {
            output += `- ${t.name}: ${t.description || "No description"}\n`;
          });
          output += `\nTo see detailed arguments for a specific tool, call explore_mcp_session again with the 'toolName' parameter.`;
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
  server.tool(
    "call_mcp_session_tool",
    "Calls a specific tool on a running MCP session with the required JSON parameters.",
    {
      sessionId: z.string().describe("The session ID"),
      method: z.string().describe("The tool name to call (e.g., 'search_code')"),
      params: z.string().describe("A JSON-encoded string containing the arguments for the tool (e.g., '{\"query\": \"secret\"}')"),
    },
    async ({ sessionId, method, params }) => {
      try {
        const session = getReadySession(sessionId);
        let parsedParams = {};
        if (params && params.trim() !== "") {
          parsedParams = JSON.parse(params);
        }

        const result = await session.client.callTool({
          name: method,
          arguments: parsedParams,
        });

        // We can just pass it directly back since we are also an MCP server!
        // But we need to ensure the format matches what our server expects to return.
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
        }

        return { content: contentArray, isError: isErrorResult };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to call tool '${method}': ${err.message}` }],
          isError: true
        };
      }
    }
  );
}