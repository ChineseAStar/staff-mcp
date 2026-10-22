import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SecurityManager } from './security.js';
import { registerFileTools } from './tools/file-tools.js';
import { registerShellTools } from './tools/shell-tools.js';
import { registerLspTools } from './tools/lsp-tools.js';
import { registerSkillTools } from './tools/skills.js';
import { registerMcpClientTools } from './tools/mcp-client-tools.js';
import { getMcpInstructions } from './tools/system-tools.js';
import * as path from 'node:path';
import { FileCore } from './file-manager/file-core.js';
import { EXTENSIONS, manifest } from './extensions/protocol.js';
import { installExtensions } from './extensions/runtime.js';
import { loadTerminalRuntime } from './terminal/pty.js';

export interface ExtensionOptions {
    terminal?: boolean;
    terminalShell?: string;
}

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
    profile: string = 'default',
    maxMcpSessions: number = 5,
    enableLsp: boolean = false,
    extensions: ExtensionOptions = {},
): () => McpServer {
    const security = new SecurityManager(workingDir, allowedDirs);
    const sandbox = security.getAllowedDirs();
    const runtimeDirectory = path.join(
        security.getWorkingDir(),
        '.staff',
        'file-manager',
    );
    // Shared across all sessions from this factory, including ordinary tool writes.
    const core = new FileCore(
        sandbox.map((directory, index) => ({
            rootId: index === 0 ? 'main' : `allowed-${index}`,
            name:
                index === 0
                    ? 'Workspace'
                    : path.basename(directory) || directory,
            readOnly: false,
            directory,
        })),
        runtimeDirectory,
    );

    // Generate instructions with system-specific details (OS, shell, etc.)
    const instructions = getMcpInstructions(workingDir, security, {
        enableLsp,
    });

    const terminalRuntime = loadTerminalRuntime(
        extensions.terminal === true,
        extensions.terminalShell,
    );

    return () => {
        const discovery = manifest(false);
        const server = new McpServer(
            {
                name,
                version,
            },
            {
                // Pass the instruction string to the initialize response
                instructions,
                capabilities: {
                    resources: { subscribe: true },
                    experimental: {
                        [EXTENSIONS]: discovery,
                    },
                },
            },
        );

        // Register all functional tool modules
        registerFileTools(server, security, core);
        registerShellTools(server, security);

        if (enableLsp) {
            registerLspTools(server, security);
        }

        registerSkillTools(server, workingDir, security, profile);
        registerMcpClientTools(server, { maxSessions: maxMcpSessions });

        installExtensions(
            server,
            core,
            path.join(runtimeDirectory, 'transfers'),
            discovery,
            terminalRuntime,
        );

        return server;
    };
}
