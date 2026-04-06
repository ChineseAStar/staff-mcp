import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SecurityManager } from "./security.js";
import { registerFileTools } from "./tools/file-tools.js";
import { registerShellTools } from "./tools/shell-tools.js";
import { registerLspTools } from "./tools/lsp-tools.js";

/**
 * Creates and initializes a new McpServer with all tools.
 * @param name The server's identification name.
 * @param version The server's version.
 * @param workingDir The working directory for the server.
 * @param allowedDirs Additional directories for the SecurityManager.
 * @returns An initialized McpServer instance.
 */
export function createServer(name: string, version: string, workingDir: string, allowedDirs: string[]): McpServer {
  const server = new McpServer({
    name,
    version,
  });

  const security = new SecurityManager(workingDir, allowedDirs);

  // Register all tool modules
  registerFileTools(server, security);
  registerShellTools(server, security);
  registerLspTools(server, security);

  return server;
}
