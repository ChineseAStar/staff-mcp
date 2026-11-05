import type {
    ChannelOpen,
    ChannelPurpose,
    ChannelReceiver,
    DataChannel,
    DataLink,
    DataOpenResult,
    DataSession,
    Direction,
    StdioDataFrame,
    StdioDataOpenParams,
    StdioDataSessionOptions,
} from './types.js';

export const DATA_FRAME_METHOD = 'cc.qqxing/data/v1/frame';
export const DATA_OPEN_METHOD = 'cc.qqxing/data/v1/open';
const CHUNK = 64 * 1024;
const WINDOW = 256 * 1024;

function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
}

function errorOf(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}

function validPurpose(value: unknown): value is ChannelPurpose {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validOpen(
    value: unknown,
    supportsPurpose: (purpose: string) => boolean,
): ChannelOpen {
    const open = value as ChannelOpen | undefined;
    check(
        open &&
            validPurpose(open.purpose) &&
            typeof open.resourceId === 'string' &&
            open.resourceId.length > 0 &&
            open.resourceId.length <= 256 &&
            ['host-to-remote', 'remote-to-host', 'duplex'].includes(
                open.direction,
            ),
        'Invalid data channel metadata',
    );
    check(supportsPurpose(open.purpose), 'Unsupported data channel purpose');
    return {
        purpose: open.purpose,
        resourceId: open.resourceId,
        direction: open.direction,
    };
}

function safeOffset(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Validate length, alphabet and unused padding bits BEFORE decoding/allocating. */
function decodedLength(value: unknown): number {
    check(
        typeof value === 'string' &&
            value.length > 0 &&
            value.length <= Math.ceil(CHUNK / 3) * 4 &&
            value.length % 4 === 0 &&
            /^[A-Za-z0-9+/]+={0,2}$/.test(value),
        'Invalid Base64 data',
    );
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = alphabet.indexOf(value[value.length - padding - 1]);
    check(
        (padding !== 2 || (last & 15) === 0) &&
            (padding !== 1 || (last & 3) === 0),
        'Noncanonical Base64 data',
    );
    const length = (value.length / 4) * 3 - padding;
    check(length > 0 && length <= CHUNK, 'Data chunk limit exceeded');
    return length;
}

type Input = { bytes: Uint8Array } | { end: true };
type Ack = { offset: number; ended: boolean };

/** One bounded byte channel. No business authorization or resource semantics. */
class StdioChannel implements DataChannel {
    private readonly completion = deferred<void>();
    readonly closed = this.completion.promise;
    readonly abort = new AbortController();
    private readonly writing: boolean;
    private readonly reading: boolean;
    private readonly openTimer: ReturnType<typeof setTimeout>;
    private readonly progressTimer: ReturnType<typeof setInterval>;
    private readonly changed = new Set<ReturnType<typeof deferred<void>>>();
    private receiver?: ChannelReceiver;
    private detachSignal?: () => void;
    private activated = false;
    private disposed = false;
    private failure?: Error;
    private sent = 0;
    private consumed = 0;
    private sendSequence = 0;
    private ackSequence = 0;
    private received = 0;
    private delivered = 0;
    private receiveSequence = 0;
    private outgoingAckSequence = 0;
    private ending = false;
    private outputEnded: boolean;
    private writeFinalized: boolean;
    private inputEndQueued = false;
    private inputEnded: boolean;
    private writingNow = false;
    private consuming = false;
    private queue: Input[] = [];
    private ackWanted?: Ack;
    private ackSending = false;
    private lastProgress = performance.now();

    constructor(
        readonly id: number,
        open: ChannelOpen,
        private readonly options: StdioDataSessionOptions,
        private readonly release: () => void,
    ) {
        this.writing =
            open.direction === 'duplex' ||
            open.direction ===
                (options.role === 'host' ? 'host-to-remote' : 'remote-to-host');
        this.reading = open.direction === 'duplex' || !this.writing;
        this.outputEnded = !this.writing;
        this.writeFinalized = !this.writing;
        this.inputEnded = !this.reading;
        this.openTimer = setTimeout(
            () => this.close('Data/open timed out'),
            options.openTimeoutMs ?? 15_000,
        );
        const idle = options.idleTimeoutMs ?? 60_000;
        this.progressTimer = setInterval(
            () => {
                if (
                    this.pending() &&
                    performance.now() - this.lastProgress >= idle
                )
                    this.close('Stdio data consumption timed out');
            },
            Math.min(idle, 1_000),
        );
        this.openTimer.unref?.();
        this.progressTimer.unref?.();
    }

    assertAlive() {
        if (this.disposed)
            throw this.failure ?? new Error('Data channel already closed');
    }

    private pending(): boolean {
        return (
            this.sent > this.consumed ||
            (this.ending && !this.writeFinalized) ||
            this.received > this.delivered ||
            (this.inputEndQueued && !this.inputEnded) ||
            this.ackSending ||
            this.ackWanted !== undefined
        );
    }

    private startWork() {
        if (!this.pending()) this.lastProgress = performance.now();
    }

    private pulse() {
        this.lastProgress = performance.now();
        for (const waiter of this.changed) waiter.resolve();
        this.changed.clear();
    }

    private waitChanged(): Promise<void> {
        this.assertAlive();
        const waiter = deferred<void>();
        this.changed.add(waiter);
        return waiter.promise;
    }

    /** Abortable one-shot operations, never race a lifelong closed promise. */
    wait<T>(operation: Promise<T>): Promise<T> {
        this.assertAlive();
        return new Promise<T>((resolve, reject) => {
            const signal = this.abort.signal;
            const cancel = () => {
                signal.removeEventListener('abort', cancel);
                reject(this.failure ?? new Error('Data channel closed'));
            };
            signal.addEventListener('abort', cancel, { once: true });
            operation.then(
                (value) => {
                    signal.removeEventListener('abort', cancel);
                    resolve(value);
                },
                (error) => {
                    signal.removeEventListener('abort', cancel);
                    reject(error);
                },
            );
            if (signal.aborted) cancel();
        });
    }

    attachSignal(signal?: AbortSignal) {
        if (!signal) return;
        const cancel = () => this.close('Data channel aborted');
        this.detachSignal = () => signal.removeEventListener('abort', cancel);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
    }

    setReceiver(receiver: ChannelReceiver) {
        if (this.disposed) {
            try {
                receiver.close(this.failure);
            } catch {
                /* Preserve the channel result. */
            }
            return;
        }
        this.receiver = receiver;
        this.startInput();
    }

    activate() {
        this.assertAlive();
        this.activated = true;
        clearTimeout(this.openTimer);
        this.finish();
    }

    private send(frame: StdioDataFrame): Promise<void> {
        this.assertAlive();
        return this.wait(
            Promise.resolve().then(() => {
                this.assertAlive();
                return this.options.sendNotification(frame);
            }),
        );
    }

    private base() {
        return { binding: this.options.binding, channel: this.id };
    }

    async write(bytes: Uint8Array): Promise<void> {
        this.assertAlive();
        check(this.writing && !this.ending, 'Data channel is not writable');
        check(!this.writingNow, 'Concurrent data writes are not supported');
        this.writingNow = true;
        try {
            for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
                const length = Math.min(CHUNK, bytes.byteLength - offset);
                while (this.sent - this.consumed + length > WINDOW)
                    await this.waitChanged();
                this.assertAlive();
                check(
                    Number.isSafeInteger(this.sent + length),
                    'Data offset overflow',
                );
                check(
                    Number.isSafeInteger(this.sendSequence + 1),
                    'Data sequence overflow',
                );
                // Only the next bounded chunk is copied, never the caller's entire buffer.
                const data = Buffer.from(
                    bytes.subarray(offset, offset + length),
                ).toString('base64');
                this.startWork();
                const frame: StdioDataFrame = {
                    ...this.base(),
                    type: 'data',
                    sequence: ++this.sendSequence,
                    offset: this.sent,
                    data,
                };
                this.sent += length;
                await this.send(frame);
            }
        } catch (error) {
            this.close(errorOf(error).message);
            throw error;
        } finally {
            this.writingNow = false;
        }
    }

    async end(): Promise<void> {
        if (this.writeFinalized) return;
        this.assertAlive();
        check(
            this.writing && !this.ending && !this.writingNow,
            'Invalid data end',
        );
        this.startWork();
        this.ending = true;
        try {
            check(
                Number.isSafeInteger(this.sendSequence + 1),
                'Data sequence overflow',
            );
            await this.send({
                ...this.base(),
                type: 'end',
                sequence: ++this.sendSequence,
                offset: this.sent,
            });
            while (!this.outputEnded) await this.waitChanged();
            this.writeFinalized = true;
            this.finish();
        } catch (error) {
            this.close(errorOf(error).message);
            throw error;
        }
    }

    receive(frame: StdioDataFrame) {
        this.assertAlive();
        if (frame.type === 'close') {
            check(
                typeof frame.code === 'string' && frame.code.length <= 256,
                'Invalid close code',
            );
            this.fail(new Error(frame.code || 'Peer closed data channel'));
            return;
        }
        check(
            safeOffset(frame.sequence) &&
                frame.sequence > 0 &&
                safeOffset(frame.offset),
            'Invalid data sequence or offset',
        );
        if (frame.type === 'ack') {
            check(
                this.writing &&
                    !this.outputEnded &&
                    frame.sequence === this.ackSequence + 1 &&
                    frame.offset >= this.consumed &&
                    frame.offset <= this.sent &&
                    typeof frame.ended === 'boolean' &&
                    (frame.ended
                        ? this.ending && frame.offset === this.sent
                        : frame.offset > this.consumed),
                'Invalid or replayed consumption acknowledgment',
            );
            this.ackSequence = frame.sequence;
            this.consumed = frame.offset;
            if (frame.ended) this.outputEnded = true;
            this.pulse();
            return;
        }
        check(
            this.reading &&
                !this.inputEndQueued &&
                frame.sequence === this.receiveSequence + 1 &&
                frame.offset === this.received,
            'Invalid data direction, sequence or offset',
        );
        check(
            frame.type === 'data' || frame.type === 'end',
            'Unknown data frame type',
        );
        this.startWork();
        if (frame.type === 'data') {
            const length = decodedLength(frame.data);
            check(
                Number.isSafeInteger(this.received + length),
                'Data offset overflow',
            );
            check(
                this.received - this.delivered + length <= WINDOW,
                'Data consumption window exceeded',
            );
            const bytes = Buffer.from(frame.data, 'base64');
            this.received += length;
            this.queue.push({ bytes });
        } else {
            this.inputEndQueued = true;
            this.queue.push({ end: true });
        }
        this.receiveSequence = frame.sequence;
        this.startInput();
    }

    private startInput() {
        if (
            this.consuming ||
            !this.receiver ||
            !this.queue.length ||
            this.disposed
        )
            return;
        this.consuming = true;
        void this.consume().then(
            () => {
                this.consuming = false;
                this.startInput();
            },
            (error) => this.close(errorOf(error).message),
        );
    }

    private async consume() {
        while (this.queue.length) {
            const item = this.queue.shift()!;
            const receiver = this.receiver!;
            await this.wait(
                Promise.resolve().then(() => {
                    this.assertAlive();
                    return 'bytes' in item
                        ? receiver.data(item.bytes)
                        : receiver.end();
                }),
            );
            this.assertAlive();
            if ('bytes' in item) {
                this.delivered += item.bytes.byteLength;
                this.queueAck(false);
            } else {
                this.queueAck(true);
            }
            this.pulse();
        }
    }

    private queueAck(ended: boolean) {
        this.ackWanted = { offset: this.delivered, ended };
        if (this.ackSending) return;
        this.ackSending = true;
        void this.pumpAcks().catch((error) =>
            this.close(errorOf(error).message),
        );
    }

    private async pumpAcks() {
        // One current send plus one latest cumulative value, not an RTT queue.
        while (this.ackWanted) {
            const ack = this.ackWanted;
            this.ackWanted = undefined;
            check(
                Number.isSafeInteger(this.outgoingAckSequence + 1),
                'ACK sequence overflow',
            );
            await this.send({
                ...this.base(),
                type: 'ack',
                sequence: ++this.outgoingAckSequence,
                ...ack,
            });
            this.assertAlive();
            if (ack.ended) this.inputEnded = true;
            this.pulse();
        }
        this.ackSending = false;
        this.finish();
    }

    private finish() {
        if (
            !this.activated ||
            !this.inputEnded ||
            !this.writeFinalized ||
            this.disposed
        )
            return;
        this.cleanup();
        this.completion.resolve();
        try {
            this.receiver?.close();
        } catch {
            /* Completion is final. */
        }
    }

    private cleanup() {
        this.disposed = true;
        clearTimeout(this.openTimer);
        clearInterval(this.progressTimer);
        this.detachSignal?.();
        this.detachSignal = undefined;
        this.queue = [];
        this.ackWanted = undefined;
        this.release();
    }

    fail(error: Error) {
        if (this.disposed) return;
        this.failure = error;
        this.cleanup();
        this.abort.abort(error);
        for (const waiter of this.changed) waiter.reject(error);
        this.changed.clear();
        this.completion.reject(error);
        try {
            this.receiver?.close(error);
        } catch {
            /* Preserve the original failure. */
        }
    }

    close(code = 'Data channel cancelled') {
        if (this.disposed) return;
        this.fail(new Error(code));
        // Best effort notification only. Local cancellation never waits for control I/O.
        try {
            void this.options
                .sendNotification({
                    ...this.base(),
                    type: 'close',
                    code: code.slice(0, 256),
                })
                .catch(() => {});
        } catch {
            /* A dead control connection needs no notification. */
        }
    }
}

/** Connection-scoped stdio data plane. The host alone allocates channel IDs. */
export class StdioDataSession implements DataSession {
    private readonly channels = new Map<number, StdioChannel>();
    private readonly maximum: number;
    private highest = 0;
    private stopped = false;

    constructor(private readonly options: StdioDataSessionOptions) {
        check(
            options.role === 'host' || options.role === 'remote',
            'Invalid data session role',
        );
        check(
            typeof options.binding === 'string' &&
                /^[A-Za-z0-9_-]{16,256}$/.test(options.binding),
            'Invalid connection data binding',
        );
        check(
            typeof options.supportsPurpose === 'function' &&
                typeof options.sendNotification === 'function',
            'Data purpose policy and notification sender are required',
        );
        this.maximum = options.maxChannels ?? 4;
        check(
            Number.isInteger(this.maximum) &&
                this.maximum > 0 &&
                this.maximum <= 32,
            'Invalid data channel limit',
        );
        for (const timeout of [
            options.openTimeoutMs ?? 15_000,
            options.idleTimeoutMs ?? 60_000,
        ]) {
            check(
                Number.isSafeInteger(timeout) &&
                    timeout > 0 &&
                    timeout <= 300_000,
                'Invalid data timeout',
            );
        }
    }

    supports(purpose: ChannelPurpose, direction: Direction): boolean {
        return (
            !this.stopped &&
            validPurpose(purpose) &&
            this.options.supportsPurpose(purpose) &&
            ['host-to-remote', 'remote-to-host', 'duplex'].includes(direction)
        );
    }

    private create(id: number, open: ChannelOpen): StdioChannel {
        check(!this.stopped, 'Data session closed');
        // Pending business accepts and pending host RPCs already occupy this map.
        check(this.channels.size < this.maximum, 'Data channel limit exceeded');
        const channel = new StdioChannel(id, open, this.options, () =>
            this.channels.delete(id),
        );
        this.channels.set(id, channel);
        return channel;
    }

    async openChannel(
        open: ChannelOpen,
        receiver: ChannelReceiver,
        link?: DataLink,
        signal?: AbortSignal,
    ): Promise<DataChannel> {
        let channel: StdioChannel | undefined;
        try {
            check(
                this.options.role === 'host' && this.options.requestOpen,
                'Only the host opens data channels',
            );
            check(
                link === undefined,
                'HTTP data links are not supported on stdio',
            );
            open = validOpen(open, this.options.supportsPurpose);
            check(
                Number.isSafeInteger(this.highest + 1),
                'Data channel ID overflow',
            );
            channel = this.create(++this.highest, open);
            channel.setReceiver(receiver);
            channel.attachSignal(signal);
            channel.assertAlive();
            const params: StdioDataOpenParams = {
                binding: this.options.binding,
                channel: channel.id,
                open,
            };
            const result = await channel.wait(
                Promise.resolve().then(() => {
                    channel!.assertAlive();
                    return this.options.requestOpen!(
                        params,
                        channel!.abort.signal,
                    );
                }),
            );
            check(
                result && typeof result === 'object' && !('link' in result),
                'Invalid stdio data/open result',
            );
            channel.activate();
            return channel;
        } catch (error) {
            if (channel) channel.close(errorOf(error).message);
            else {
                try {
                    receiver.close(errorOf(error));
                } catch {
                    /* Preserve admission failure. */
                }
            }
            throw error;
        }
    }

    async acceptOpen(raw: unknown): Promise<DataOpenResult> {
        check(
            this.options.role === 'remote' && this.options.accept,
            'Data accept is unavailable',
        );
        check(!this.stopped, 'Data session closed');
        const params = raw as StdioDataOpenParams;
        check(
            params && params.binding === this.options.binding,
            'Data/open connection binding mismatch',
        );
        check(
            Number.isSafeInteger(params.channel) &&
                params.channel > this.highest,
            'Invalid or replayed data channel ID',
        );
        // Fence synchronously, including refused opens, BEFORE async business admission.
        this.highest = params.channel;
        check(
            !('link' in params),
            'HTTP data links are not supported on stdio',
        );
        const open = validOpen(params.open, this.options.supportsPurpose);
        const channel = this.create(params.channel, open);
        try {
            const installed = Promise.resolve()
                .then(() => {
                    channel.assertAlive();
                    return this.options.accept!(open, channel);
                })
                .then((receiver) => channel.setReceiver(receiver));
            await channel.wait(installed);
            channel.activate();
            return {};
        } catch (error) {
            channel.close(errorOf(error).message);
            throw error;
        }
    }

    /** Synchronous wire admission; consumption is serial and never blocks MCP dispatch. */
    handleNotification(raw: unknown): void {
        if (this.stopped || !raw || typeof raw !== 'object') return;
        const frame = raw as StdioDataFrame;
        if (
            frame.binding !== this.options.binding ||
            !Number.isSafeInteger(frame.channel)
        )
            return;
        const channel = this.channels.get(frame.channel);
        if (!channel) return;
        try {
            channel.receive(frame);
        } catch (error) {
            channel.close(errorOf(error).message);
        }
    }

    close(reason = 'Data connection closed') {
        if (this.stopped) return;
        this.stopped = true;
        // Control teardown is synchronous, not a queue of best-effort close sends.
        for (const channel of this.channels.values())
            channel.fail(new Error(reason));
        this.channels.clear();
    }
}
