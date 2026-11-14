import { channel } from 'node:diagnostics_channel';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

type BodyBudget = {
    allow: () => void;
    cancel?: () => void;
};

const requests = new WeakMap<IncomingMessage, BodyBudget>();

/** Install before listen/body middleware; the data adapter admits native requests explicitly. */
export function installRequestPolicy(server: Server): () => void {
    const originalTimeout = server.requestTimeout;
    const active = new Set<BodyBudget>();
    let disposed = false;
    const starts = channel('http.server.request.start');
    const track = (event: unknown) => {
        const {
            request,
            response,
            server: owner,
        } = event as {
            request: IncomingMessage;
            response: ServerResponse;
            server: Server;
        };
        if (owner !== server) return;
        let expired = false;
        const budget: BodyBudget = {
            allow: () => {
                if (disposed)
                    throw new Error('HTTP request policy has been disposed');
                if (request.method !== 'PUT')
                    throw new Error(
                        'Only raw PUT uploads can outlive the body deadline',
                    );
                if (
                    expired ||
                    request.aborted ||
                    (request.destroyed && !request.complete)
                )
                    throw new Error(
                        'HTTP request body deadline has already ended',
                    );
                budget.cancel?.();
            },
        };
        requests.set(request, budget);
        if (request.complete || originalTimeout === 0) return;
        const cancel = () => {
            clearTimeout(timer);
            request.removeListener('end', cancel);
            request.removeListener('aborted', cancel);
            request.removeListener('close', cancel);
            active.delete(budget);
            budget.cancel = undefined;
        };
        const timer = setTimeout(() => {
            cancel();
            if (request.complete || request.destroyed) return;
            expired = true;
            if (!response.headersSent && !response.destroyed) {
                response.writeHead(408, { Connection: 'close' });
                response.end();
            }
            // A finished response must not exempt its still-incomplete body.
            request.socket.destroy();
        }, originalTimeout);
        timer.unref();
        budget.cancel = cancel;
        active.add(budget);
        request.once('end', cancel);
        request.once('aborted', cancel);
        request.once('close', cancel);
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        starts.unsubscribe(track);
        server.removeListener('close', dispose);
        for (const budget of active) budget.cancel?.();
        if (server.requestTimeout === 0)
            server.requestTimeout = originalTimeout;
    };
    // Keep headersTimeout and socket/keepalive limits unchanged.
    server.requestTimeout = 0;
    // The diagnostic precedes Expect/dropRequest branches that skip request events.
    starts.subscribe(track);
    server.once('close', dispose);
    return dispose;
}

/** Called by HttpDataSession only after auth, ticket, claim and encoding checks. */
export function allowLongRequestBody(request: IncomingMessage): void {
    const budget = requests.get(request);
    if (!budget)
        throw new Error(
            'HTTP request policy is not installed for this request',
        );
    budget.allow();
}
