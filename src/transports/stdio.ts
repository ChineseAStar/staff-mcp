import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HttpDataSession } from '../data/HttpDataSession.js';
import { handleNodeRequest } from '../data/node.js';
import { readDockerDataBaseUrl } from '../data-stdio-docker.js';
import { configureExtensionData } from '../extensions/runtime.js';
import { extensionError } from '../extensions/protocol.js';

export function redirectStdioLogsToStderr(): void {
    // MCP stdio reserves stdout for JSON-RPC frames.
    console.log = (...args) => console.error(...args);
}

export async function startStdioServer(server: McpServer) {
    configureExtensionData(
        server,
        async (binding, accept, signal, origin, supportsPurpose) => {
            if (origin !== undefined)
                extensionError(
                    'INVALID_PARAMS',
                    'Stdio data does not accept an advertised origin',
                );
            const dockerBase = await readDockerDataBaseUrl();
            signal.throwIfAborted();
            const host = dockerBase
                ? process.env.STAFF_MCP_DATA_HOST
                : '127.0.0.1';
            const port = dockerBase
                ? Number(process.env.STAFF_MCP_DATA_PORT)
                : 0;
            if (dockerBase && (host !== '0.0.0.0' || port !== 39173))
                throw new Error('Invalid Docker data listener configuration.');
            let session: HttpDataSession | undefined;
            const listener = createServer((request, response) => {
                if (!session) {
                    response.writeHead(503);
                    response.end();
                    return;
                }
                void handleNodeRequest(session, request, response).then(
                    (handled) => {
                        if (!handled) {
                            response.writeHead(404);
                            response.end();
                        }
                    },
                );
            });
            const close = () =>
                new Promise<void>((resolve) => {
                    listener.closeAllConnections();
                    listener.close(() => resolve());
                });
            const onAbort = () => {
                void close();
            };
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                await new Promise<void>((resolve, reject) => {
                    listener.once('error', reject);
                    listener.listen(port, host, () => {
                        listener.removeListener('error', reject);
                        resolve();
                    });
                });
                signal.throwIfAborted();
                const localBase = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
                const endpoint = `${dockerBase ?? localBase}/mcp/data/${binding}`;
                session = new HttpDataSession({
                    role: 'remote',
                    binding,
                    endpoint,
                    accept,
                    supportsPurpose,
                    // Listener mode must never follow a peer-supplied outbound descriptor.
                    fetch: async () => {
                        throw new Error(
                            'Outbound data is unavailable in stdio listener mode',
                        );
                    },
                    validateEndpoint: () => {
                        throw new Error(
                            'Outbound data endpoint is unavailable in stdio listener mode',
                        );
                    },
                });
                return {
                    session,
                    endpoint,
                    close: () => {
                        signal.removeEventListener('abort', onAbort);
                        return close();
                    },
                };
            } catch (error) {
                signal.removeEventListener('abort', onAbort);
                session?.close();
                await close();
                throw error;
            }
        },
    );
    const transport = new StdioServerTransport();
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    // EOF may arrive before the caller receives the controller.
    void closed.catch(() => {});
    let stopping: Promise<void> | undefined;
    let inputError: Error | undefined;
    const stop = () => {
        stopping ??= Promise.resolve().then(async () => {
            process.stdin.removeListener('end', onStdinClosed);
            process.stdin.removeListener('close', onStdinClosed);
            process.stdin.removeListener('error', onStdinError);
            try {
                await server.close();
                if (inputError) throw inputError;
                resolveClosed();
            } catch (error) {
                rejectClosed(error);
                throw error;
            }
        });
        return stopping;
    };
    const onStdinClosed = () => {
        void stop().catch(() => {});
    };
    const onStdinError = () => {
        inputError = new Error('MCP input stream failed.');
        onStdinClosed();
    };
    transport.onclose = onStdinClosed;
    process.stdin.once('end', onStdinClosed);
    process.stdin.once('close', onStdinClosed);
    process.stdin.once('error', onStdinError);
    try {
        await server.connect(transport);
        if (process.stdin.readableEnded || process.stdin.destroyed)
            onStdinClosed();
        console.error('MCP Server (Stdio) is running.');
        return { stop, closed };
    } catch (error) {
        await stop().catch(() => {});
        throw error;
    }
}
