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
import {
    FileManagerSession,
    registerFileManager,
} from '../file-manager/extension.js';
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
import type { HttpDataBindings } from './HttpDataBindings.js';

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
interface DataRegistration {
    factory: ExtensionDataFactory;
    transport: 'http' | 'stdio';
}
const dataFactories = new WeakMap<McpServer, DataRegistration>();

/** Configure before connect; retained for connection-owned DATA1 on every transport. */
export function configureExtensionData(
    server: McpServer,
    factory: ExtensionDataFactory,
    transport: 'http' | 'stdio' = 'http',
) {
    dataFactories.set(server, { factory, transport });
}

/** Validate before allocating an HTTP owner or reserving a binding. */
export function parseDataConfiguration(
    params: unknown,
    transportKind: 'http' | 'stdio',
    requestUrl?: string,
) {
    const config = parse(
        z
            .object({
                binding: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
                origin: z.string().max(2048).optional(),
                transport: z.literal('stdio').optional(),
            })
            .strict(),
        params,
    );
    if (transportKind === 'stdio') {
        if (config.transport !== 'stdio' || config.origin !== undefined)
            extensionError(
                'INVALID_PARAMS',
                "Stdio data requires transport:'stdio' without an origin",
            );
    } else if (config.transport !== undefined) {
        extensionError(
            'INVALID_PARAMS',
            'HTTP data does not accept a stdio transport',
        );
    }
    if (
        config.origin === undefined &&
        requestUrl !== undefined &&
        transportKind === 'http'
    ) {
        try {
            config.origin = new URL(requestUrl).origin;
        } catch {
            return extensionError(
                'INVALID_PARAMS',
                'Invalid data advertisement origin',
            );
        }
    }
    if (config.origin !== undefined) {
        let endpoint: URL;
        try {
            endpoint = new URL(config.origin);
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
            endpoint.origin !== config.origin
        )
            extensionError(
                'INVALID_PARAMS',
                'Expected an absolute HTTP(S) origin without path or credentials',
            );
    }
    return config;
}

/** One business lifetime, independent of any SDK facade or transport connection. */
export class ExtensionOwner {
    readonly files: FileManagerSession | undefined;
    readonly terminal: TerminalSession | undefined;
    private closed = false;
    private readonly lifetime = new AbortController();
    private data?: ExtensionDataBinding;
    private dataExtensions: ReadonlySet<string> | undefined;
    private configurationAttempted = false;
    private configuration?: Promise<ExtensionDataBinding>;
    private dataCleanup?: Promise<void>;
    private cleanupPromise?: Promise<void>;
    private readonly fileManagerCalls = new Set<Promise<unknown>>();

