import type {
    Transport,
    TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface PendingSend {
    message: JSONRPCMessage;
    options?: TransportSendOptions;
    resolve: () => void;
    reject: (error: Error) => void;
}

/** One writer for every SDK message, with no control/data priority or wire changes. */
export class FifoTransport implements Transport {
    onclose?: Transport['onclose'];
    onerror?: Transport['onerror'];
    onmessage?: Transport['onmessage'];
    private queue: PendingSend[] = [];
    private active?: PendingSend;
    private scheduled?: ReturnType<typeof setImmediate>;
    private stopped = false;

    constructor(private readonly raw: Transport) {
        raw.onmessage = (message, extra) => this.onmessage?.(message, extra);
        raw.onerror = (error) => this.onerror?.(error);
        raw.onclose = () => this.stop();
    }

    get sessionId(): string | undefined {
        return this.raw.sessionId;
    }

    set sessionId(value: string | undefined) {
        this.raw.sessionId = value;
    }

    setProtocolVersion(version: string): void {
        this.raw.setProtocolVersion?.(version);
    }

    async start(): Promise<void> {
        if (this.stopped) throw new Error('FIFO transport closed');
        try {
            await this.raw.start();
        } catch (error) {
            this.stop();
            throw error;
        }
    }

    send(
        message: JSONRPCMessage,
        options?: TransportSendOptions,
    ): Promise<void> {
        if (this.stopped)
            return Promise.reject(new Error('FIFO transport closed'));
        return new Promise<void>((resolve, reject) => {
            this.queue.push({ message, options, resolve, reject });
            this.pump();
        });
    }

    private pump() {
        if (this.stopped || this.active || this.scheduled) return;
        const pending = this.queue.shift();
        if (!pending) return;
        this.active = pending;
        // Promise wrapping also handles transports that throw synchronously.
        void Promise.resolve()
            .then(() => {
                if (this.stopped) throw new Error('FIFO transport closed');
                return this.raw.send(pending.message, pending.options);
            })
            .then(
                () => this.settle(pending),
                (error) =>
                    this.settle(
                        pending,
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    ),
            );
    }

    private settle(pending: PendingSend, error?: Error) {
        if (this.active !== pending) return;
        this.active = undefined;
        if (error) pending.reject(error);
        else pending.resolve();
        if (this.stopped) return;
        // Yield even when a new message is enqueued by the caller's resolution.
        this.scheduled = setImmediate(() => {
            this.scheduled = undefined;
            this.pump();
        });
    }

    private stop() {
        if (this.stopped) return;
        this.stopped = true;
        if (this.scheduled) clearImmediate(this.scheduled);
        this.scheduled = undefined;
        const error = new Error('FIFO transport closed');
        this.active?.reject(error);
        this.active = undefined;
        for (const pending of this.queue) pending.reject(error);
        this.queue = [];
        this.onclose?.();
    }

    async close(): Promise<void> {
        this.stop();
        // Do not await the active send; stdin/stdout may never drain after EOF.
        await this.raw.close();
    }
}
