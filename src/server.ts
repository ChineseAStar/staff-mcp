import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SecurityManager } from "./security.js";
import { registerFileTools } from "./tools/file-tools.js";
import { registerShellTools } from "./tools/shell-tools.js";
import { registerLspTools } from "./tools/lsp-tools.js";
import { registerSkillTools } from "./tools/skills.js";
import { getMcpInstructions } from "./tools/system-tools.js";

/**
 * Creates and initializes a new McpServer with all functional tools.
 * @param name The server's identification name.
 * @param version The server's version.
 * @param workingDir The working directory for the server.
 * @param allowedDirs Additional directories for the SecurityManager.
 * @param profile The active persona/role profile.
 * @returns An initialized McpServer instance.
 */
export function createServer(name: string, version: string, workingDir: string, allowedDirs: string[], profile: string = "default"): McpServer {
  const security = new SecurityManager(workingDir, allowedDirs);

  // Generate instructions with system-specific details (OS, shell, etc.)
  const instructions = getMcpInstructions(workingDir, security);

  const server = new McpServer(
    {
      name,
      version,
    },
    {
      // Pass the instruction string to the initialize response
      instructions,
    }
  );

  // Register all functional tool modules
  registerFileTools(server, security);
  registerShellTools(server, security);
  registerLspTools(server, security);
  registerSkillTools(server, workingDir, security, profile);

  return server;
}
