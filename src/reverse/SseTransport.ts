import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
    JSONRPCMessageSchema,
    PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const MESSAGE_LIMIT = 4 * 1024 * 1024;
const QUEUE_LIMIT = 8 * 1024 * 1024;
const PING_LIMIT = 32;
const SLOW_POST_MS = 1000;
const DIAGNOSTIC_INTERVAL_MS = 10000;

export interface ReverseControlDiagnostic {
    reason: 'control-post-slow' | 'ping-post-slow';
    bytes: number;
    queuedMs: number;
    elapsedMs: number;
    status: number;
}

export interface ReverseControlFailure {
    reason:
        | 'connect-timeout'
        | 'read-timeout'
        | 'sse-rejected'
        | 'sse-ended'
        | 'sse-read-failed'
        | 'sse-too-large'
        | 'sse-invalid-event'
        | 'control-queue-exceeded'
        | 'message-post-rejected'
        | 'message-post-failed';
    status?: number;
    bytes?: number;
    elapsedMs?: number;
    queuedMs?: number;
    networkCode?: string;
}

/** Only fixed diagnostics, never remote bodies, URLs, headers or exception text. */
class ControlFailure extends Error {
    constructor(readonly detail: ReverseControlFailure) {
        super(`Reverse control failed: ${detail.reason}`);
    }
}

function networkCode(error: unknown): string | undefined {
    const cause = error as {
        code?: unknown;
        cause?: { code?: unknown };
    } | null;
    const code = cause?.cause?.code ?? cause?.code;
    return typeof code === 'string' &&
        /^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET|ABORTED))$/.test(
            code,
        )
        ? code
        : undefined;
}

