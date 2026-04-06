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
  } catch (error) {
    console.error("Stdio connection failed:", error);
    process.exit(1);
  }
}
