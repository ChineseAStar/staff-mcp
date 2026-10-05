import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function redirectStdioLogsToStderr(): void {
  // MCP stdio reserves stdout for JSON-RPC frames. Redirect ordinary
  // console.log output before bootstrap code can write to stdout.
  console.log = (...args) => {
    console.error(...args);
  };
}

export async function startStdioServer(server: McpServer) {
  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
    console.error("MCP Server (Stdio) is running.");

    // The SDK's StdioServerTransport only listens for 'data'/'error' on stdin
    // and never notices EOF. When the client goes away, stdin closes — shut
    // down instead of lingering as an orphan held up by long-lived handles
    // (LSP servers, intervals, background tasks). The process 'exit' hook
    // registered by the shell tools also cleans up any background task groups.
    const onStdinClosed = () => {
      console.error("[staff-mcp] stdin closed (client disconnected), shutting down.");
      process.exit(0);
    };
    process.stdin.on("end", onStdinClosed);
    process.stdin.on("close", onStdinClosed);
  } catch (error) {
    console.error("Stdio connection failed:", error);
    process.exit(1);
  }
}
