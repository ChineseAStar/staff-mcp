import { HttpDataSession } from '../data/HttpDataSession.js';
import { handleNodeRequest } from '../data/node.js';
import {
    allowLongRequestBody,
    installRequestPolicy,
} from '../data/request-policy.js';
import { createServer } from 'node:http';
import { configureExtensionData } from '../extensions/runtime.js';
import type { ExtensionDataFactory } from '../extensions/runtime.js';
import { HttpDataBindings } from '../extensions/HttpDataBindings.js';
import type { ServerFactory } from '../server.js';
import { MODERN_SUBSCRIPTION_REVISION } from './ResourceSubscriptions.js';
import express from 'express';
import cors from 'cors';
import {
    NodeStreamableHTTPServerTransport,
    toNodeHandler,
    toWebRequest,
} from '@modelcontextprotocol/node';
import {
    classifyInboundRequest,
    createMcpHandler,
    isLegacyRequest,
    isSpecType,
    ProtocolError,
    isInitializeRequest,
    isJSONRPCRequest,
} from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export function getHttpAuthToken(token?: string): string | undefined {
    if (token === undefined) return undefined;
    if (!token || /\s/.test(token)) {
        throw new Error(
            '--http-token must be non-empty and contain no whitespace when provided.',
        );
    }
    return token;
}

export const HTTP_MAX_SESSIONS = 64;
interface HttpSession {
    server: McpServer;
    transport: NodeStreamableHTTPServerTransport;
    closing?: Promise<void>;
}