    constructor(
        createFiles:
            | ((requireData: () => void) => FileManagerSession)
            | undefined,
        workspaceCore: FileCore,
        terminalRuntime?: TerminalRuntime,
        private readonly isActive: () => boolean = () => true,
    ) {
        this.files = createFiles?.(() => {
            this.requireDataExtension(FILES);
            this.requireDataExtension(DATA);
            const session = this.currentData();
            if (
                !session.supports(FILES, 'host-to-remote') ||
                !session.supports(FILES, 'remote-to-host')
            )
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Files data session is unavailable',
                );
        });
        this.terminal = terminalRuntime
            ? new TerminalSession(workspaceCore, terminalRuntime, () => {
                  this.requireDataExtension(STREAMS);
                  this.requireDataExtension(DATA);
                  if (!this.currentData().supports(TERMINAL, 'duplex'))
                      extensionError(
                          'CAPABILITY_UNAVAILABLE',
                          'Terminal data session is unavailable',
                      );
              })
            : undefined;
    }

    private requireDataExtension(extension: string) {
        if (
            this.closed ||
            !this.isActive() ||
            !this.dataExtensions?.has(extension)
        )
            extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Extension was not negotiated for this data connection',
            );
    }
    private currentData() {
        if (this.closed || !this.isActive() || !this.data)
            extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Data session has not been configured',
            );
        return this.data.session;
    }
    private readonly accept = async (
        open: ChannelOpen,
        channel: DataChannel,
    ) => {
        this.requireDataExtension(DATA);
        if (open.purpose === FILES && this.files) {
            this.requireDataExtension(FILES);
            return this.files.transfers.acceptChannel(open, channel);
        }
        if (open.purpose === TERMINAL && this.terminal) {
            this.requireDataExtension(STREAMS);
            return this.terminal.acceptChannel(open, channel);
        }
        return extensionError(
            'CAPABILITY_UNAVAILABLE',
            'Unsupported data channel purpose',
        );
    };
    private readonly supportsPurpose = (purpose: string) =>
        !this.closed &&
        this.isActive() &&
        this.dataExtensions?.has(DATA) === true &&
        ((purpose === FILES &&
            !!this.files &&
            this.dataExtensions?.has(FILES) === true) ||
            (purpose === TERMINAL &&
                !!this.terminal &&
                this.dataExtensions?.has(STREAMS) === true));

    private disposeData(owned: ExtensionDataBinding) {
        this.dataCleanup ??= (async () => {
            try {
                owned.session.close();
            } finally {
                await owned.close?.();
            }
        })();
        return this.dataCleanup;
    }

    async configure(
        config: ReturnType<typeof parseDataConfiguration>,
        registration: DataRegistration,
        grants: ReadonlySet<string>,
    ): Promise<Record<string, unknown>> {
        if (this.closed || !this.isActive())
            extensionError('STALE_CONNECTION', 'Data connection closed');
        if (this.configurationAttempted)
            extensionError(
                'INVALID_STATE',
                'Data session is already configured',
            );
        this.configurationAttempted = true;
        this.dataExtensions = new Set(grants);
        this.configuration = Promise.resolve().then(() =>
            registration.factory(
                config.binding,
                this.accept,
                this.lifetime.signal,
                config.origin,
                this.supportsPurpose,
            ),
        );
        try {
            let owned: ExtensionDataBinding;
            try {
                owned = await this.configuration;
            } catch (error) {
                if (this.closed)
                    extensionError(
                        'STALE_CONNECTION',
                        'Data connection closed during setup',
                    );
                if (error instanceof ProtocolError) throw error;
                console.error(
                    '[staff-mcp] Warning: Extension data unavailable: endpoint setup failed.',
                );
                return extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Data endpoint setup failed',
                );
            }
            if (this.closed || !this.isActive()) {
                await this.disposeData(owned);
                return extensionError(
                    'STALE_CONNECTION',
                    'Data connection closed during setup',
                );
            }
            this.data = owned;
            if (registration.transport === 'stdio')
                return { transport: 'stdio' };
            return owned.endpoint ? { endpoint: owned.endpoint } : {};
        } finally {
            this.configuration = undefined;
        }
    }

    async open(params: unknown, requireCurrent: (extension: string) => void) {
        if (this.closed || !this.isActive())
            extensionError('STALE_CONNECTION', 'Data connection closed');
        const session = this.currentData();
        // Reject unnegotiated purposes before the core allocates a channel.
        const { open } = parse(
            z
                .object({
                    open: z.object({ purpose: z.string() }).passthrough(),
                })
                .passthrough(),
            params,
        );
        if (!this.supportsPurpose(open.purpose))
            extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Unsupported data channel purpose',
            );
        requireCurrent(open.purpose === TERMINAL ? STREAMS : open.purpose);
        return { ...(await session.acceptOpen(params)) };
    }

    /** DATA2 CRUD admitted before the close fence must finish before close returns. */
    runFileManager<T>(operation: () => Promise<T>): Promise<T> {
        if (this.closed || !this.isActive())
            extensionError('STALE_CONNECTION', 'Data connection closed');
        const pending = Promise.resolve().then(operation);
        this.fileManagerCalls.add(pending);
        return pending.finally(() => this.fileManagerCalls.delete(pending));
    }

    close(): Promise<void> {
        if (this.cleanupPromise) return this.cleanupPromise;
        this.closed = true;
        this.lifetime.abort();
        // Invoke all three owners now: each synchronously fences new work before awaiting.
        this.cleanupPromise = Promise.allSettled([
            // Business failures belong to their RPCs, not to owner cleanup.
            // New CRUD is fenced synchronously, so this snapshot is complete.
            Promise.allSettled([...this.fileManagerCalls]).then(() => {}),
            (async () => {
                if (this.data) await this.disposeData(this.data);
                else if (this.configuration) {
                    const owned = await this.configuration.catch(
                        () => undefined,
                    );
                    if (owned) await this.disposeData(owned);
                }
            })(),
            (async () => {
                await this.terminal?.close();
            })(),
            (async () => {
                await this.files?.close();
            })(),
        ]).then((results) => {
            const errors = results
                .filter((result) => result.status === 'rejected')
                .map((result) => result.reason);
            if (errors.length)
                throw new AggregateError(errors, 'Extension cleanup failed');
        });
        return this.cleanupPromise;
    }
}

export interface ExtensionRuntimeOptions {
    /** Supplied by composition; modern stdio/reverse remain connection-owned DATA1. */
    mode: 'modern-http';
    bindings: HttpDataBindings;
}

