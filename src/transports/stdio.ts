import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function startStdioServer(server: McpServer) {
  const transport = new StdioServerTransport();

  // Redirect stdout to stderr so console.log doesn't break protocol
  const originalLog = console.log;
  console.log = (...args) => {
    console.error(...args);
  };

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
