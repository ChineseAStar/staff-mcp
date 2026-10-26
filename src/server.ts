import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SecurityManager } from './security.js';
import { registerFileTools } from './tools/file-tools.js';
import { registerShellTools } from './tools/shell-tools.js';
import { registerLspTools } from './tools/lsp-tools.js';
import { registerSkillTools } from './tools/skills.js';
import { registerMcpClientTools } from './tools/mcp-client-tools.js';
import { getMcpInstructions } from './tools/system-tools.js';
import * as path from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';
import { FileCore } from './file-manager/file-core.js';
import { EXTENSIONS, manifest } from './extensions/protocol.js';
import { installExtensions } from './extensions/runtime.js';
import { installRequestActivity } from './utils/server-activity.js';
import { loadTerminalRuntime } from './terminal/pty.js';
import { registerFileResources } from './file-manager/extension.js';
import { readAppResource } from './extensions/apps.js';
import { resolveExtensionOptions } from './extensions/config.js';
import type { ExtensionOptions } from './extensions/config.js';
export type { ExtensionOptions } from './extensions/config.js';

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
    privateDirectoryAliases: string[] = [],
): () => McpServer {
    const options = resolveExtensionOptions(extensions, workingDir);
    const security = new SecurityManager(workingDir, allowedDirs);
    const sandbox = security.getAllowedDirs();
    const runtimeDirectory = path.join(
        security.getWorkingDir(),
        '.staff',
        'file-manager',
    );
    // Shared across all sessions from this factory, including ordinary tool writes.
    const standardCore = new FileCore(
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
        undefined,
        privateDirectoryAliases,
    );

    // Generate instructions with system-specific details (OS, shell, etc.)
    const instructions = getMcpInstructions(workingDir, security, {
        enableLsp,
    });

    let filesCore: FileCore | undefined;
    if (options.enabled.includes('files')) {
        let rootsAvailable = true;
        for (const root of options.fileRoots) {
            try {
                if (!statSync(root.directory).isDirectory()) {
                    console.error(
                        `[staff-mcp] Warning: Files extension unavailable: root "${root.rootId}" is not a directory.`,
                    );
                    rootsAvailable = false;
                    break;
                }
                accessSync(root.directory, constants.R_OK | constants.X_OK);
            } catch (error) {
                // Only optional root I/O is recoverable. Parameter validation and
                // required standardCore construction stay outside this boundary.
                const code = (error as NodeJS.ErrnoException)?.code;
                if (!code) throw error;
                console.error(
                    `[staff-mcp] Warning: Files extension unavailable: root "${root.rootId}" cannot be accessed (${code}).`,
                );
                rootsAvailable = false;
                break;
            }
        }
        if (rootsAvailable)
            filesCore = new FileCore(
                options.fileRoots.map((root) => ({
                    ...root,
                    name: root.rootId === 'main' ? 'Workspace' : root.rootId,
                    readOnly: false,
                })),
                runtimeDirectory,
                standardCore,
            );
    }
    const terminalRuntime = options.enabled.includes('terminal')
        ? loadTerminalRuntime(true, options.shell)
        : undefined;
    const features = { files: !!filesCore, terminal: !!terminalRuntime };

    return () => {
        const discovery = manifest(features);
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
                    ...(features.files || features.terminal
                        ? { experimental: { [EXTENSIONS]: discovery } }
                        : {}),
                },
            },
        );

        installRequestActivity(server);

        // Register all functional tool modules
        registerFileTools(server, security, standardCore);
        registerShellTools(server, security);

        if (enableLsp) {
            registerLspTools(server, security);
        }

        registerSkillTools(server, workingDir, security, profile);
        registerMcpClientTools(server, { maxSessions: maxMcpSessions });

        const requireExtension =
            features.files || features.terminal
                ? installExtensions(
                      server,
                      filesCore,
                      path.join(runtimeDirectory, 'transfers'),
                      standardCore,
                      terminalRuntime,
                  )
                : undefined;
        registerFileResources(
            server,
            filesCore ?? standardCore,
            requireExtension
                ? (uri) =>
                      readAppResource(uri, requireExtension, features.terminal)
                : undefined,
        );

        return server;
    };
}
