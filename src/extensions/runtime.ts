import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HttpDataSession, DATA_OPEN_METHOD } from '../data/HttpDataSession.js';
import type {
    ChannelOpen,
    ChannelReceiver,
    DataChannel,
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
    manifest,
    extensionError,
    parse,
} from './protocol.js';
import { registerApps } from './apps.js';

export interface ExtensionDataBinding {
    session: HttpDataSession;
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
    origin?: string,
) => ExtensionDataBinding | Promise<ExtensionDataBinding>;
const dataFactories = new WeakMap<McpServer, ExtensionDataFactory>();

/** Configure before connect; the factory runs only on a negotiated data/v1/configure. */
export function configureExtensionData(
    server: McpServer,
    factory: ExtensionDataFactory,
) {
    dataFactories.set(server, factory);
}

/** Attach business lifecycle only. The official SDK receives the original transport unchanged. */
export function installExtensions(
    server: McpServer,
    core: FileCore,
    transferDirectory: string,
    discovery: ReturnType<typeof manifest>,
    terminalRuntime?: TerminalRuntime,
) {
    let fileSession:
        | ReturnType<ReturnType<typeof registerFileManager>>
        | undefined;
    let terminalSession: TerminalSession | undefined;
    let openData:
        | ((params: unknown) => Promise<Record<string, unknown>>)
        | undefined;
    let configureData:
        | ((params: unknown) => Promise<Record<string, unknown>>)
        | undefined;
    const requireExtension = (extension: string) => {
        if (!fileSession)
            extensionError('STALE_CONNECTION', 'No active extension session');
        if (!fileSession.supports(extension))
            extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Extension version 1 is unavailable on this initialized session',
            );
    };
    const createFileSession = registerFileManager(
        server,
        core,
        transferDirectory,
        () => !!terminalSession,
    );
    registerApps(
        server,
        requireExtension,
        () => !!terminalSession,
        (extension) => fileSession?.supports(extension) ?? false,
    );
    registerTerminal(server, () => {
        requireExtension(TERMINAL);
        return terminalSession;
    });
    for (const method of ['cc.qqxing/data/v1/configure', DATA_OPEN_METHOD]) {
        server.server.setRequestHandler(
            z.object({
                method: z.literal(method),
                params: z.unknown().optional(),
            }),
            async (request, extra) => {
                if (extra.signal.aborted)
                    extensionError(
                        'STALE_CONNECTION',
                        'Data request connection closed',
                    );
                try {
                    requireExtension(DATA);
                    const handler =
                        method === DATA_OPEN_METHOD ? openData : configureData;
                    if (!handler)
                        extensionError(
                            'STALE_CONNECTION',
                            'No active data connection',
                        );
                    return await handler(request.params);
                } catch (error) {
                    if (error instanceof FileError)
                        throw new McpError(error.rpcCode, error.message, {
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
        const lifetime = new AbortController();
        let data: ExtensionDataBinding | undefined;
        const currentData = () => {
            if (closed || !data)
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Data session has not been configured',
                );
            return data.session;
        };
        const files = createFileSession(() => {
            files.requireExtension(DATA);
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
        fileSession = files;
        const terminal = terminalRuntime
            ? new TerminalSession(core, terminalRuntime, () => {
                  requireExtension(TERMINAL);
                  requireExtension(DATA);
                  if (!currentData().supports(TERMINAL, 'duplex'))
                      extensionError(
                          'CAPABILITY_UNAVAILABLE',
                          'Terminal data session is unavailable',
                      );
              })
            : undefined;
        terminalSession = terminal;
        Object.assign(discovery, manifest(!!terminal));
        const accept = async (open: ChannelOpen, channel: DataChannel) => {
            files.requireExtension(DATA);
            if (open.purpose === FILES) {
                files.requireExtension(FILES);
                return files.transfers.acceptChannel(open, channel);
            }
            if (open.purpose === TERMINAL && terminal) {
                files.requireExtension(TERMINAL);
                return terminal.acceptChannel(open, channel);
            }
            return extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Unsupported data channel purpose',
            );
        };
        let configurationAttempted = false;
        const disposeData = (owned: ExtensionDataBinding) => {
            owned.session.close();
            try {
                void Promise.resolve(owned.close?.()).catch(() =>
                    console.error('[staff-mcp] Data listener cleanup failed.'),
                );
            } catch {
                console.error('[staff-mcp] Data listener cleanup failed.');
            }
        };
        const configure = async (params: unknown) => {
            if (closed)
                extensionError('STALE_CONNECTION', 'Data connection closed');
            const { binding, origin } = parse(
                z
                    .object({
                        binding: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
                        origin: z.string().max(2048).optional(),
                    })
                    .strict(),
                params,
            );
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
            const factory = dataFactories.get(server);
            if (!factory)
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Data endpoint is not configured',
                );
            const owned = await factory(
                binding,
                accept,
                lifetime.signal,
                origin,
            );
            if (closed) {
                disposeData(owned);
                return extensionError(
                    'STALE_CONNECTION',
                    'Data connection closed during setup',
                );
            }
            data = owned;
            return owned.endpoint ? { endpoint: owned.endpoint } : {};
        };
        const open = async (params: unknown) => {
            if (closed)
                extensionError('STALE_CONNECTION', 'Data connection closed');
            if (!data)
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Data session has not been configured',
                );
            return { ...(await data.session.acceptOpen(params)) };
        };
        configureData = configure;
        openData = open;
        const cleanup = () => {
            if (closed) return;
            closed = true;
            lifetime.abort();
            if (openData === open) openData = undefined;
            if (configureData === configure) configureData = undefined;
            if (data) disposeData(data);
            terminal?.close();
            void files
                .close()
                .catch(() =>
                    console.error(
                        '[staff-mcp] Extension staging cleanup failed.',
                    ),
                );
        };
        const previousClose = transport.onclose;
        transport.onclose = () => {
            cleanup();
            previousClose?.();
        };
        try {
            await connect(transport);
        } catch (error) {
            cleanup();
            await transport.close().catch(() => {});
            // Transports may reject start without notifying the SDK.
            if (server.server.transport === transport) transport.onclose?.();
            throw error;
        }
        if (server.server.transport !== transport) cleanup();
    };
}
