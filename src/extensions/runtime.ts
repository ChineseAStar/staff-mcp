import { ProtocolError } from '@modelcontextprotocol/server';
import type {
    McpServer,
    Transport,
    ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DATA_OPEN_METHOD } from '../data/HttpDataSession.js';
import type {
    ChannelOpen,
    ChannelReceiver,
    DataChannel,
    DataSession,
} from '../data/types.js';
import { FileCore, FileError } from '../file-manager/file-core.js';
import { registerFileManager } from '../file-manager/extension.js';
import { TerminalSession } from '../terminal/session.js';
import { registerTerminal } from '../terminal/extension.js';
import type { TerminalRuntime } from '../terminal/pty.js';
import {
    DATA,
    FILES,
    TERMINAL,
    STREAMS,
    APPS,
    supports,
    isModernRequest,
    extensionError,
    parse,
} from './protocol.js';
import { registerApps } from './apps.js';
import { registerServerCleanup } from '../utils/server-lifecycle.js';

export interface ExtensionDataBinding {
    session: DataSession;
    endpoint?: string;
    /** Listener/route ownership stays with the transport, not the data core. */
    close?: () => void | Promise<void>;
}
export type ExtensionDataFactory = (
    binding: string,
    accept: (
        open: ChannelOpen,
        channel: DataChannel,
    ) => Promise<ChannelReceiver>,
    signal: AbortSignal,
    origin: string | undefined,
    supportsPurpose: (purpose: string) => boolean,
) => ExtensionDataBinding | Promise<ExtensionDataBinding>;
const dataFactories = new WeakMap<
    McpServer,
    { factory: ExtensionDataFactory; transport: 'http' | 'stdio' }
>();

/** Configure before connect; the factory runs only on a negotiated data/v1/configure. */
export function configureExtensionData(
    server: McpServer,
    factory: ExtensionDataFactory,
    transport: 'http' | 'stdio' = 'http',
) {
    dataFactories.set(server, { factory, transport });
}

