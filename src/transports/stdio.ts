import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { FifoTransport } from '../data/FifoTransport.js';
import {
    DATA_FRAME_METHOD,
    StdioDataSession,
} from '../data/StdioDataSession.js';
import { configureExtensionData } from '../extensions/runtime.js';
import { registerServerCleanup } from '../utils/server-lifecycle.js';
import { serveConnection } from './serveConnection.js';

export function redirectStdioLogsToStderr(): void {
    // MCP stdio reserves stdout for JSON-RPC frames.
    console.log = (...args) => console.error(...args);
}

export async function startStdioServer(serverFactory: () => McpServer) {
    const transport = new FifoTransport(new StdioServerTransport());
    const connection = serveConnection(
        () => {
            const server = serverFactory();
            let session: StdioDataSession | undefined;
            server.server.setNotificationHandler(
                DATA_FRAME_METHOD,
                { params: z.unknown() },
                (params) => {
                    session?.handleNotification(params);
                },
            );
            registerServerCleanup(server, () => {
                server.server.removeNotificationHandler(DATA_FRAME_METHOD);
                session?.close();
                session = undefined;
            });
            configureExtensionData(
                server,
                (binding, accept, signal, _origin, supportsPurpose) => {
                    signal.throwIfAborted();
                    session = new StdioDataSession({
                        role: 'remote',
                        binding,
                        accept,
                        supportsPurpose,
                        sendNotification: (params) =>
                            server.server.notification({
                                method: DATA_FRAME_METHOD,
                                params,
                            }),
                    });
                    return { session };
                },
                'stdio',
            );
            return server;
        },
        transport,
        () => console.error('[staff-mcp] Stdio control transport error.'),
    );
    let stopping: Promise<void> | undefined;
    let inputError: Error | undefined;
    const stop = () => {
        stopping ??= Promise.resolve().then(async () => {
            process.stdin.removeListener('end', onStdinClosed);
            process.stdin.removeListener('close', onStdinClosed);
            process.stdin.removeListener('error', onStdinError);
            await connection.close();
            if (inputError) throw inputError;
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
    process.stdin.once('end', onStdinClosed);
    process.stdin.once('close', onStdinClosed);
    process.stdin.once('error', onStdinError);
    const closed = connection.closed.then(() => stop());
    void closed.catch(() => {});
    try {
        await connection.started;
        if (process.stdin.readableEnded || process.stdin.destroyed)
            onStdinClosed();
        console.error('MCP Server (Stdio) is running.');
        return { stop, closed };
    } catch (error) {
        await stop().catch(() => {});
        throw error;
    }
}
