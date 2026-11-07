import type { McpServer, Transport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ServerFactoryContext } from '../server.js';
import { ResourceSubscriptions } from './ResourceSubscriptions.js';

/** The SDK selects the era; this owner awaits every instance's real cleanup. */
export function serveConnection(
    factory: (context: ServerFactoryContext) => McpServer,
    transport: Transport,
    onerror: (error: Error) => void,
    validateResourceSubscription?: (uri: string) => Promise<void>,
) {
    const subscriptions = new ResourceSubscriptions(
        transport,
        validateResourceSubscription,
    );
    transport = subscriptions;
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
    });
    void started.catch(() => {});
    const startTransport = transport.start.bind(transport);
    transport.start = () => {
        const starting = Promise.resolve().then(startTransport);
        void starting.then(resolveStarted, rejectStarted);
        return starting;
    };
    // Explicit stop must also release a wire whose start is still pending.
    const closeTransport = transport.close.bind(transport);
    let transportClosing: Promise<void> | undefined;
    transport.close = () =>
        (transportClosing ??= Promise.resolve().then(closeTransport));

    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    void closed.catch(() => {});
    const owners: McpServer[] = [];
    const connecting: Promise<void>[] = [];
    let stopping: Promise<void> | undefined;
    const close = () => {
        stopping ??= Promise.resolve().then(async () => {
            // SDK peer-close is fire-and-forget, and handle.close() alone does
            // not await an already closing/discarded or still connecting owner.
            const results = await Promise.allSettled([
                transport.close(),
                handle.close(),
            ]);
            await Promise.allSettled(connecting);
            results.push(
                ...(await Promise.allSettled(
                    owners.map((server) => server.close()),
                )),
            );
            const errors = [
                ...new Set(
                    results
                        .filter((result) => result.status === 'rejected')
                        .map((result) => result.reason),
                ),
            ];
            if (errors.length)
                throw new AggregateError(
                    errors,
                    'Control connection cleanup failed',
                );
        });
        void stopping.then(resolveClosed, rejectClosed);
        return stopping;
    };
    const handle = serveStdio(
        (context) => {
            if (stopping) throw new Error('Control connection closed');
            const server = factory({
                ...context,
                resourceSubscriptions: subscriptions.resourceSubscriptions,
            });
            owners.push(server);
            const closeServer = server.close.bind(server);
            let serverClosing: Promise<void> | undefined;
            server.close = () =>
                (serverClosing ??= Promise.resolve().then(closeServer));
            const connect = server.connect.bind(server);
            server.connect = (channel) => {
                const pending = Promise.resolve().then(() => {
                    if (stopping) throw new Error('Control connection closed');
                    return connect(channel);
                });
                connecting.push(pending);
                void pending.catch(() => close().catch(() => {}));
                return pending;
            };
            return server;
        },
        { transport, onerror },
    );
    const previousClose = transport.onclose;
    transport.onclose = () => {
        try {
            previousClose?.();
        } finally {
            void close().catch(() => {});
        }
    };
    void started.catch(() => close().catch(() => {}));
    return { started, closed, close };
}
