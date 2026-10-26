import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type Cleanup = () => void | Promise<void>;
interface Lifecycle {
    cleanups: Cleanup[];
    cleanup?: Promise<void>;
    closing?: Promise<void>;
}
const lifecycles = new WeakMap<McpServer, Lifecycle>();

function checkResults(results: PromiseSettledResult<unknown>[]) {
    const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
    if (errors.length)
        throw new AggregateError(errors, 'Server cleanup failed');
}

/** One server owns one lifetime. Cleanup must not await server.close() itself. */
export function registerServerCleanup(
    server: McpServer,
    cleanup: Cleanup,
): void {
    let lifecycle = lifecycles.get(server);
    if (!lifecycle) {
        const state: Lifecycle = { cleanups: [] };
        lifecycle = state;
        lifecycles.set(server, state);
        const startCleanup = () => {
            if (!state.cleanup) {
                // Invoke every callback immediately, including synchronous fences,
                // without allowing one failure to skip the remaining owners.
                state.cleanup = Promise.allSettled(
                    state.cleanups.map(async (run) => {
                        await run();
                    }),
                ).then(checkResults);
                // Transport onclose cannot await; explicit close observes this same result.
                void state.cleanup.catch(() => {});
            }
            return state.cleanup;
        };
        const previousClose = server.server.onclose;
        server.server.onclose = () => {
            startCleanup();
            previousClose?.call(server.server);
        };
        const close = server.close.bind(server);
        server.close = () => {
            if (!state.closing) {
                // Defer SDK close until the shared promise is installed. onclose
                // only starts cleanup and never waits for this close operation.
                const transportClose = Promise.resolve().then(close);
                state.closing = Promise.allSettled([
                    startCleanup(),
                    transportClose,
                ]).then(checkResults);
            }
            return state.closing;
        };
    }
    if (lifecycle.cleanup)
        throw new Error('Cannot register cleanup on a closed server');
    lifecycle.cleanups.push(cleanup);
}
