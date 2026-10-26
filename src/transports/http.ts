import { HttpDataSession } from '../data/HttpDataSession.js';
import { handleNodeRequest } from '../data/node.js';
import { configureExtensionData } from '../extensions/runtime.js';
import { hasServerActivity } from '../utils/server-activity.js';
import express from 'express';
import cors from 'cors';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    isInitializeRequest,
    isJSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
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
export const HTTP_SESSION_IDLE_MS = 30 * 60 * 1000;

export interface HttpSessionPolicy {
    maxSessions?: number;
    idleTimeoutMs?: number;
}

export function resolveHttpSessionPolicy(policy: HttpSessionPolicy = {}) {
    const maxSessions = policy.maxSessions ?? HTTP_MAX_SESSIONS;
    const idleTimeoutMs = policy.idleTimeoutMs ?? HTTP_SESSION_IDLE_MS;
    if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0)
        throw new Error('HTTP max sessions must be a positive safe integer.');
    if (
        !Number.isInteger(idleTimeoutMs) ||
        idleTimeoutMs <= 0 ||
        idleTimeoutMs > 2_147_483_647
    )
        throw new Error('HTTP session idle timeout must be 1..2147483647 ms.');
    return { maxSessions, idleTimeoutMs };
}

interface HttpSession {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
    closing?: Promise<void>;
    initializing: boolean;
    /** Undefined while active; the next idle observation starts a full grace interval. */
    idleSince?: number;
}

export async function startHttpServer(
    serverFactory: () => McpServer,
    port: number,
    host: string = '0.0.0.0',
    token?: string,
    policy: HttpSessionPolicy = {},
) {
    const { maxSessions, idleTimeoutMs } = resolveHttpSessionPolicy(policy);
    const authToken = getHttpAuthToken(token);
    const app = express();
    let stopping = false;
    const sessions = new Map<string, HttpSession>();
    const dataSessions = new Map<string, HttpDataSession>();

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
    const sweepIdle = () => {
        const now = performance.now();
        for (const [id, session] of sessions) {
            if (session.closing) continue;
            if (session.initializing || hasServerActivity(session.server)) {
                session.idleSince = undefined;
            } else if (session.idleSince === undefined) {
                session.idleSince = now;
            } else if (now - session.idleSince >= idleTimeoutMs) {
                // Fence synchronously; cleanup keeps its slot until it succeeds.
                observeClose(id, session);
            }
        }
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
        void handleNodeRequest(session, req, res).then(
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
        sweepIdle();
        if (sessions.size >= maxSessions)
            return reject(res, 429, 'HTTP session capacity reached');

        const id = randomUUID();
        let session: HttpSession | undefined;
        const disconnected = () => {
            if (!res.writableFinished && session) observeClose(id, session);
        };
        try {
            const server = serverFactory();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => id,
                enableJsonResponse: true,
            });
            session = { server, transport, initializing: true };
            const owned = session;
            // The SDK calls this only after parsing/validating the control message.
            // Neither an idle GET SSE stream nor invalid HTTP/data traffic renews it.
            transport.onmessage = () => {
                owned.idleSince = undefined;
            };
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
                    if (dataSessions.has(binding))
                        throw new Error('Data binding already exists.');
                    const authority = req.get('host');
                    if (!authority)
                        throw new Error('MCP HTTP Host header is required.');
                    const endpoint = new URL(
                        `/mcp/data/${binding}`,
                        origin ?? `${req.protocol}://${authority}`,
                    ).href;
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
            if (session) {
                session.initializing = false;
                session.idleSince = undefined;
            }
            res.removeListener('close', disconnected);
        }
    };

    app.all('/mcp', mcpHandler);
    app.get('/sse', mcpHandler);
    app.post('/messages', mcpHandler);

    const listener = app.listen(port, host);
    await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.once('listening', () => {
            listener.removeListener('error', reject);
            resolve();
        });
    });
    const address = listener.address() as AddressInfo;
    console.error(
        `[MCP HTTP] Server listening on http://${host}:${address.port}/mcp`,
    );
    // One bounded sweep per listener; no per-session timers or resource lease changes.
    const idleTimer = setInterval(sweepIdle, Math.min(idleTimeoutMs, 60_000));
    idleTimer.unref();
    let stopped: Promise<void> | undefined;
    return {
        port: address.port,
        stop: () => {
            if (stopped) return stopped;
            stopping = true;
            clearInterval(idleTimer);
            // Stop accepting first, but keep the listener alive until owned cleanup settles.
            const listenerClosed = new Promise<void>((resolve, reject) => {
                listener.close((error) => (error ? reject(error) : resolve()));
            });
            stopped = (async () => {
                const results = await Promise.allSettled(
                    [...sessions].map(([id, session]) =>
                        closeSession(id, session),
                    ),
                );
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
