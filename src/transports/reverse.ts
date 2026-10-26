import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { configureExtensionData } from '../extensions/runtime.js';
import { HttpDataSession } from '../data/HttpDataSession.js';
import { ReverseSseTransport } from '../reverse/SseTransport.js';
import {
    createReverseHttp,
    reverseProxyUrl,
    validateReverseUrl,
} from '../reverse/http.js';

export { reverseProxyUrl, validateReverseUrl } from '../reverse/http.js';

export interface ReverseServerOptions {
    proxy?: string;
    connectTimeout?: number;
    initializationTimeout?: number;
    heartbeat?: { readTimeout?: number };
    reconnect?: {
        enabled?: boolean;
        initialDelay?: number;
        maxDelay?: number;
        stableConnectionMs?: number;
    };
    logger?: {
        info(message: string): void;
        warn(message: string): void;
        error(message: string): void;
    };
}
export interface ReverseController {
    stop(): Promise<void>;
    readonly closed: Promise<void>;
}

/** New HTTP pool, SDK transport and data resources per attempt; never replay requests or input. */
export async function startReverseServer(
    serverFactory: () => McpServer,
    value: string,
    token: string,
    name: string,
    options: ReverseServerOptions = {},
): Promise<ReverseController> {
    const url = validateReverseUrl(value);
    const proxy = reverseProxyUrl(url, options.proxy);
    if (!token || /\s/.test(token) || token.length > 4096)
        throw new Error('Invalid reverse token.');
    if (!name || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name))
        throw new Error('Invalid reverse server name.');
    const log = options.logger ?? {
        info: (message: string) =>
            console.error(`[staff-mcp][reverse] ${message}`),
        warn: (message: string) =>
            console.error(`[staff-mcp][reverse] ${message}`),
        error: (message: string) =>
            console.error(`[staff-mcp][reverse] ${message}`),
    };
    if (url.protocol === 'http:')
        log.warn(
            'Explicit HTTP reverse control uses plaintext; use HTTPS on untrusted networks.',
        );
    const abort = new AbortController();
    let active: ReverseSseTransport | undefined;

    let backoff = options.reconnect?.initialDelay ?? 1000;
    const run = async () => {
        while (!abort.signal.aborted) {
            let server: McpServer | undefined;
            let initializedAt: number | undefined;
            let previousInitialized: (() => void) | undefined;
            let initializationTimer: NodeJS.Timeout | undefined;
            const attempt = new AbortController();
            const stopped = () => {
                attempt.abort();
                void active?.close();
            };
            abort.signal.addEventListener('abort', stopped, { once: true });
            const http = createReverseHttp(url, proxy, attempt.signal);
            const transport = new ReverseSseTransport(
                url,
                { Authorization: `Bearer ${token}`, 'X-MCP-Server-Name': name },
                http.fetch,
                options.connectTimeout,
                options.heartbeat?.readTimeout,
            );
            transport.ondiagnostic = (detail) => {
                log.warn(`Slow control POST: ${JSON.stringify(detail)}`);
            };
            active = transport;
            try {
                server = serverFactory();
                configureExtensionData(
                    server,
                    (binding, accept, signal, origin, supportsPurpose) => {
                        if (origin !== undefined)
                            throw new Error(
                                'Reverse data does not accept an advertised origin',
                            );
                        const sessionId = transport.sessionId;
                        if (
                            !sessionId ||
                            attempt.signal.aborted ||
                            signal.aborted
                        )
                            throw new Error(
                                'Reverse data control session unavailable',
                            );
                        const expected = new URL(url.href);
                        expected.pathname =
                            url.pathname.replace(/\/$/, '') +
                            '/data/' +
                            sessionId;
                        return {
                            session: new HttpDataSession({
                                role: 'remote',
                                binding,
                                accept,
                                supportsPurpose,
                                fetch: http.fetch,
                                resolveEndpoint: (endpoint) => {
                                    // Match before URL parsing can normalize an unsafe spelling.
                                    if (
                                        endpoint !== expected.pathname &&
                                        endpoint !== expected.href
                                    )
                                        throw new Error(
                                            'Reverse data endpoint rejected',
                                        );
                                    return new URL(endpoint, url);
                                },
                                validateEndpoint: (endpoint) => {
                                    if (
                                        endpoint.origin !== expected.origin ||
                                        endpoint.pathname !==
                                            expected.pathname ||
                                        endpoint.username ||
                                        endpoint.password ||
                                        endpoint.search ||
                                        endpoint.hash
                                    )
                                        throw new Error(
                                            'Reverse data endpoint rejected',
                                        );
                                },
                            }),
                        };
                    },
                );
                previousInitialized = server.server.oninitialized;
                server.server.oninitialized = () => {
                    previousInitialized?.();
                    initializedAt = performance.now();
                    clearTimeout(initializationTimer);
                    log.info('MCP initialized on a new SSE session.');
                };
                await server.connect(transport);
                // start() completes once the SSE endpoint is admitted; only then start the initialization deadline.
                if (initializedAt === undefined) {
                    initializationTimer = setTimeout(() => {
                        log.warn(
                            'Control connection closed: initialization-timeout.',
                        );
                        void transport.close();
                    }, options.initializationTimeout ?? 15000);
                    initializationTimer.unref();
                }
                await transport.closed;
            } catch {
                if (!abort.signal.aborted)
                    log.warn(
                        'Connection attempt ended before readiness or control connection closed.',
                    );
            } finally {
                if (transport.failure) {
                    log.warn(
                        `Control connection closed: ${JSON.stringify(transport.failure)}`,
                    );
                }
                clearTimeout(initializationTimer);
                await transport.close().catch(() => {});
                attempt.abort();
                await http.close().catch(() => {});
                abort.signal.removeEventListener('abort', stopped);
                await server?.close();
                if (server) server.server.oninitialized = previousInitialized;
                active = undefined;
            }
            if (abort.signal.aborted || options.reconnect?.enabled === false)
                break;
            if (
                initializedAt !== undefined &&
                performance.now() - initializedAt >=
                    (options.reconnect?.stableConnectionMs ?? 30000)
            )
                backoff = options.reconnect?.initialDelay ?? 1000;
            log.info(
                'Disconnected; retrying with a new session and no replay.',
            );
            try {
                await delay(backoff, undefined, { signal: abort.signal });
            } catch {
                break;
            }
            backoff = Math.min(
                options.reconnect?.maxDelay ?? 30000,
                backoff * 2,
            );
        }
    };
    const closed = run();
    return {
        closed,
        stop: async () => {
            abort.abort();
            await active?.close().catch(() => {});
            await closed;
        },
    };
}
