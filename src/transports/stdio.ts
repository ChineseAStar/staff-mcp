import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FifoTransport } from '../data/FifoTransport.js';
import {
    DATA_FRAME_METHOD,
    StdioDataSession,
} from '../data/StdioDataSession.js';
import { configureExtensionData } from '../extensions/runtime.js';
import { registerServerCleanup } from '../utils/server-lifecycle.js';

export function redirectStdioLogsToStderr(): void {
    // MCP stdio reserves stdout for JSON-RPC frames.
    console.log = (...args) => console.error(...args);
}

export async function startStdioServer(server: McpServer) {
    let session: StdioDataSession | undefined;
    server.server.setNotificationHandler(
        z.object({
            method: z.literal(DATA_FRAME_METHOD),
            params: z.unknown(),
        }),
        (notification) => {
            session?.handleNotification(notification.params);
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
    const transport = new FifoTransport(new StdioServerTransport());
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