/** Outbound-only reverse control: SSE receives JSON-RPC, POST sends JSON-RPC. No resume/replay. */
export class ReverseSseTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: Transport['onmessage'];
    ondiagnostic?: (detail: ReverseControlDiagnostic) => void;
    readonly closed: Promise<void>;
    sessionId?: string;
    failure?: ReverseControlFailure;
    private resolveClosed!: () => void;
    private readonly abort = new AbortController();
    private stopped = false;
    private started = false;
    private endpoint?: URL;
    private queue = Promise.resolve();
    private queuedBytes = 0;
    private pingQueue = Promise.resolve();
    private queuedPings = 0;
    // Typed keys keep numeric and string IDs distinct. Entries live only until
    // reply, cancellation, ID reuse or close; no eviction can prioritize a stale ID.
    private readonly pendingPings = new Map<string | number, number>();
    private nextDiagnosticAt = 0;
    private readTimer?: NodeJS.Timeout;
    private readyResolve?: () => void;
    private readyReject?: (error: Error) => void;
    private reader?: ReadableStreamDefaultReader<Uint8Array>;

    constructor(
        private readonly base: URL,
        private readonly headers: Record<string, string>,
        private readonly fetch: typeof globalThis.fetch,
        private readonly connectTimeout = 15000,
        private readonly readTimeout = 45000,
    ) {
        this.closed = new Promise((resolve) => {
            this.resolveClosed = resolve;
        });
    }

    async start(): Promise<void> {
        if (this.started || this.stopped)
            throw new Error('Reverse transport unavailable');
        this.started = true;
        const ready = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        const timer =
            this.connectTimeout > 0
                ? setTimeout(
                      () => this.fail({ reason: 'connect-timeout' }),
                      this.connectTimeout,
                  )
                : undefined;
        timer?.unref();
        void this.read().catch((error) =>
            this.fail(
                error instanceof ControlFailure
                    ? error.detail
                    : {
                          reason: 'sse-read-failed',
                          networkCode: networkCode(error),
                      },
            ),
        );
        try {
            await ready;
        } finally {
            clearTimeout(timer);
        }
    }

    private async read(): Promise<void> {
        const response = await this.fetch(
            this.base.href.replace(/\/$/, '') + '/sse',
            {
                headers: { ...this.headers, Accept: 'text/event-stream' },
                signal: this.abort.signal,
                redirect: 'manual',
            },
        );
        if (
            response.status !== 200 ||
            !response.headers
                .get('content-type')
                ?.startsWith('text/event-stream') ||
            !response.body
        ) {
            await response.body?.cancel();
            throw new ControlFailure({
                reason: 'sse-rejected',
                status: response.status,
            });
        }
        this.reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let line = '';
        let event = 'message';
        let data: string[] = [];
        let blockBytes = 0;
        let afterCR = false;
        const completeLine = () => {
            if (line === '') {
                if (data.length) {
                    try {
                        this.event(event, data.join('\n'));
                    } catch {
                        throw new ControlFailure({
                            reason: 'sse-invalid-event',
                        });
                    }
                }
                event = 'message';
                data = [];
                blockBytes = 0;
            } else if (!line.startsWith(':')) {
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                let value = colon < 0 ? '' : line.slice(colon + 1);
                if (value.startsWith(' ')) value = value.slice(1);
                if (field === 'event') event = value;
                if (field === 'data') data.push(value);
            }
            line = '';
        };
        while (!this.stopped) {
            this.armReadTimeout();
            const part = await this.reader.read();
            if (part.done) throw new ControlFailure({ reason: 'sse-ended' });
            const text = decoder.decode(part.value, { stream: true });
            // Bound complete and partial events before they can grow an unbounded JSON buffer.
            for (const character of text) {
                if (afterCR && character === '\n') {
                    afterCR = false;
                    continue;
                }
                afterCR = character === '\r';
                blockBytes += Buffer.byteLength(character);
                if (blockBytes > MESSAGE_LIMIT + 1024)
                    throw new ControlFailure({
                        reason: 'sse-too-large',
                        bytes: blockBytes,
                    });
                if (character === '\r' || character === '\n') completeLine();
                else line += character;
            }
        }
    }

    private event(event: string, data: string): void {
        if (this.stopped) throw new Error('Reverse transport closed');
        if (event === 'endpoint') {
            if (this.endpoint) throw new Error('Duplicate reverse endpoint');
            const endpoint = new URL(data, this.base);
            const keys = [...endpoint.searchParams.keys()];
            const session = endpoint.searchParams.get('session') ?? '';
            if (
                endpoint.origin !== this.base.origin ||
                endpoint.username ||
                endpoint.password ||
                endpoint.hash ||
                endpoint.pathname !==
                    this.base.pathname.replace(/\/$/, '') + '/message' ||
                keys.length !== 1 ||
                keys[0] !== 'session' ||
                !/^[0-9a-f]{64}$/.test(session)
            )
                throw new Error('Reverse endpoint rejected');
            this.endpoint = endpoint;
            this.sessionId = session;
            this.readyResolve?.();
            return;
        }
        if (event !== 'message' || !this.endpoint)
            throw new Error('Unexpected reverse SSE event');
        const message = JSONRPCMessageSchema.parse(JSON.parse(data));
        if (
            'method' in message &&
            'id' in message &&
            (typeof message.id === 'string' || typeof message.id === 'number')
        ) {
            // Reused IDs are not valid concurrent JSON-RPC requests. Never retain
            // ping priority when a subsequent ordinary request uses the same ID.
            this.takePing(message.id);
            if (PingRequestSchema.safeParse(message).success) {
                const bytes = Buffer.byteLength(JSON.stringify(message.id));
                if (
                    this.pendingPings.size + this.queuedPings >= PING_LIMIT ||
                    this.queuedBytes + bytes > QUEUE_LIMIT
                ) {
                    this.fail({ reason: 'control-queue-exceeded', bytes });
                    return;
                }
                // Tracked IDs share the existing byte budget with both POST lanes.
                this.queuedBytes += bytes;
                this.pendingPings.set(message.id, bytes);
            }
        } else if (
            'method' in message &&
            message.method === 'notifications/cancelled'
        ) {
            const id = message.params?.requestId;
            if (typeof id === 'string' || typeof id === 'number')
                this.takePing(id);
        }
        this.onmessage?.(message);
    }

    private takePing(id: string | number): boolean {
        const bytes = this.pendingPings.get(id);
        if (bytes === undefined) return false;
        this.pendingPings.delete(id);
        this.queuedBytes -= bytes;
        return true;
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (this.stopped || !this.endpoint)
            throw new Error('Reverse transport unavailable');
        const body = JSON.stringify(message);
        const bytes = Buffer.byteLength(body);
        // Only responses to admitted inbound pings may bypass the control FIFO.
        // Delete synchronously: a second response with the same ID is ordinary.
        const ping =
            !('method' in message) &&
            message.id !== undefined &&
            this.takePing(message.id);
        if (
            bytes > MESSAGE_LIMIT ||
            this.queuedBytes + bytes > QUEUE_LIMIT ||
            (ping && this.queuedPings >= PING_LIMIT)
        ) {
            this.fail({ reason: 'control-queue-exceeded', bytes });
            throw new Error('Reverse control queue exceeded');
        }
        this.queuedBytes += bytes;
        if (ping) this.queuedPings++;
        const enqueuedAt = performance.now();
        const queue = ping ? this.pingQueue : this.queue;
        const operation = queue.then(async () => {
            if (this.stopped) throw new Error('Reverse transport closed');
            const startedAt = performance.now();
            const queuedMs = Math.round(startedAt - enqueuedAt);
            try {
                const response = await this.fetch(this.endpoint!, {
                    method: 'POST',
                    headers: {
                        ...this.headers,
                        'Content-Type': 'application/json',
                    },
                    body,
                    signal: this.abort.signal,
                    redirect: 'manual',
                });
                const status = response.status;
                await response.body?.cancel();
                if (this.stopped) throw new Error('Reverse transport closed');
                const elapsedMs = Math.round(performance.now() - startedAt);
                if (status !== 202) {
                    throw new ControlFailure({
                        reason: 'message-post-rejected',
                        status,
                        bytes,
                        queuedMs,
                        elapsedMs,
                    });
                }
                if (
                    (queuedMs >= SLOW_POST_MS || elapsedMs >= SLOW_POST_MS) &&
                    performance.now() >= this.nextDiagnosticAt
                ) {
                    this.nextDiagnosticAt =
                        performance.now() + DIAGNOSTIC_INTERVAL_MS;
                    try {
                        this.ondiagnostic?.({
                            reason: ping
                                ? 'ping-post-slow'
                                : 'control-post-slow',
                            bytes,
                            queuedMs,
                            elapsedMs,
                            status,
                        });
                    } catch {
                        // Observability must not change POST acceptance semantics.
                    }
                }
            } catch (error) {
                throw error instanceof ControlFailure
                    ? error
                    : new ControlFailure({
                          reason: 'message-post-failed',
                          bytes,
                          queuedMs,
                          elapsedMs: Math.round(performance.now() - startedAt),
                          networkCode: networkCode(error),
                      });
            }
        });
        const settled = operation.catch((error) =>
            this.fail(
                error instanceof ControlFailure
                    ? error.detail
                    : { reason: 'message-post-failed' },
            ),
        );
        if (ping) this.pingQueue = settled;
        else this.queue = settled;
        try {
            await operation;
        } finally {
            this.queuedBytes -= bytes;
            if (ping) this.queuedPings--;
        }
    }

    private armReadTimeout(): void {
        clearTimeout(this.readTimer);
        if (this.readTimeout > 0) {
            this.readTimer = setTimeout(
                () => this.fail({ reason: 'read-timeout' }),
                this.readTimeout,
            );
            this.readTimer.unref();
        }
    }

    private fail(detail: ReverseControlFailure): void {
        if (this.stopped) return;
        this.failure = detail;
        try {
            this.onerror?.(new ControlFailure(detail));
        } finally {
            void this.close();
        }
    }

    async close(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        clearTimeout(this.readTimer);
        for (const bytes of this.pendingPings.values())
            this.queuedBytes -= bytes;
        this.pendingPings.clear();
        this.abort.abort();
        void this.reader?.cancel().catch(() => {});
        this.readyReject?.(new Error('Reverse connection closed'));
        this.resolveClosed();
        this.onclose?.();
    }
}