/** Attach business lifecycle without intercepting SDK protocol messages. */
export function installExtensions(
    server: McpServer,
    core: FileCore | undefined,
    transferDirectory: string,
    workspaceCore: FileCore,
    terminalRuntime?: TerminalRuntime,
) {
    let terminalSession: TerminalSession | undefined;
    let openData:
        | ((
              params: unknown,
              ctx: ServerContext,
          ) => Promise<Record<string, unknown>>)
        | undefined;
    let configureData:
        | ((
              params: unknown,
              ctx: ServerContext,
          ) => Promise<Record<string, unknown>>)
        | undefined;
    let initialized = false;
    const enabled = new Set([
        APPS,
        DATA,
        ...(core ? [FILES] : []),
        ...(terminalRuntime ? [STREAMS] : []),
    ]);
    const negotiated = (extension: string, ctx: ServerContext) =>
        (initialized || isModernRequest(ctx)) &&
        enabled.has(extension) &&
        supports(server, extension, ctx);
    const requireExtension = (extension: string, ctx: ServerContext) => {
        if (!negotiated(extension, ctx))
            extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Extension version 1 is unavailable on this initialized session',
            );
    };
    const createFileSession = core
        ? registerFileManager(server, core, transferDirectory)
        : undefined;
    const previousInitialized = server.server.oninitialized;
    server.server.oninitialized = () => {
        initialized = true;
        previousInitialized?.();
    };
    registerApps(server, requireExtension, () => !!terminalSession, negotiated);
    if (terminalRuntime)
        registerTerminal(server, (ctx, method) => {
            requireExtension(STREAMS, ctx);
            if (method !== 'status' && method !== 'close')
                requireExtension(DATA, ctx);
            return terminalSession;
        });
    for (const method of ['cc.qqxing/data/v1/configure', DATA_OPEN_METHOD]) {
        server.server.setRequestHandler(
            method,
            { params: z.unknown().optional() },
            async (input, ctx) => {
                if (ctx.mcpReq.signal.aborted)
                    extensionError(
                        'STALE_CONNECTION',
                        'Data request connection closed',
                    );
                try {
                    requireExtension(DATA, ctx);
                    const handler =
                        method === DATA_OPEN_METHOD ? openData : configureData;
                    if (!handler)
                        extensionError(
                            'STALE_CONNECTION',
                            'No active data connection',
                        );
                    return await handler(input, ctx);
                } catch (error) {
                    if (error instanceof FileError)
                        throw new ProtocolError(error.rpcCode, error.message, {
                            code: error.code,
                        });
                    throw error;
                }
            },
        );
    }
    const connect = server.connect.bind(server);
    server.connect = async (transport: Transport) => {
        let closed = false;
        initialized = false;
        const lifetime = new AbortController();
        let data: ExtensionDataBinding | undefined;
        let dataExtensions: Set<string> | undefined;
        const requireDataExtension = (extension: string) => {
            if (closed || !dataExtensions?.has(extension))
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Extension was not negotiated for this data connection',
                );
        };
        const currentData = () => {
            if (closed || !data)
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Data session has not been configured',
                );
            return data.session;
        };
        const files = createFileSession?.(() => {
            requireDataExtension(FILES);
            requireDataExtension(DATA);
            const session = currentData();
            if (
                !session.supports(FILES, 'host-to-remote') ||
                !session.supports(FILES, 'remote-to-host')
            )
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Files data session is unavailable',
                );
        });
        const terminal = terminalRuntime
            ? new TerminalSession(workspaceCore, terminalRuntime, () => {
                  requireDataExtension(STREAMS);
                  requireDataExtension(DATA);
                  if (!currentData().supports(TERMINAL, 'duplex'))
                      extensionError(
                          'CAPABILITY_UNAVAILABLE',
                          'Terminal data session is unavailable',
                      );
              })
            : undefined;
        terminalSession = terminal;
        const accept = async (open: ChannelOpen, channel: DataChannel) => {
            requireDataExtension(DATA);
            if (open.purpose === FILES && files) {
                requireDataExtension(FILES);
                return files.transfers.acceptChannel(open, channel);
            }
            if (open.purpose === TERMINAL && terminal) {
                requireDataExtension(STREAMS);
                return terminal.acceptChannel(open, channel);
            }
            return extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Unsupported data channel purpose',
            );
        };
        const supportsPurpose = (purpose: string) =>
            !closed &&
            dataExtensions?.has(DATA) === true &&
            ((purpose === FILES &&
                !!files &&
                dataExtensions?.has(FILES) === true) ||
                (purpose === TERMINAL &&
                    !!terminal &&
                    dataExtensions?.has(STREAMS) === true));
        let configurationAttempted = false;
        let configuration: Promise<ExtensionDataBinding> | undefined;
        let dataCleanup: Promise<void> | undefined;
        const disposeData = (owned: ExtensionDataBinding) => {
            dataCleanup ??= (async () => {
                try {
                    owned.session.close();
                } finally {
                    await owned.close?.();
                }
            })();
            return dataCleanup;
        };
        const configure = async (params: unknown, ctx: ServerContext) => {
            if (closed)
                extensionError('STALE_CONNECTION', 'Data connection closed');
            const { binding, origin, transport } = parse(
                z
                    .object({
                        binding: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
                        origin: z.string().max(2048).optional(),
                        transport: z.literal('stdio').optional(),
                    })
                    .strict(),
                params,
            );
            const registration = dataFactories.get(server);
            if (!registration)
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Data endpoint is not configured',
                );
            if (registration.transport === 'stdio') {
                if (transport !== 'stdio' || origin !== undefined)
                    extensionError(
                        'INVALID_PARAMS',
                        "Stdio data requires transport:'stdio' without an origin",
                    );
            } else if (transport !== undefined) {
                extensionError(
                    'INVALID_PARAMS',
                    'HTTP data does not accept a stdio transport',
                );
            }
            if (origin !== undefined) {
                let endpoint: URL;
                try {
                    endpoint = new URL(origin);
                } catch {
                    return extensionError(
                        'INVALID_PARAMS',
                        'Invalid data advertisement origin',
                    );
                }
                if (
                    !['http:', 'https:'].includes(endpoint.protocol) ||
                    endpoint.username ||
                    endpoint.password ||
                    endpoint.search ||
                    endpoint.hash ||
                    endpoint.origin !== origin
                )
                    extensionError(
                        'INVALID_PARAMS',
                        'Expected an absolute HTTP(S) origin without path or credentials',
                    );
            }
            if (configurationAttempted)
                extensionError(
                    'INVALID_STATE',
                    'Data session is already configured',
                );
            configurationAttempted = true;
            dataExtensions = new Set(
                [...enabled].filter((extension) => negotiated(extension, ctx)),
            );
            configuration = Promise.resolve().then(() =>
                registration.factory(
                    binding,
                    accept,
                    lifetime.signal,
                    origin,
                    supportsPurpose,
                ),
            );
            try {
                let owned: ExtensionDataBinding;
                try {
                    owned = await configuration;
                } catch (error) {
                    if (closed)
                        extensionError(
                            'STALE_CONNECTION',
                            'Data connection closed during setup',
                        );
                    // Preserve explicit parameter/protocol errors, but a runtime
                    // endpoint failure must not take down standard MCP control.
                    if (error instanceof ProtocolError) throw error;
                    console.error(
                        '[staff-mcp] Warning: Extension data unavailable: endpoint setup failed.',
                    );
                    return extensionError(
                        'CAPABILITY_UNAVAILABLE',
                        'Data endpoint setup failed',
                    );
                }
                if (closed) {
                    await disposeData(owned);
                    return extensionError(
                        'STALE_CONNECTION',
                        'Data connection closed during setup',
                    );
                }
                data = owned;
                if (registration.transport === 'stdio')
                    return { transport: 'stdio' };
                return owned.endpoint ? { endpoint: owned.endpoint } : {};
            } finally {
                // Keep only a pending setup, not a completed configuration receipt.
                configuration = undefined;
            }
        };
        const open = async (params: unknown, ctx: ServerContext) => {
            if (closed)
                extensionError('STALE_CONNECTION', 'Data connection closed');
            if (!data)
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Data session has not been configured',
                );
            // Reject disabled/unnegotiated purposes before the data core allocates a channel.
            const { open } = parse(
                z
                    .object({
                        open: z.object({ purpose: z.string() }).passthrough(),
                    })
                    .passthrough(),
                params,
            );
            if (!supportsPurpose(open.purpose))
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Unsupported data channel purpose',
                );
            requireExtension(
                open.purpose === TERMINAL ? STREAMS : open.purpose,
                ctx,
            );
            return { ...(await data.session.acceptOpen(params)) };
        };
        configureData = configure;
        openData = open;
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = () => {
            if (cleanupPromise) return cleanupPromise;
            closed = true;
            initialized = false;
            lifetime.abort();
            if (openData === open) openData = undefined;
            if (configureData === configure) configureData = undefined;
            // Fence bytes synchronously; await staging, PTYs and listener ownership
            // together. A late configure result still belongs to this session.
            cleanupPromise = Promise.allSettled([
                (async () => {
                    if (data) await disposeData(data);
                    else if (configuration) {
                        const owned = await configuration.catch(
                            () => undefined,
                        );
                        if (owned) await disposeData(owned);
                    }
                })(),
                (async () => {
                    await terminal?.close();
                })(),
                (async () => {
                    await files?.close();
                })(),
            ]).then((results) => {
                const errors = results
                    .filter((result) => result.status === 'rejected')
                    .map((result) => result.reason);
                if (errors.length)
                    throw new AggregateError(
                        errors,
                        'Extension cleanup failed',
                    );
            });
            return cleanupPromise;
        };
        registerServerCleanup(server, cleanup);
        try {
            await connect(transport);
        } catch (error) {
            const pendingCleanup = cleanup();
            void pendingCleanup.catch(() => {});
            await transport.close().catch(() => {});
            // Transports may reject start without notifying the SDK.
            if (server.server.transport === transport) transport.onclose?.();
            await pendingCleanup.catch(() =>
                console.error('[staff-mcp] Extension cleanup failed.'),
            );
            throw error;
        }
        if (server.server.transport !== transport) await cleanup();
    };
    return requireExtension;
}
