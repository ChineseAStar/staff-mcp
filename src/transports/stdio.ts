import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { ServerFactory } from '../server.js';
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

export async function startStdioServer(serverFactory: ServerFactory) {
    const transport = new FifoTransport(new StdioServerTransport());
    const connection = serveConnection(
        (context) => {
            const server = serverFactory(context);
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
        serverFactory.validateResourceSubscription,
    );
    let stopping: Promise<void> | undefined;
    let inputError: Error | undefined;
    const stop = () => {
        stopping ??= (async () => {
            process.stdin.removeListener('end', onStdinClosed);
            process.stdin.removeListener('close', onStdinClosed);
            process.stdin.removeListener('error', onStdinError);
            const results = await Promise.allSettled([
                connection.close(),
                serverFactory.close?.(),
            ]);
            const failures = results.filter(
                (result) => result.status === 'rejected',
            );
            if (failures.length)
                throw new AggregateError(
                    failures.map((result) => result.reason),
                    'Stdio cleanup failed',
                );
            if (inputError) throw inputError;
        })();
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
