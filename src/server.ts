import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SecurityManager } from "./security.js";
import { registerFileTools } from "./tools/file-tools.js";
import { registerShellTools } from "./tools/shell-tools.js";
import { registerLspTools } from "./tools/lsp-tools.js";
import { registerSkillTools } from "./tools/skills.js";
import { registerMcpClientTools } from "./tools/mcp-client-tools.js";
import { getMcpInstructions } from "./tools/system-tools.js";
import * as path from "node:path";
import { FileCore, CHUNK_LIMIT } from "./file-manager/file-core.js";
import { FILE_MANAGER, FILE_MANAGER_CAPABILITY, registerFileManager } from "./file-manager/extension.js";
import { wrapFileManagerTransport } from "./file-manager/transport.js";
import { installFteTransportLifecycle } from "./transports/fte-lifecycle.js";

/**
 * Creates and initializes a new McpServer with all functional tools.
 * @param name The server's identification name.
 * @param version The server's version.
 * @param workingDir The working directory for the server.
 * @param allowedDirs Additional directories for the SecurityManager.
 * @param profile The active profile for skills and instructions.
 * @param maxMcpSessions Maximum concurrent MCP sessions allowed.
 * @param enableLsp Whether to enable LSP tools.
 * @returns An initialized McpServer instance.
 */
export function createServerFactory(
  name: string, 
  version: string, 
  workingDir: string, 
  allowedDirs: string[], 
  profile: string = "default", 
  maxMcpSessions: number = 5,
  enableLsp: boolean = false
): () => McpServer {
  const security = new SecurityManager(workingDir, allowedDirs);
  const sandbox = security.getAllowedDirs();
  const runtimeDirectory = path.join(security.getWorkingDir(), ".staff", "file-manager");
  // Shared across all sessions from this factory, including ordinary tool writes.
  const core = new FileCore(sandbox.map((directory, index) => ({
    rootId: index === 0 ? "main" : `allowed-${index}`,
    name: index === 0 ? "Workspace" : path.basename(directory) || directory,
    readOnly: false,
    directory,
  })), runtimeDirectory);

  // Generate instructions with system-specific details (OS, shell, etc.)
  const instructions = getMcpInstructions(workingDir, security, { enableLsp });

  return () => {
    const server = new McpServer(
      {
        name,
        version,
      },
      {
        // Pass the instruction string to the initialize response
        instructions,
        // Advertise FTE capabilities
        capabilities: {
          resources: { subscribe: true },
          experimental: {
            [FILE_MANAGER]: FILE_MANAGER_CAPABILITY,
            "cc.qqxing/file-transfer": {
              supported_schemes: ["file", "staff-transfer"],
              max_chunk_size: CHUNK_LIMIT,
            },
          },
        },
      }
    );

    // Register all functional tool modules
    registerFileTools(server, security, core);
    registerShellTools(server, security);
    
    if (enableLsp) {
      registerLspTools(server, security);
    }
    
    registerSkillTools(server, workingDir, security, profile);
    registerMcpClientTools(server, { maxSessions: maxMcpSessions });

    // Intercept connect to wrap transport with FTE server-side processing
    // while ensuring each reconnect also disposes the previous FTE wrapper.
    const createFileSession = registerFileManager(server, core, path.join(runtimeDirectory, "transfers"));
    installFteTransportLifecycle(server, sandbox, (transport, config) =>
      wrapFileManagerTransport(transport, config, createFileSession())
    );

    return server;
  };
}
