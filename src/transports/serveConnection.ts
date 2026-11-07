import type { McpServer, Transport } from '@modelcontextprotocol/server';

/** One legacy SDK server owns the control connection and its cleanup. */
export function serveConnection(
    factory: () => McpServer,
    transport: Transport,
    onerror: (error: Error) => void,
) {
    const server = factory();
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    void closed.catch(() => {});
    let stopping: Promise<void> | undefined;
    const close = () => {
        stopping ??= Promise.resolve().then(async () => {
            // Await owner cleanup even when the peer closed the transport first.
            // Also release the raw wire after a failed start or server close.
            const results = await Promise.allSettled([
                server.close(),
                transport.close(),
            ]);
            const errors = results
                .filter((result) => result.status === 'rejected')
                .map((result) => result.reason);
            if (errors.length)
                throw new AggregateError(
                    errors,
                    'Control connection cleanup failed',
                );
        });
        void stopping.then(resolveClosed, rejectClosed);
        return stopping;
    };
    const previousClose = transport.onclose;
    transport.onclose = () => {
        try {
            previousClose?.();
        } finally {
            void close().catch(() => {});
        }
    };
    transport.onerror = onerror;
    // Direct connect deliberately keeps the SDK's initialize/session semantics.
    // Modern discovery/subscription serving is deferred to the next phase.
    const started = server.connect(transport);
    void started.catch(() => close().catch(() => {}));
    return { started, closed, close };
}
