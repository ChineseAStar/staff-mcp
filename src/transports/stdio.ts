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
    configureExtensionData(server, async (binding, accept, signal, origin, supportsPurpose) => {
        if (origin !== undefined)
            extensionError(
                'INVALID_PARAMS',
                'Stdio data does not accept an advertised origin',
            );
        const dockerBase = await readDockerDataBaseUrl();
        signal.throwIfAborted();
        const host = dockerBase ? process.env.STAFF_MCP_DATA_HOST : '127.0.0.1';
        const port = dockerBase ? Number(process.env.STAFF_MCP_DATA_PORT) : 0;
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
        const close = () => {
            listener.closeAllConnections();
            listener.close();
        };
        signal.addEventListener('abort', close, { once: true });
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
                    signal.removeEventListener('abort', close);
                    close();
                },
            };
        } catch (error) {
            signal.removeEventListener('abort', close);
            session?.close();
            close();
            throw error;
        }
    });
    const transport = new StdioServerTransport();
    try {
        await server.connect(transport);
        console.error('MCP Server (Stdio) is running.');
        // SDK stdio does not observe EOF. Close session-owned resources first.
        let closing = false;
        const onStdinClosed = () => {
            if (closing) return;
            closing = true;
            console.error(
                '[staff-mcp] stdin closed (client disconnected), shutting down.',
            );
            void server.close().finally(() => process.exit(0));
        };
        process.stdin.on('end', onStdinClosed);
        process.stdin.on('close', onStdinClosed);
    } catch (error) {
        console.error('Stdio connection failed:', error);
        await server.close().catch(() => {});
        process.exit(1);
    }
}
