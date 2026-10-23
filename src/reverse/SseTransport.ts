import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

const MESSAGE_LIMIT = 4 * 1024 * 1024;
const QUEUE_LIMIT = 8 * 1024 * 1024;

/** Outbound-only reverse control: SSE receives JSON-RPC, POST sends JSON-RPC. No resume/replay. */
export class ReverseSseTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: Transport['onmessage'];
    readonly closed: Promise<void>;
    sessionId?: string;
    private resolveClosed!: () => void;
    private readonly abort = new AbortController();
    private stopped = false;
    private started = false;
    private endpoint?: URL;
    private queue = Promise.resolve();
    private queuedBytes = 0;
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
                ? setTimeout(() => this.fail(), this.connectTimeout)
                : undefined;
        timer?.unref();
        void this.read().catch(() => this.fail());
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
            throw new Error('Reverse SSE rejected');
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
                if (data.length) this.event(event, data.join('\n'));
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
            if (part.done) throw new Error('Reverse SSE ended');
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
                    throw new Error('Reverse SSE event too large');
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
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(data)));
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (this.stopped || !this.endpoint)
            throw new Error('Reverse transport unavailable');
        const body = JSON.stringify(message);
        const bytes = Buffer.byteLength(body);
        if (bytes > MESSAGE_LIMIT || this.queuedBytes + bytes > QUEUE_LIMIT) {
            this.fail();
            throw new Error('Reverse control queue exceeded');
        }
        this.queuedBytes += bytes;
        const operation = this.queue.then(async () => {
            if (this.stopped) throw new Error('Reverse transport closed');
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
            const accepted = response.status === 202;
            await response.body?.cancel();
            if (!accepted) throw new Error('Reverse POST rejected');
        });
        this.queue = operation.catch(() => this.fail());
        try {
            await operation;
        } finally {
            this.queuedBytes -= bytes;
        }
    }

    private armReadTimeout(): void {
        clearTimeout(this.readTimer);
        if (this.readTimeout > 0) {
            this.readTimer = setTimeout(() => this.fail(), this.readTimeout);
            this.readTimer.unref();
        }
    }

    private fail(): void {
        if (this.stopped) return;
        try {
            this.onerror?.(new Error('Reverse control connection failed'));
        } finally {
            void this.close();
        }
    }

    async close(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        clearTimeout(this.readTimer);
        this.abort.abort();
        void this.reader?.cancel().catch(() => {});
        this.readyReject?.(new Error('Reverse connection closed'));
        this.resolveClosed();
        this.onclose?.();
    }
}