/** Attach business lifecycle without intercepting SDK protocol messages. */
export function installExtensions(
    server: McpServer,
    core: FileCore | undefined,
    transferDirectory: string,
    workspaceCore: FileCore,
    terminalRuntime?: TerminalRuntime,
    options?: ExtensionRuntimeOptions,
) {
    const bindings =
        options?.mode === 'modern-http' ? options.bindings : undefined;
    const dataVersion = bindings ? 2 : 1;
    let owner: ExtensionOwner | undefined;
    let initialized = false;
    const enabled = new Set([
        APPS,
        DATA,
        ...(core ? [FILES] : []),
        ...(terminalRuntime ? [STREAMS] : []),
    ]);
    const negotiated = (extension: string, ctx: ServerContext) =>
        (bindings
            ? isModernRequest(ctx)
            : initialized || isModernRequest(ctx)) &&
        enabled.has(extension) &&
        supports(server, extension, ctx, extension === DATA ? dataVersion : 1);
    const requireExtension = (extension: string, ctx: ServerContext) => {
        if (!negotiated(extension, ctx))
            extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Extension is unavailable on this request',
            );
    };
    const grants = (ctx: ServerContext) =>
        new Set([...enabled].filter((extension) => negotiated(extension, ctx)));
    const previousInitialized = server.server.oninitialized;
    server.server.oninitialized = () => {
        initialized = true;
        previousInitialized?.();
    };
    const createFileSession = core
        ? registerFileManager(
              server,
              core,
              transferDirectory,
              bindings
                  ? {
                        resolve: (input, ctx, method, required) => {
                            const resolved = bindings.resolve(
                                input,
                                (extension) => negotiated(extension, ctx),
                                required,
                                ['status', 'cancel', 'release'].includes(method)
                                    ? 'receipt'
                                    : 'active',
                            );
                            if (!resolved.owner.files)
                                extensionError(
                                    'CAPABILITY_UNAVAILABLE',
                                    'Files extension is unavailable',
                                );
                            return {
                                session: resolved.owner.files,
                                params: resolved.params,
                                run: (operation) =>
                                    resolved.owner.runFileManager(operation),
                            };
                        },
                    }
                  : undefined,
          )
        : undefined;
    const createOwner = (isActive?: () => boolean) =>
        new ExtensionOwner(
            bindings && core
                ? (requireData) =>
                      new FileManagerSession(
                          core,
                          undefined,
                          transferDirectory,
                          requireData,
                      )
                : createFileSession,
            workspaceCore,
            terminalRuntime,
            isActive,
        );
    registerApps(
        server,
        requireExtension,
        () => (bindings ? !!terminalRuntime : !!owner?.terminal),
        negotiated,
        dataVersion,
    );
    if (terminalRuntime)
        registerTerminal(
            server,
            (ctx, method) => {
                requireExtension(STREAMS, ctx);
                if (method !== 'status' && method !== 'close')
                    requireExtension(DATA, ctx);
                return owner?.terminal;
            },
            bindings
                ? (input, ctx, method) => {
                      const resolved = bindings.resolve(
                          input,
                          (extension) => negotiated(extension, ctx),
                          [STREAMS],
                          method === 'status' || method === 'close'
                              ? 'receipt'
                              : 'active',
                      );
                      return {
                          terminal: resolved.owner.terminal,
                          params: resolved.params,
                      };
                  }
                : undefined,
        );

    const methods = bindings
        ? ['configure', 'open', 'renew', 'close']
        : ['configure', 'open'];
    for (const method of methods) {
        const name =
            !bindings && method === 'open'
                ? DATA_OPEN_METHOD
                : `${DATA}/v${dataVersion}/${method}`;
        server.server.setRequestHandler(
            name,
            { params: z.unknown().optional() },
            async (input, ctx) => {
                if (ctx.mcpReq.signal.aborted)
                    extensionError(
                        'STALE_CONNECTION',
                        'Data request connection closed',
                    );
                try {
                    requireExtension(DATA, ctx);
                    if (bindings) {
                        const current = (extension: string) =>
                            negotiated(extension, ctx);
                        if (method === 'configure')
                            return await bindings.configure(
                                input,
                                ctx.mcpReq.signal,
                                grants(ctx),
                                createOwner,
                                ctx.http?.req?.url,
                            );
                        if (method === 'renew')
                            return bindings.renew(input, current);
                        if (method === 'close')
                            return await bindings.closeBinding(input, current);
                        const resolved = bindings.resolve(input, current, []);
                        if (
                            resolved.params.binding !== resolved.control.binding
                        )
                            extensionError(
                                'INVALID_CONTROL',
                                'Data control is unavailable',
                            );
                        return await resolved.owner.open(
                            resolved.params,
                            (extension) => requireExtension(extension, ctx),
                        );
                    }
                    if (!owner)
                        extensionError(
                            'STALE_CONNECTION',
                            'No active data connection',
                        );
                    if (method === 'open')
                        return await owner.open(input, (extension) =>
                            requireExtension(extension, ctx),
                        );
                    const registration = dataFactories.get(server);
                    if (!registration)
                        extensionError(
                            'CAPABILITY_UNAVAILABLE',
                            'Data endpoint is not configured',
                        );
                    const config = parseDataConfiguration(
                        input,
                        registration.transport,
                    );
                    return await owner.configure(
                        config,
                        registration,
                        grants(ctx),
                    );
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
    // Modern facades never own a business lifetime. The HTTP composition closes the registry.
    if (bindings) return requireExtension;
    const connect = server.connect.bind(server);
    server.connect = async (transport: Transport) => {
        initialized = false;
        const connectedOwner = createOwner();
        owner = connectedOwner;
        const cleanup = () => {
            initialized = false;
            if (owner === connectedOwner) owner = undefined;
            return connectedOwner.close();
        };
        registerServerCleanup(server, cleanup);
        try {
            await connect(transport);
        } catch (error) {
            const pendingCleanup = cleanup();
            void pendingCleanup.catch(() => {});
            await transport.close().catch(() => {});
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
