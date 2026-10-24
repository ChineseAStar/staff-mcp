import { HttpDataSession } from '../data/HttpDataSession.js';
import { handleNodeRequest } from '../data/node.js';
import { configureExtensionData } from '../extensions/runtime.js';
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';

export function getHttpAuthToken(token?: string): string | undefined {
    if (token === undefined) return undefined;
    if (!token || /\s/.test(token)) {
        throw new Error(
            '--http-token must be non-empty and contain no whitespace when provided.',
        );
    }
    return token;
}

export async function startHttpServer(
    serverFactory: () => McpServer,
    port: number,
    host: string = '0.0.0.0',
    token?: string,
) {
    const authToken = getHttpAuthToken(token);
    const app = express();

    // CORS preflight is public and never reaches MCP session handling.
    app.use(cors());

    // Session-owned public data endpoints must bypass the MCP JSON parser.
    const dataSessions = new Map<string, HttpDataSession>();
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
        void handleNodeRequest(session, req, res).then((handled) => {
            if (!handled) res.status(404).end();
        });
    });

    // When configured, authenticate before parsing bodies or accessing sessions.
    if (authToken !== undefined) {
        const expectedToken = Buffer.from(authToken);
        app.use(['/mcp', '/sse', '/messages'], (req, res, next) => {
            const match = /^Bearer +(\S+)$/i.exec(
                req.headers.authorization ?? '',
            );
            const token = Buffer.from(match?.[1] ?? '');
            if (
                token.length !== expectedToken.length ||
                !timingSafeEqual(token, expectedToken)
            ) {
                res.setHeader('WWW-Authenticate', 'Bearer realm="staff-mcp"');
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
            next();
        });
    }

    // Necessary for processing JSON-RPC messages (POST).
    // Preserve ordinary large tool results; binary files use the separate prepared endpoint.
    app.use(express.json({ limit: '50mb' }));

    // === Session Pool ===
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const mcpHandler = async (req: express.Request, res: express.Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        // 1. 尝试复用已有会话
        if (sessionId && sessions.has(sessionId)) {
            const t = sessions.get(sessionId)!;
            try {
                await t.handleRequest(req, res, req.body);
            } catch (error) {
                console.error('[MCP HTTP Error]:', error);
                if (!res.headersSent) {
                    res.status(500).json({
                        error: 'Internal Server Error',
                        message:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                }
            }
            return;
        }

        // 2. 没有对应会话，或者是一个新的 GET 请求，创建新的
        const newSessionId = randomUUID();
        const server = serverFactory();

        // 如果客户端带了旧的、已失效的 sessionId 试图重连，
        // 必须从 headers 中抹除，否则底层 SDK 会因为它与新分配的 newSessionId 不一致而直接报错 400
        if (sessionId) {
            delete req.headers['mcp-session-id'];
            delete req.headers['last-event-id'];
        }

        const t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            enableJsonResponse: true,
        });

        // 监听关闭事件，正常触发时清理自身
        t.onclose = () => {
            console.log(`[HTTP] Session Closed: ${newSessionId}`);
            sessions.delete(newSessionId);
        };

        configureExtensionData(server, (binding, accept, signal, origin, supportsPurpose) => {
            signal.throwIfAborted();
            if (dataSessions.has(binding))
                throw new Error('Data binding already exists.');
            const authority = req.get('host');
            if (!authority)
                throw new Error('MCP HTTP Host header is required.');
            const endpoint = new URL(
                `/mcp/data/${binding}`,
                origin ?? `${req.protocol}://${authority}`,
            ).href;
            const session = new HttpDataSession({
                role: 'remote',
                binding,
                endpoint,
                accept,
                supportsPurpose,
                // This transport only serves bytes; reverse injects its own outbound binding.
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
            dataSessions.set(binding, session);
            return {
                session,
                endpoint,
                close: () => {
                    if (dataSessions.get(binding) === session)
                        dataSessions.delete(binding);
                },
            };
        });
        await server.connect(t);
        sessions.set(newSessionId, t);

        try {
            await t.handleRequest(req, res, req.body);
        } catch (error) {
            console.error('[MCP HTTP Error]:', error);
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'Internal Server Error',
                    message:
                        error instanceof Error ? error.message : String(error),
                });
            }
        }
    };

    // Route for all MCP interactions.
    app.all('/mcp', mcpHandler);

    // Standard fallbacks
    app.get('/sse', mcpHandler);
    app.post('/messages', mcpHandler);

    return new Promise<void>((resolve) => {
        app.listen(port, host, () => {
            console.error(
                `[MCP HTTP] Server listening on http://${host}:${port}/mcp`,
            );
            console.error(`[MCP HTTP] JSON Response enabled: true`);
            resolve();
        });
    });
}
