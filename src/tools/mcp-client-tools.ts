import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn, ChildProcess } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface McpSession {
  sessionId: string;
  command: string;
  args: string[];
  process: ChildProcess | null;
  client: Client;
  transport: any;
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
    throw new Error(`MCP Session '${sessionId}' not found. Please use 'list_mcp_sessions' to check active sessions or start it first.`);
  }
  if (session.status !== "ready") {
    throw new Error(`MCP Session '${sessionId}' is not in ready state. Current status: ${session.status}. It might have failed to start or crashed. Check logs if necessary.`);
  }
  return session;
}

export function registerMcpClientTools(server: McpServer): void {
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
        transportType: z.enum(["stdio", "sse", "streamable-http"]).optional().describe("Optional for 'start'. Transport type, default is stdio."),
        sseUrl: z.string().optional().describe("Required for 'start' if transportType is 'sse' or 'streamable-http'.")
      }).strict(),
    },
    async ({ action, sessionId, command, args, transportType = "stdio", sseUrl }) => {
      if (action === "start") {
        if (!sessionId || !command || !args) {
          return { content: [{ type: "text", text: "Error: 'sessionId', 'command', and 'args' are required to start a session." }], isError: true };
        }
        if (sessions.has(sessionId)) {
          const existing = sessions.get(sessionId)!;
          return {
            content: [{ type: "text", text: `Session '${sessionId}' already exists with status '${existing.status}'. Please use a different ID or stop it first.` }],
            isError: true
          };
        }

        try {
          const client = new Client({ name: "staff-mcp-proxy", version: "1.0.0" }, { capabilities: {} });
          let transport: any;
          let sessionProcess: ChildProcess | null = null;

          if (transportType === "sse" || transportType === "streamable-http") {
              if (!sseUrl) {
                  return { content: [{ type: "text", text: `sseUrl is required when transportType is '${transportType}'` }], isError: true };
              }
              sessionProcess = spawn(command, args, { stdio: 'ignore', detached: true });
              sessionProcess.unref();
              await new Promise(resolve => setTimeout(resolve, 3000));
              
              if (transportType === "sse") {
                  transport = new SSEClientTransport(new URL(sseUrl));
              } else {
                  transport = new StreamableHTTPClientTransport(new URL(sseUrl));
              }
          } else {
              transport = new StdioClientTransport({ command, args });
          }

          sessions.set(sessionId, {
            sessionId, command, args, process: sessionProcess, client, transport,
            status: "starting", startedAt: new Date()
          });

          await client.connect(transport);
          sessions.get(sessionId)!.status = "ready";

          return { content: [{ type: "text", text: `Successfully started and connected to MCP session '${sessionId}'. Use 'explore_mcp_session' to discover available tools.` }] };
        } catch (err: any) {
          sessions.delete(sessionId);
          return { content: [{ type: "text", text: `Failed to start MCP session '${sessionId}': ${err.message}` }], isError: true };
        }
      } else if (action === "stop") {
        if (!sessionId) {
          return { content: [{ type: "text", text: "Error: 'sessionId' is required to stop a session." }], isError: true };
        }
        const session = sessions.get(sessionId);
        if (!session) {
          return { content: [{ type: "text", text: `Session '${sessionId}' not found.` }] };
        }
        try {
          await session.client.close();
          if (session.process && session.process.pid) {
             try { process.kill(session.process.pid, 'SIGKILL'); } catch(e) {}
          }
        } catch (e) {} finally {
          sessions.delete(sessionId);
        }
        return { content: [{ type: "text", text: `Session '${sessionId}' successfully stopped.` }] };
      } else if (action === "list") {
        if (sessions.size === 0) {
          return { content: [{ type: "text", text: "No active MCP sessions." }] };
        }
        let output = "Active MCP Sessions:\n";
        for (const [id, session] of sessions.entries()) {
          output += `- [${id}] Status: ${session.status}, Command: ${session.command} ${session.args.join(" ")}\n`;
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
    async ({ sessionId, toolName }) => {
      try {
        const session = getReadySession(sessionId);
        
        // Fetch tools list first (always needed)
        const toolsResult = await session.client.listTools();

        if (toolName) {
          // --- Detailed view: full schema for ONE specific tool ---
          const tool = toolsResult.tools.find((t) => t.name === toolName);
          if (!tool) {
            return {
              content: [{ type: "text", text: `Tool '${toolName}' not found in session '${sessionId}'. Available tools: ${toolsResult.tools.map(t => t.name).join(", ")}` }],
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
          output += `Available Tools (${toolsResult.tools.length} total):\n`;
          for (const t of toolsResult.tools) {
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
          
          // Prompts (if server provides them)
          try {
            const promptsResult = await session.client.listPrompts();
            if (promptsResult?.prompts?.length > 0) {
              output += `\n\nAvailable Prompts (${promptsResult.prompts.length} total):\n`;
              for (const p of promptsResult.prompts) {
                output += `  [${p.name}] ${p.description || ""}\n`;
              }
            }
          } catch (e) {
            // MCP server may not support prompts
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
    async ({ sessionId, method, params }) => {
      try {
        const session = getReadySession(sessionId);

        // Pre-fetch tools to validate the tool exists and fetch its schema
        const toolsResult = await session.client.listTools();
        const tool = toolsResult.tools.find(t => t.name === method);
        
        if (!tool) {
          const availableTools = toolsResult.tools.map(t => t.name).join(", ");
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