export async function startHttpServer(
    serverFactory: ServerFactory,
    port: number,
    host: string = '0.0.0.0',
    token?: string,
) {
    const authToken = getHttpAuthToken(token);
    const app = express();
    let stopping = false;
    const sessions = new Map<string, HttpSession>();
    const dataSessions = new Map<string, HttpDataSession>();
    const createDataBinding: ExtensionDataFactory = (
        binding,
        accept,
        signal,
        origin,
        supportsPurpose,
    ) => {
        signal.throwIfAborted();
        if (stopping) throw new Error('HTTP listener is closing.');
        if (dataSessions.has(binding))
            throw new Error('Data binding already exists.');
        if (!origin) throw new Error('MCP HTTP origin is required.');
        const endpoint = new URL(`/mcp/data/${binding}`, origin).href;
        const data = new HttpDataSession({
            role: 'remote',
            binding,
            endpoint,
            accept,
            supportsPurpose,
            fetch: async () => {
                throw new Error(
                    'Outbound data is unavailable in HTTP listener mode',
                );
            },
            validateEndpoint: () => {
                throw new Error(
                    'Outbound data endpoint is unavailable in HTTP listener mode',
                );
            },
        });
        dataSessions.set(binding, data);
        return {
            session: data,
            endpoint,
            close: () => {
                if (dataSessions.get(binding) === data)
                    dataSessions.delete(binding);
            },
        };
    };
    const bindings: HttpDataBindings = new HttpDataBindings(
        createDataBinding,
        HTTP_MAX_SESSIONS,
        () => sessions.size + bindings.activeCount < HTTP_MAX_SESSIONS,
    );
    // Interests are scoped to actual HTTP response streams, never caller IDs.
    // The SDK remains the sole ACK/filter/router and closes its own streams.
    const resourceInterests = new Set<ReadonlySet<string>>();
    const resourceUris = function* () {
        for (const uris of resourceInterests) yield* uris;
    };
    const modern = createMcpHandler(
        (context) =>
            serverFactory({
                ...context,
                httpDataBindings: bindings,
                notify: modern.notify,
                externalResourceNotifications: true,
            }),
        {
            legacy: 'reject',
            maxRequestBodySize: 50 * 1024 * 1024,
            onerror: () =>
                console.error('[staff-mcp] Modern HTTP request failed.'),
        },
    );
    const stopResourceNotifications = serverFactory.subscribeResourceUpdates?.(
        resourceUris,
        (uri) => modern.notify.resourceUpdated(uri),
    );
    const stopCatalogNotifications = serverFactory.subscribeCatalogUpdates?.(
        modern.notify,
    );
    const modernNode = toNodeHandler(
        {
            fetch: async (request, options) => {
                const body = options?.parsedBody;
                const classified = classifyInboundRequest({
                    httpMethod: request.method,
                    body,
                    protocolVersionHeader:
                        request.headers.get('mcp-protocol-version') ??
                        undefined,
                    mcpMethodHeader:
                        request.headers.get('mcp-method') ?? undefined,
                    mcpNameHeader: request.headers.get('mcp-name') ?? undefined,
                });
                if (
                    classified.kind !== 'modern' ||
                    classified.classification.revision !==
                        MODERN_SUBSCRIPTION_REVISION ||
                    classified.messageKind !== 'request' ||
                    classified.message.method !== 'subscriptions/listen' ||
                    !isSpecType.SubscriptionFilter(
                        classified.message.params?.notifications,
                    )
                ) {
                    return modern.fetch(request, options);
                }
                const uris = new Set(
                    classified.message.params.notifications
                        .resourceSubscriptions ?? [],
                );
                try {
                    for (const uri of uris) {
                        request.signal.throwIfAborted();
                        await serverFactory.validateResourceSubscription?.(uri);
                    }
                    request.signal.throwIfAborted();
                } catch (error) {
                    const failure =
                        error instanceof ProtocolError
                            ? error
                            : new ProtocolError(
                                  -32603,
                                  'Resource subscription validation failed',
                              );
                    return Response.json({
                        jsonrpc: '2.0',
                        id: classified.message.id,
                        error: {
                            code: failure.code,
                            message: failure.message,
                            ...(failure.data !== undefined
                                ? { data: failure.data }
                                : {}),
                        },
                    });
                }
                // Candidate dependencies precede SDK admission; until acknowledged,
                // the SDK drops their events. No protocol response is parsed or forged.
                resourceInterests.add(uris);
                const release = () => {
                    resourceInterests.delete(uris);
                    request.signal.removeEventListener('abort', release);
                };
                request.signal.addEventListener('abort', release, {
                    once: true,
                });
                try {
                    const response = await modern.fetch(request, options);
                    if (
                        !response.body ||
                        !response.headers
                            .get('content-type')
                            ?.startsWith('text/event-stream')
                    ) {
                        release();
                        return response;
                    }
                    const reader = response.body.getReader();
                    const stream = new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            try {
                                const result = await reader.read();
                                if (result.done) {
                                    release();
                                    controller.close();
                                } else controller.enqueue(result.value);
                            } catch (error) {
                                release();
                                controller.error(error);
                            }
                        },
                        async cancel(reason) {
                            release();
                            await reader.cancel(reason);
                        },
                    });
                    return new Response(stream, {
                        status: response.status,
                        headers: response.headers,
                    });
                } catch (error) {
                    release();
                    throw error;
                }
            },
        },
        {
            onerror: () =>
                console.error('[staff-mcp] Modern HTTP response failed.'),
        },
    );

    const closeSession = (id: string, session: HttpSession) => {
        session.closing ??= Promise.resolve()
            .then(() => session.server.close())
            .then(() => {
                if (sessions.get(id) === session) sessions.delete(id);
            });
        return session.closing;
    };
    const observeClose = (id: string, session: HttpSession) => {
        void closeSession(id, session).catch(() =>
            console.error('[staff-mcp] HTTP session cleanup failed.'),
        );
    };
    const reject = (res: express.Response, status: number, message: string) => {
        if (!res.headersSent && !res.destroyed) {
            res.status(status).json({
                jsonrpc: '2.0',
                id: null,
                error: {
                    code:
                        status === 404
                            ? -32001
                            : status === 429
                              ? -32000
                              : -32600,
                    message,
                },
            });
        }
    };

    // CORS preflight is public and never reaches MCP session handling.
    app.use(cors());
    app.use((_req, res, next) => {
        if (stopping) return reject(res, 503, 'Server is stopping');
        next();
    });

    // Session-owned public data endpoints must bypass the MCP JSON parser.
    app.use((req, res, next) => {
        const match = /^\/mcp\/data\/([A-Za-z0-9_-]{16,256})(?:\/|$)/.exec(
            req.url,
        );
        if (!match) return next();
        const session = dataSessions.get(match[1]);
        if (!session) {
            res.status(404).end();
            return;
        }
        void handleNodeRequest(session, req, res, () =>
            allowLongRequestBody(req),
        ).then(
            (handled) => {
                if (!handled && !res.headersSent) res.status(404).end();
            },
            () => {
                console.error('[staff-mcp] HTTP data request failed.');
                if (!res.headersSent) res.status(500).end();
                else res.destroy();
            },
        );
    });

    // When configured, authenticate before parsing bodies or accessing sessions.
    if (authToken !== undefined) {
        const expectedToken = Buffer.from(authToken);
        app.use(['/mcp', '/sse', '/messages'], (req, res, next) => {
            const match = /^Bearer +(\S+)$/i.exec(
                req.headers.authorization ?? '',
            );
            const providedToken = Buffer.from(match?.[1] ?? '');
            if (
                providedToken.length !== expectedToken.length ||
                !timingSafeEqual(providedToken, expectedToken)
            ) {
                res.setHeader('WWW-Authenticate', 'Bearer realm="staff-mcp"');
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
            next();
        });
    }

    // Preserve ordinary tool payloads; binary data bypasses this parser.
    app.use(express.json({ limit: '50mb' }));

    const mcpHandler = async (req: express.Request, res: express.Response) => {
        const sessionId = req.headers['mcp-session-id'];
        if (sessionId !== undefined) {
            if (typeof sessionId !== 'string' || !sessionId) {
                return reject(res, 400, 'Invalid MCP session ID');
            }
            const session = sessions.get(sessionId);
            if (!session || session.closing) {
                return reject(res, 404, 'Session not found');
            }
            try {
                await session.transport.handleRequest(req, res, req.body);
            } catch {
                console.error('[staff-mcp] HTTP control request failed.');
                reject(res, 500, 'Internal Server Error');
            }
            return;
        }

        // A stale ID, GET, DELETE or malformed request cannot allocate resources.
        if (
            req.method !== 'POST' ||
            !isJSONRPCRequest(req.body) ||
            !isInitializeRequest(req.body)
        ) {
            return reject(res, 400, 'A new session requires initialization');
        }
        // JSON body parsing can finish after shutdown has started.
        if (stopping) return reject(res, 503, 'Server is stopping');
        if (sessions.size + bindings.activeCount >= HTTP_MAX_SESSIONS)
            return reject(res, 429, 'HTTP session capacity reached');

        const id = randomUUID();
        let session: HttpSession | undefined;
        const disconnected = () => {
            if (!res.writableFinished && session) observeClose(id, session);
        };
        try {
            const server = serverFactory();
            const transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => id,
                enableJsonResponse: true,
            });
            session = { server, transport };
            const owned = session;
            // Include starting sessions in shutdown ownership before the first await.
            sessions.set(id, session);
            transport.onclose = () => observeClose(id, owned);
            res.once('close', disconnected);

            configureExtensionData(
                server,
                (binding, accept, signal, origin, supportsPurpose) => {
                    signal.throwIfAborted();
                    if (stopping || owned.closing)
                        throw new Error('HTTP session is closing.');
                    const authority = req.get('host');
                    if (!authority)
                        throw new Error('MCP HTTP Host header is required.');
                    return createDataBinding(
                        binding,
                        accept,
                        signal,
                        origin ?? `${req.protocol}://${authority}`,
                        supportsPurpose,
                    );
                },
            );
            await server.connect(transport);
            if (stopping || session.closing) {
                await closeSession(id, session);
                return reject(res, 503, 'Server is stopping');
            }
            await transport.handleRequest(req, res, req.body);
            if (
                !transport.sessionId ||
                res.statusCode >= 400 ||
                (res.destroyed && !res.writableFinished)
            ) {
                await closeSession(id, session);
            }
        } catch {
            if (session) {
                await closeSession(id, session).catch(() =>
                    console.error('[staff-mcp] HTTP session cleanup failed.'),
                );
            }
            console.error('[staff-mcp] HTTP initialization failed.');
            reject(res, 500, 'Internal Server Error');
        } finally {
            res.removeListener('close', disconnected);
        }
    };

    app.all('/mcp', async (req, res) => {
        try {
            const request = await toWebRequest(req, req.body);
            if (await isLegacyRequest(request, req.body))
                await mcpHandler(req, res);
            else await modernNode(req, res, req.body);
        } catch {
            console.error('[staff-mcp] HTTP request routing failed.');
            reject(res, 500, 'Internal Server Error');
        }
    });
    app.get('/sse', mcpHandler);
    app.post('/messages', mcpHandler);

    const listener = createServer(app);
    const disposeRequestPolicy = installRequestPolicy(listener);
    try {
        await new Promise<void>((resolve, reject) => {
            listener.once('error', reject);
            listener.once('listening', () => {
                listener.removeListener('error', reject);
                resolve();
            });
            listener.listen(port, host);
        });
    } catch (error) {
        disposeRequestPolicy();
        stopping = true;
        stopResourceNotifications?.();
        stopCatalogNotifications?.();
        await Promise.allSettled([modern.close(), bindings.close()]);
        throw error;
    }
    const address = listener.address() as AddressInfo;
    console.error(
        `[MCP HTTP] Server listening on http://${host}:${address.port}/mcp`,
    );
    let stopped: Promise<void> | undefined;
    return {
        port: address.port,
        stop: () => {
            if (stopped) return stopped;
            stopping = true;
            // Stop accepting first, but keep the listener alive until owned cleanup settles.
            const listenerClosed = new Promise<void>((resolve, reject) => {
                listener.close((error) => (error ? reject(error) : resolve()));
            });
            stopped = (async () => {
                stopResourceNotifications?.();
                stopCatalogNotifications?.();
                const results = await Promise.allSettled([
                    modern.close(),
                    bindings.close(),
                    ...[...sessions].map(([id, session]) =>
                        closeSession(id, session),
                    ),
                ]);
                resourceInterests.clear();
                listener.closeAllConnections();
                await listenerClosed;
                const failed = results.filter(
                    (result) => result.status === 'rejected',
                );
                if (failed.length)
                    throw new AggregateError(
                        failed.map((result) => result.reason),
                        'HTTP session cleanup failed',
                    );
            })();
            return stopped;
        },
    };
}
