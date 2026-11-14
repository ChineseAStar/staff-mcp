import { McpServer } from '@modelcontextprotocol/server';
import type {
    McpRequestContext,
    ServerNotifier,
} from '@modelcontextprotocol/server';
import { SecurityManager } from './security.js';
import { registerFileTools } from './tools/file-tools.js';
import { registerShellTools } from './tools/shell-tools.js';
import { registerLspTools } from './tools/lsp-tools.js';
import { registerSkillTools, watchProjectSkills } from './tools/skills.js';
import { registerMcpClientTools } from './tools/mcp-client-tools.js';
import { getMcpInstructions } from './tools/system-tools.js';
import * as path from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';
import { FileCore } from './file-manager/file-core.js';
import { EXTENSIONS, manifest } from './extensions/protocol.js';
import { installExtensions } from './extensions/runtime.js';
import type { HttpDataBindings } from './extensions/HttpDataBindings.js';
import { loadTerminalRuntime } from './terminal/pty.js';
import { TerminalStore } from './terminal/store.js';
import {
    registerFileResources,
    subscribeFileResourceUpdates,
    validateFileResourceSubscription,
} from './file-manager/extension.js';
import { readAppResource } from './extensions/apps.js';
import { resolveExtensionOptions } from './extensions/config.js';
import type { ExtensionOptions } from './extensions/config.js';
export type { ExtensionOptions } from './extensions/config.js';

export interface ServerFactoryContext extends McpRequestContext {
    notify?: ServerNotifier;
    resourceSubscriptions?: () => Iterable<string>;
    externalResourceNotifications?: boolean;
    httpDataBindings?: HttpDataBindings;
}

export interface ServerFactory {
    (context?: ServerFactoryContext): McpServer;
    close?: () => Promise<void>;
    // Optional for minimal/non-file factories used by connection owners.
    validateResourceSubscription?: (uri: string) => Promise<void>;
    subscribeCatalogUpdates?: (notify: ServerNotifier) => () => void;
    subscribeResourceUpdates?: (
        uris: () => Iterable<string>,
        publish: (uri: string) => void,
    ) => () => void;
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
    privateDirectoryAliases: string[] = [],
): ServerFactory {
    const options = resolveExtensionOptions(extensions);
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
        security.mode === 'container' ? 'container' : 'roots',
    );

    // Generate instructions with system-specific details (OS, shell, etc.)
    const instructions = getMcpInstructions(workingDir, security, {
        enableLsp,
    });

    let filesCore: FileCore | undefined;
    if (options.enabled.includes('files')) {
        let rootsAvailable = true;
        const fileRoots = sandbox.map((directory, index) => ({
            rootId: index === 0 ? 'main' : `extra${index}`,
            directory,
        }));
        for (const root of fileRoots) {
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
                fileRoots.map((root) => ({
                    ...root,
                    name: root.rootId === 'main' ? 'Workspace' : root.rootId,
                    readOnly: false,
                })),
                runtimeDirectory,
                standardCore,
            );
    }
    const terminalRuntime = options.enabled.includes('terminal')
        ? loadTerminalRuntime(true)
        : undefined;
    const terminalStore = terminalRuntime
        ? new TerminalStore(terminalRuntime)
        : undefined;
    const features = { files: !!filesCore, terminal: !!terminalRuntime };

    const factory: ServerFactory = (context) => {
        const modernHttp =
            context?.era === 'modern' && !!context.httpDataBindings;
        const discovery = manifest(features, modernHttp ? 2 : 1);
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
                        ? {
                              extensions: { [EXTENSIONS]: discovery },
                              experimental: { [EXTENSIONS]: discovery },
                          }
                        : {}),
                },
            },
        );

        // Register all functional tool modules
        registerFileTools(server, security, standardCore);
        registerShellTools(server, security);

        if (enableLsp) {
            registerLspTools(server, security);
        }

        const skills = registerSkillTools(
            server,
            workingDir,
            security,
            profile,
            !modernHttp,
        );
        registerMcpClientTools(server, { maxSessions: maxMcpSessions });

        const requireExtension =
            features.files || features.terminal
                ? installExtensions(
                      server,
                      filesCore,
                      path.join(runtimeDirectory, 'transfers'),
                      standardCore,
                      terminalRuntime,
                      modernHttp
                          ? {
                                mode: 'modern-http',
                                bindings: context.httpDataBindings!,
                            }
                          : undefined,
                      terminalStore,
                  )
                : undefined;
        registerFileResources(
            server,
            filesCore ?? standardCore,
            requireExtension
                ? (uri, ctx) =>
                      readAppResource(
                          uri,
                          requireExtension,
                          features.terminal,
                          ctx,
                      )
                : undefined,
            context?.resourceSubscriptions,
            context?.era === 'modern',
            context?.externalResourceNotifications,
            skills,
        );

        if (context?.era === 'modern' && context.notify) {
            const notify = context.notify;
            // Do not publish initial registration as a change. SDK updates/removes
            // continue to call these methods, including the skills watcher.
            server.sendToolListChanged = () => notify.toolsChanged();
            server.sendPromptListChanged = () => notify.promptsChanged();
            server.sendResourceListChanged = () => notify.resourcesChanged();
        }
        return server;
    };
    factory.close = () => terminalStore?.close() ?? Promise.resolve();
    factory.subscribeCatalogUpdates = (notify) =>
        watchProjectSkills(workingDir, () => {
            notify.toolsChanged();
            notify.promptsChanged();
            notify.resourcesChanged();
        });
    factory.validateResourceSubscription = (uri) =>
        validateFileResourceSubscription(filesCore ?? standardCore, uri);
    factory.subscribeResourceUpdates = (uris, publish) =>
        subscribeFileResourceUpdates(filesCore ?? standardCore, uris, publish);
    return factory;
}
