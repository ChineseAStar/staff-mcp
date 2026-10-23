import { once } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpDataSession } from './HttpDataSession.js';

/** Mount before JSON/body middleware. No listener, registry or business ownership here. */
export async function handleNodeRequest(
    session: HttpDataSession,
    request: IncomingMessage,
    response: ServerResponse,
): Promise<boolean> {
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error('HTTP peer disconnected'));
    const responseClosed = () => {
        if (!response.writableFinished) cancel();
    };
    request.once('aborted', cancel);
    response.once('close', responseClosed);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const headers = new Headers();
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
            headers.append(
                request.rawHeaders[index],
                request.rawHeaders[index + 1],
            );
        }
        const init: RequestInit & { duplex?: 'half' } = {
            method: request.method,
            headers,
            signal: abort.signal,
        };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
            init.duplex = 'half';
        }
        // Routing/security is session-owned; Host must never select an external endpoint.
        const webRequest = new Request(
            new URL(request.url ?? '/', 'http://data.invalid'),
            init,
        );
        const result = await session.handleRequest(webRequest);
        if (!result) return false;
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.flushHeaders();
        if (!result.body) {
            response.end();
            return true;
        }
        reader = result.body.getReader();
        let current = await reader.read();
        while (!current.done) {
            // Observe EOF concurrently with drain: HTTP may close the final write
            // without emitting drain. Never retain a lone interactive chunk for lookahead.
            const writable = response.write(current.value);
            const drainAbort = new AbortController();
            const drainSignal = AbortSignal.any([
                abort.signal,
                drainAbort.signal,
            ]);
            const drained = writable
                ? Promise.resolve()
                : once(response, 'drain', { signal: drainSignal });
            void drained.catch(() => {});
            let next: ReadableStreamReadResult<Uint8Array>;
            try {
                next = await reader.read();
                if (!next.done) await drained;
            } finally {
                drainAbort.abort();
            }
            current = next;
        }
        // EOF always calls end immediately, including when the last write returned false.
        response.end();
        return true;
    } catch (error) {
        cancel();
        if (response.headersSent)
            response.destroy(error instanceof Error ? error : undefined);
        else {
            response.writeHead(500, { 'Cache-Control': 'no-store' });
            response.end();
        }
        return true;
    } finally {
        request.removeListener('aborted', cancel);
        // Keep close propagation until the response has really finished, not just end() returned.
        if (response.writableFinished || response.destroyed)
            response.removeListener('close', responseClosed);
        else
            response.once('finish', () =>
                response.removeListener('close', responseClosed),
            );
        if (reader) {
            if (abort.signal.aborted) void reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
}
