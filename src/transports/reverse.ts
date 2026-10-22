import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { selectProxyForOrigin } from '../utils/proxy.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { performance } from 'node:perf_hooks';
import { checkServerIdentity } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionTransport } from '../transport-v1/ExtensionTransport.js';
import { WIRE } from '../transport-v1/Wire.js';

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

export function validateReverseUrl(value: string): URL {
    const url = new URL(value);
    if (
        !['ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error(
            'Reverse URL must be an explicit WS/WSS endpoint without credentials, query or fragment.',
        );
    if (
        url.protocol !== 'wss:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
        throw new Error(
            'Non-loopback reverse connections require WSS with certificate verification.',
        );
    return url;
}

/** Apply the same corporate proxy / NO_PROXY routing rules as ordinary outbound fetch. */
export function reverseProxyUrl(
    url: URL,
    explicit?: string,
    env = process.env,
): URL | undefined {
    const origin = new URL(url);
    origin.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    const selected =
        explicit ??
        selectProxyForOrigin(origin, {
            httpProxy: env.HTTP_PROXY || env.http_proxy,
            httpsProxy: env.HTTPS_PROXY || env.https_proxy,
            noProxy: env.NO_PROXY || env.no_proxy,
        });
    if (selected === null || selected === undefined) return undefined;
    try {
        const proxy = new URL(selected);
        if (
            !['http:', 'https:'].includes(proxy.protocol) ||
            proxy.search ||
            proxy.hash
        )
            throw new Error('Invalid proxy');
        decodeURIComponent(proxy.username);
        decodeURIComponent(proxy.password);
        return proxy;
    } catch {
        // Do not expose a URL containing credentials through startup errors.
        throw new Error('Reverse proxy must be a valid HTTP(S) proxy URL.');
    }
}

function proxyAgent(proxy: URL, signal: AbortSignal) {
    // The agent logs its URL in DEBUG mode. Credentials belong only in CONNECT headers.
    const address = new URL(proxy);
    address.pathname = '/';
    let authorization: string | undefined;
    if (address.username || address.password) {
        try {
            authorization =
                'Basic ' +
                Buffer.from(
                    `${decodeURIComponent(address.username)}:${decodeURIComponent(address.password)}`,
                ).toString('base64');
        } catch {
            throw new Error('Invalid proxy credential encoding.');
        }
        address.username = '';
        address.password = '';
    }
    return new HttpsProxyAgent(address, {
        headers: authorization ? { 'Proxy-Authorization': authorization } : {},
        rejectUnauthorized: true,
        // Covers a stalled CONNECT before ws has received a socket, including stop().
        signal,
    });
}

/** Fresh SDK transport binding, epoch and resources per attempt; no request or input replay. */
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
    const abort = new AbortController();
    let active: WebSocket | undefined;
    let activeServer: McpServer | undefined;
    // Tool registration starts project watchers. Reuse registrations, never transport resources.
    let registeredServer: McpServer | undefined;
    let backoff = options.reconnect?.initialDelay ?? 1000;
    const run = async () => {
        while (!abort.signal.aborted) {
            let transport: ExtensionTransport | undefined;
            let server: McpServer | undefined;
            let initializedAt: number | undefined;
            let previousInitialized: (() => void) | undefined;
            let initializationTimer: NodeJS.Timeout | undefined;
            let heartbeat: NodeJS.Timeout | undefined;
            let connectionTimer: NodeJS.Timeout | undefined;
            let agent: ReturnType<typeof proxyAgent> | undefined;
            const attempt = new AbortController();
            const stopAttempt = () => attempt.abort();
            abort.signal.addEventListener('abort', stopAttempt, { once: true });
            try {
                agent = proxy ? proxyAgent(proxy, attempt.signal) : undefined;
                const identityCheck: typeof checkServerIdentity = (
                    _hostname,
                    certificate,
                ) =>
                    checkServerIdentity(
                        url.hostname.replace(/^\[|\]$/g, ''),
                        certificate,
                    );
                const socketOptions = {
                    agent,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'X-MCP-Server-Name': name,
                    },
                    handshakeTimeout: options.connectTimeout ?? 15000,
                    perMessageDeflate: false,
                    maxPayload: WIRE.mcp,
                    followRedirects: false,
                    rejectUnauthorized: true,
                    // CONNECT agents omit the target host when upgrading an existing socket.
                    // Verify the configured gateway identity, including IP SANs, not localhost.
                    checkServerIdentity: identityCheck,
                };
                // Use the Node request-options overload: @types/ws incorrectly types the
                // TLS identity callback as returning boolean instead of Error | undefined.
                const ws = new WebSocket(url, WIRE.protocol, socketOptions);
                active = ws;
                const timeout = options.connectTimeout ?? 15000;
                if (timeout > 0) {
                    connectionTimer = setTimeout(() => {
                        attempt.abort();
                        ws.terminate();
                    }, timeout);
                    connectionTimer.unref();
                }
                transport = await new Promise<ExtensionTransport>(
                    (resolve, reject) => {
                        const failed = () =>
                            reject(new Error('REVERSE_CONNECT_FAILED'));
                        const closed = () =>
                            reject(new Error('REVERSE_CONNECT_CLOSED'));
                        ws.once('error', failed);
                        ws.once('close', closed);
                        ws.once('open', () => {
                            ws.removeListener('error', failed);
                            ws.removeListener('close', closed);
                            resolve(new ExtensionTransport(ws, 'remote'));
                        });
                    },
                );
                clearTimeout(connectionTimer);
                await transport.waitUntilPaired();
                if (abort.signal.aborted) break;
                server = registeredServer ??= serverFactory();
                activeServer = server;
                previousInitialized = server.server.oninitialized;
                server.server.oninitialized = () => {
                    previousInitialized?.();
                    initializedAt = performance.now();
                    clearTimeout(initializationTimer);
                    log.info('MCP initialized on a new paired epoch.');
                };
                initializationTimer = setTimeout(
                    () => ws.terminate(),
                    options.initializationTimeout ?? 15000,
                );
                initializationTimer.unref();
                const readTimeout = options.heartbeat?.readTimeout ?? 45000;
                let lastPong = performance.now();
                ws.on('pong', () => {
                    lastPong = performance.now();
                });
                heartbeat = setInterval(
                    () => {
                        if (performance.now() - lastPong >= readTimeout) {
                            ws.terminate();
                            return;
                        }
                        if (ws.readyState === WebSocket.OPEN)
                            ws.ping(undefined, undefined, () => {});
                    },
                    Math.max(250, Math.min(10000, Math.floor(readTimeout / 3))),
                );
                heartbeat.unref();
                await server.connect(transport);
                await transport.closed;
            } catch {
                // No raw exceptions, frames, headers or URL are dumped even in debug mode.
                if (!abort.signal.aborted)
                    log.warn(
                        'Connection attempt ended before readiness or transport closed.',
                    );
            } finally {
                clearTimeout(connectionTimer);
                clearTimeout(initializationTimer);
                clearInterval(heartbeat);
                await transport?.close().catch(() => {});
                active?.terminate();
                attempt.abort();
                agent?.destroy();
                abort.signal.removeEventListener('abort', stopAttempt);
                await server?.close().catch(() => {});
                if (server) server.server.oninitialized = previousInitialized;
                active = undefined;
                activeServer = undefined;
            }
            if (abort.signal.aborted || options.reconnect?.enabled === false)
                break;
            if (
                initializedAt !== undefined &&
                performance.now() - initializedAt >=
                    (options.reconnect?.stableConnectionMs ?? 30000)
            )
                backoff = options.reconnect?.initialDelay ?? 1000;
            log.info('Disconnected; retrying with a new epoch and no replay.');
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
            active?.terminate();
            await activeServer?.close().catch(() => {});
            await closed;
        },
    };
}
