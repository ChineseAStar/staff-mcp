import { randomBytes, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import type {
    ChannelOpen,
    ChannelPurpose,
    ChannelReceiver,
    DataChannel,
    DataLink,
    DataOpenParams,
    DataOpenResult,
    Direction,
    HttpDataSessionOptions,
} from './types.js';

export const DATA_OPEN_METHOD = 'cc.qqxing/data/v1/open';
const CHUNK = 64 * 1024;
const WINDOW = 256 * 1024;
const HEADERS = { 'Cache-Control': 'no-store' };

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

function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
}

function errorOf(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
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

function sameOpen(left: ChannelOpen, right: ChannelOpen): boolean {
    return (
        left.purpose === right.purpose &&
        left.resourceId === right.resourceId &&
        left.direction === right.direction
    );
}

function endpointUrl(value: string): URL {
    const url = new URL(value);
    check(
        ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname !== '/' &&
            !url.pathname.endsWith('/'),
        'Invalid data endpoint',
    );
    check(url.href === value, 'Data endpoint must be canonical');
    return url;
}

interface Ack {
    sequence: number;
    offset: number;
    ended: boolean;
}

/** One logical channel; HTTP legs never invoke a second business accept. */
class HttpChannel implements DataChannel {
    private readonly completion = deferred<void>();
    private readonly receiverReady = deferred<ChannelReceiver>();
    private changed = deferred<void>();
    private readonly connected = deferred<void>();
    readonly closed = this.completion.promise;
    readonly abort = new AbortController();
    readonly outgoing: ReadableStream<Uint8Array>;
    readonly acknowledgments: ReadableStream<Uint8Array>;
    private output!: ReadableStreamDefaultController<Uint8Array>;
    private ackOutput!: ReadableStreamDefaultController<Uint8Array>;
    private receiver?: ChannelReceiver;
    private readonly writing: boolean;
    private readonly reading: boolean;
    private readonly legs = new Set<string>();
    private sent = 0;
    private consumed = 0;
    private received = 0;
    private ackSequence = 0;
    private ackPending = false;
    private ackFinished = false;
    private ackWanted?: { offset: number; ended: boolean };
    private ackSending?: Promise<void>;
    private receiveSequence = 0;
    private ending = false;
    private outputEnded = false;
    private inputEnded = false;
    private writingNow = false;
    private writeFinalized = false;
    private ackDemand = deferred<void>();
    private consuming = false;
    private disposed = false;
    private activated = false;
    private transportReady = false;
    private failure?: Error;
    private lastActivity = performance.now();
    readonly ticketDeadline: number;
    private readonly openTimer: ReturnType<typeof setTimeout>;
    private readonly idleTimer: ReturnType<typeof setInterval>;
    private upload?: Promise<void>;
    private acknowledgmentsRead?: Promise<void>;
    private bytesSinceYield = 0;

    constructor(
        readonly link: DataLink,
        private readonly options: HttpDataSessionOptions,
        readonly serving: boolean,
        private readonly release: () => void,
    ) {
        this.ticketDeadline = performance.now() + link.expiresInMs;
        const host = options.role === 'host';
        this.writing =
            link.open.direction === 'duplex' ||
            link.open.direction ===
                (host ? 'host-to-remote' : 'remote-to-host');
        this.reading = link.open.direction === 'duplex' || !this.writing;
        this.outputEnded = !this.writing;
        this.writeFinalized = !this.writing;
        this.inputEnded = !this.reading;
        this.outgoing = new ReadableStream(
            {
                start: (controller) => {
                    this.output = controller;
                },
                cancel: () => this.close('HTTP data reader cancelled'),
            },
            { highWaterMark: 0 },
        );
        this.acknowledgments = new ReadableStream(
            {
                start: (controller) => {
                    this.ackOutput = controller;
                },
                pull: () => {
                    this.ackDemand.resolve();
                },
                cancel: () => {
                    if (!this.ackFinished)
                        this.close('HTTP acknowledgment reader cancelled');
                },
            },
            { highWaterMark: 0 },
        );
        this.openTimer = setTimeout(
            () => this.close('HTTP data legs timed out'),
            options.openTimeoutMs ?? 15_000,
        );
        const idle = options.idleTimeoutMs ?? 60_000;
        this.idleTimer = setInterval(
            () => {
                if (
                    this.pendingConsumption() &&
                    performance.now() - this.lastActivity >= idle
                )
                    this.close('HTTP data consumption timed out');
            },
            Math.min(idle, 1_000),
        );
        this.openTimer.unref?.();
        this.idleTimer.unref?.();
    }

    setReceiver(receiver: ChannelReceiver) {
        if (this.disposed) {
            receiver.close(this.failure);
            return;
        }
        this.receiver = receiver;
        this.receiverReady.resolve(receiver);
    }

    private assertAlive() {
        if (this.disposed)
            throw this.failure ?? new Error('Data channel already closed');
    }

    private pendingConsumption(): boolean {
        return (
            this.sent > this.consumed ||
            (this.ending && !this.writeFinalized) ||
            this.consuming ||
            this.ackPending ||
            this.ackSending !== undefined
        );
    }

    private startConsumption() {
        // A healthy idle PTY is governed by its business lease, not an extra
        // data-plane lease. Start a fresh progress deadline when work appears.
        if (!this.pendingConsumption()) this.lastActivity = performance.now();
    }

    private pulse() {
        this.lastActivity = performance.now();
        this.changed.resolve();
        this.changed = deferred<void>();
    }

    async wait<T>(promise: Promise<T>): Promise<T> {
        this.assertAlive();
        // A cancellable waiter, not Promise.race(closed): the latter retains one
        // closed.then callback per chunk until a potentially hours-long channel ends.
        return new Promise<T>((resolve, reject) => {
            const signal = this.abort.signal;
            const cancel = () =>
                reject(this.failure ?? new Error('Data channel closed'));
            signal.addEventListener('abort', cancel, { once: true });
            promise.then(
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
        if (signal.aborted) cancel();
        else {
            signal.addEventListener('abort', cancel, { once: true });
            void this.closed
                .finally(() => signal.removeEventListener('abort', cancel))
                .catch(() => {});
        }
    }

    claim(leg: string) {
        this.assertAlive();
        check(!this.legs.has(leg), 'Data ticket already used');
        check(
            leg === 'ready' || (leg === 'get' ? this.writing : this.reading),
            'Wrong data direction',
        );
        this.legs.add(leg);
        // A real metadata response proves ticket admission without requiring a
        // first data/ACK chunk (Next does not flush streaming GET headers early).
        // PUT may be lazy until its first byte/EOF; reserve it with ready, then
        // enforce its own single-use claim and the consumption idle deadline.
        const ready =
            this.legs.has('ready') &&
            (!this.writing || this.legs.has('get')) &&
            (!this.reading || this.legs.has('ack'));
        if (ready) {
            this.transportReady = true;
            if (this.activated) clearTimeout(this.openTimer);
            this.connected.resolve();
        }
        this.pulse();
    }

    ticketExpired(): boolean {
        // The single-use ready claim redeems the ticket; it cannot renew it.
        // A reserved lazy PUT can attach later while the logical channel lives.
        return (
            !this.legs.has('ready') && performance.now() >= this.ticketDeadline
        );
    }

    async waitConnected() {
        await this.wait(this.connected.promise);
    }

    activate() {
        this.assertAlive();
        this.activated = true;
        if (this.transportReady) clearTimeout(this.openTimer);
        this.finish();
    }

    private clientConnected() {
        this.transportReady = true;
        if (this.activated) clearTimeout(this.openTimer);
        this.connected.resolve();
        this.pulse();
    }

    private async fairness(bytes: number) {
        this.bytesSinceYield += bytes;
        if (this.bytesSinceYield >= WINDOW) {
            this.bytesSinceYield %= WINDOW;
            await this.wait(yieldImmediate());
        }
    }

    async write(bytes: Uint8Array): Promise<void> {
        this.assertAlive();
        check(this.writing && !this.ending, 'Data channel is not writable');
        // No unbounded write queue retaining arbitrary caller buffers.
        check(!this.writingNow, 'Concurrent data writes are not supported');
        this.writingNow = true;
        try {
            await this.wait(this.connected.promise);
            for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
                this.assertAlive();
                const length = Math.min(CHUNK, bytes.byteLength - offset);
                while (this.sent - this.consumed + length > WINDOW) {
                    await this.wait(this.changed.promise);
                }
                // Buffer.slice aliases memory, so always make an owned Uint8Array copy.
                const chunk = new Uint8Array(length);
                chunk.set(bytes.subarray(offset, offset + length));
                this.startConsumption();
                this.sent += chunk.byteLength;
                check(Number.isSafeInteger(this.sent), 'Data offset overflow');
                this.output.enqueue(chunk);
                // Copy/queue admission only; credit advances exclusively on receiver consumption ACK.
                await this.fairness(chunk.byteLength);
            }
        } catch (error) {
            this.fail(errorOf(error));
            throw error;
        } finally {
            this.writingNow = false;
        }
    }

    async end(): Promise<void> {
        if (this.outputEnded) return;
        this.assertAlive();
        check(
            this.writing && !this.ending && !this.writingNow,
            'Invalid data end',
        );
        this.startConsumption();
        this.ending = true;
        try {
            await this.wait(this.connected.promise);
            // EOF is emitted immediately, never await a final socket drain before end.
            this.output.close();
            while (!this.outputEnded) await this.wait(this.changed.promise);
            if (this.upload) await this.upload;
            if (this.acknowledgmentsRead) await this.acknowledgmentsRead;
            this.writeFinalized = true;
            this.finish();
        } catch (error) {
            this.fail(errorOf(error));
            throw error;
        }
    }

    beginAck() {
        this.assertAlive();
        check(!this.ackPending, 'Concurrent consumption acknowledgment');
        this.startConsumption();
        this.ackPending = true;
    }

    endAck() {
        this.ackPending = false;
    }

    applyAck(raw: unknown) {
        this.assertAlive();
        const ack = raw as Ack;
        check(
            ack &&
                Number.isSafeInteger(ack.sequence) &&
                ack.sequence === this.ackSequence + 1 &&
                Number.isSafeInteger(ack.offset) &&
                ack.offset >= this.consumed &&
                ack.offset <= this.sent &&
                typeof ack.ended === 'boolean' &&
                !this.outputEnded &&
                (ack.ended
                    ? this.ending && ack.offset === this.sent
                    : ack.offset > this.consumed),
            'Invalid or replayed consumption acknowledgment',
        );
        this.ackSequence = ack.sequence;
        this.consumed = ack.offset;
        if (ack.ended) this.outputEnded = true;
        this.pulse();
        // end() owns final completion, after its HTTP PUT success (if any).
    }

    private queueAck(ended: boolean) {
        // One in-flight HTTP operation plus one latest cumulative offset, never
        // a per-chunk request queue. Receiver consumption does NOT await an RTT.
        this.ackWanted = { offset: this.received, ended };
        this.startAckPump();
    }

    private startAckPump() {
        if (this.ackSending || !this.ackWanted) return;
        this.startConsumption();
        const sending = this.pumpAcks();
        this.ackSending = sending;
        void sending.then(
            () => {
                this.ackSending = undefined;
                if (!this.disposed) this.startAckPump();
            },
            (error) => this.fail(errorOf(error)),
        );
    }

    private async pumpAcks() {
        while (this.ackWanted) {
            const latest = this.ackWanted;
            this.ackWanted = undefined;
            const ack: Ack = { sequence: ++this.receiveSequence, ...latest };
            if (this.serving) {
                await this.wait(this.ackDemand.promise);
                this.ackDemand = deferred<void>();
                if (ack.ended) this.ackFinished = true;
                this.ackOutput.enqueue(
                    new TextEncoder().encode(JSON.stringify(ack) + '\n'),
                );
                if (ack.ended) this.ackOutput.close();
            } else {
                const response = await this.request(
                    'ack',
                    'POST',
                    JSON.stringify(ack),
                );
                await response.body?.cancel();
            }
        }
    }

    private async finalAck() {
        this.queueAck(true);
        while (this.ackSending) await this.wait(this.ackSending);
    }

    async receive(stream: ReadableStream<Uint8Array> | null): Promise<void> {
        const reader = stream?.getReader();
        check(reader, 'Missing raw HTTP body');
        try {
            const receiver = await this.wait(this.receiverReady.promise);
            while (true) {
                const result = await this.wait(reader.read());
                if (result.done) break;
                for (
                    let offset = 0;
                    offset < result.value.byteLength;
                    offset += CHUNK
                ) {
                    const bytes = result.value.subarray(offset, offset + CHUNK);
                    this.startConsumption();
                    this.consuming = true;
                    await this.wait(
                        Promise.resolve().then(() => {
                            this.assertAlive();
                            return receiver.data(bytes);
                        }),
                    );
                    this.assertAlive();
                    this.consuming = false;
                    this.received += bytes.byteLength;
                    check(
                        Number.isSafeInteger(this.received),
                        'Data offset overflow',
                    );
                    this.queueAck(false);
                    this.pulse();
                    await this.fairness(bytes.byteLength);
                }
            }
            this.startConsumption();
            this.consuming = true;
            await this.wait(
                Promise.resolve().then(() => {
                    this.assertAlive();
                    return receiver.end();
                }),
            );
            await this.finalAck();
            this.consuming = false;
            this.inputEnded = true;
            this.pulse();
            this.finish();
        } catch (error) {
            this.fail(errorOf(error));
            throw error;
        } finally {
            this.consuming = false;
            // reader.cancel releases a blocked network read on failure.
            if (this.failure) void reader.cancel(this.failure).catch(() => {});
            reader.releaseLock();
        }
    }

    private async request(
        leg: string,
        method: string,
        body?: ReadableStream<Uint8Array> | string,
    ): Promise<Response> {
        this.assertAlive();
        const init: RequestInit & { duplex?: 'half' } = {
            method,
            redirect: 'error',
            cache: 'no-store',
            signal: this.abort.signal,
            headers: {
                Authorization: `Bearer ${this.link.token}`,
                'X-Data-Binding': this.link.binding,
                'Content-Type':
                    typeof body === 'string'
                        ? 'application/json'
                        : 'application/octet-stream',
                'Accept-Encoding': 'identity',
            },
        };
        if (body !== undefined) {
            init.body = body;
            if (typeof body !== 'string') init.duplex = 'half';
        }
        const response = await this.wait(
            this.options.fetch(
                `${this.link.endpoint}/${this.link.channel}/${leg}`,
                init,
            ),
        );
        const encoding = response.headers.get('content-encoding');
        if (!response.ok || (encoding && encoding !== 'identity')) {
            await response.body?.cancel();
            throw new Error('HTTP data request failed');
        }
        return response;
    }

    private async readAcks(stream: ReadableStream<Uint8Array> | null) {
        const reader = stream?.getReader();
        check(reader, 'Missing HTTP consumption acknowledgments');
        let pending = '';
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
            while (true) {
                const next = await this.wait(reader.read());
                if (next.done) {
                    pending += decoder.decode();
                    break;
                }
                check(
                    !this.outputEnded || next.value.byteLength === 0,
                    'Data after final acknowledgment',
                );
                pending += decoder.decode(next.value, { stream: true });
                let index: number;
                while ((index = pending.indexOf('\n')) >= 0) {
                    check(index <= 256, 'HTTP acknowledgment record limit');
                    this.applyAck(JSON.parse(pending.slice(0, index)));
                    pending = pending.slice(index + 1);
                    if (this.outputEnded) {
                        check(
                            pending.length === 0,
                            'Data after final acknowledgment',
                        );
                        // Read the HTTP EOF instead of cancelling a valid final ACK leg.
                        // Cancelling here can abort the peer's still-open duplex channel.
                    }
                }
                check(
                    pending.length <= 256,
                    'HTTP acknowledgment record limit',
                );
            }
            check(
                pending.length === 0 && this.outputEnded,
                'Truncated HTTP acknowledgments',
            );
        } finally {
            if (this.failure) void reader.cancel(this.failure).catch(() => {});
            reader.releaseLock();
        }
    }

    async connect(): Promise<void> {
        try {
            if (this.writing) {
                this.acknowledgmentsRead = this.request('ack', 'GET').then(
                    (response) => this.readAcks(response.body),
                );
                void this.acknowledgmentsRead.catch((error) => this.fail(errorOf(error)));
                this.upload = this.request('put', 'PUT', this.outgoing).then(
                    async (response) => {
                        await response.body?.cancel();
                        check(this.ending, 'Premature HTTP upload completion');
                    },
                );
                void this.upload.catch((error) => this.fail(errorOf(error)));
            }
            if (this.reading) {
                void this.request('get', 'GET')
                    .then((response) => this.receive(response.body))
                    .catch((error) => this.fail(errorOf(error)));
            }
            // No payload/prelude or invented consumption credit. Unlike raw GET
            // headers, this empty authenticated response is independent of bytes
            // and EOF; it also rejects stale/replayed links before business accept.
            const ready = await this.request('ready', 'POST');
            await ready.body?.cancel();
            this.clientConnected();
        } catch (error) {
            this.fail(errorOf(error));
            throw error;
        }
    }

    private finish() {
        if (
            !this.activated ||
            !this.inputEnded ||
            !this.outputEnded ||
            !this.writeFinalized ||
            this.disposed
        )
            return;
        this.cleanup();
        this.completion.resolve();
        try {
            this.receiver?.close();
        } catch {
            /* Completion cannot be undone by cleanup. */
        }
    }

    private cleanup() {
        this.disposed = true;
        this.ackWanted = undefined;
        clearTimeout(this.openTimer);
        clearInterval(this.idleTimer);
        this.release();
    }

    fail(error: Error) {
        if (this.disposed) return;
        this.failure = error;
        this.cleanup();
        this.abort.abort(error);
        this.receiverReady.reject(error);
        this.connected.reject(error);
        this.changed.reject(error);
        this.ackDemand.reject(error);
        try {
            this.output.error(error);
        } catch {
            /* Already ended. */
        }
        try {
            this.ackOutput.error(error);
        } catch {
            /* Already ended. */
        }
        this.completion.reject(error);
        try {
            this.receiver?.close(error);
        } catch {
            /* Preserve original failure. */
        }
    }

    close(code = 'Data channel cancelled') {
        if (this.disposed) return;
        // Best effort only; no retry or replay. Local cancellation is immediate.
        if (!this.serving) {
            const signal = AbortSignal.timeout(1_000);
            void this.options
                .fetch(`${this.link.endpoint}/${this.link.channel}/close`, {
                    method: 'DELETE',
                    redirect: 'error',
                    signal,
                    headers: {
                        Authorization: `Bearer ${this.link.token}`,
                        'X-Data-Binding': this.link.binding,
                    },
                })
                .then((response) => response.body?.cancel())
                .catch(() => {});
        }
        this.fail(new Error(code));
    }
}

/** Connection-scoped HTTP binary data plane; no SDK, business classes or listeners. */
export class HttpDataSession {
    private readonly channels = new Map<string, HttpChannel>();
    private stopped = false;
    private readonly pendingOpens = new Set<AbortController>();
    private readonly usedLinks = new Map<string, number>();
    private readonly endpoint?: URL;
    private readonly maximum: number;

    constructor(private readonly options: HttpDataSessionOptions) {
        check(
            typeof options.fetch === 'function' &&
                typeof options.validateEndpoint === 'function',
            'HTTP client and endpoint policy are required',
        );
        check(
            typeof options.binding === 'string' &&
                /^[A-Za-z0-9_-]{16,256}$/.test(options.binding),
            'Invalid connection data binding',
        );
        check(
            typeof options.supportsPurpose === 'function',
            'Purpose policy is required',
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
        if (options.endpoint) this.endpoint = endpointUrl(options.endpoint);
    }

    hasActivity(): boolean {
        return this.pendingOpens.size > 0 || this.channels.size > 0;
    }

    supports(purpose: ChannelPurpose, direction: Direction): boolean {
        return (
            !this.stopped &&
            validPurpose(purpose) &&
            this.options.supportsPurpose(purpose) &&
            ['host-to-remote', 'remote-to-host', 'duplex'].includes(direction)
        );
    }

    private admit() {
        check(!this.stopped, 'Data session closed');
        check(
            this.channels.size + this.pendingOpens.size < this.maximum,
            'Data channel limit exceeded',
        );
    }

    private validateLink(raw: unknown, open: ChannelOpen): DataLink {
        const link = raw as DataLink;
        check(
            link &&
                link.version === 1 &&
                typeof link.channel === 'string' &&
                /^[a-f0-9]{48}$/.test(link.channel) &&
                typeof link.token === 'string' &&
                /^[a-f0-9]{64}$/.test(link.token) &&
                link.binding === this.options.binding &&
                Number.isSafeInteger(link.expiresInMs) &&
                link.expiresInMs > 0 &&
                link.expiresInMs <= (this.options.openTimeoutMs ?? 15_000) &&
                sameOpen(
                    validOpen(link.open, this.options.supportsPurpose),
                    open,
                ),
            'Invalid data link',
        );
        this.options.validateEndpoint(endpointUrl(link.endpoint));
        return { ...link, open };
    }

    private create(open: ChannelOpen, supplied?: DataLink): HttpChannel {
        open = validOpen(open, this.options.supportsPurpose);
        this.admit();
        check(supplied || this.endpoint, 'No local HTTP data endpoint');
        const link: DataLink = supplied ?? {
            version: 1,
            endpoint: this.endpoint!.href,
            channel: randomBytes(24).toString('hex'),
            token: randomBytes(32).toString('hex'),
            binding: this.options.binding,
            open,
            expiresInMs: this.options.openTimeoutMs ?? 15_000,
        };
        check(
            !this.channels.has(link.channel),
            'Data channel already accepted',
        );
        if (supplied) {
            const now = performance.now();
            for (const [id, expires] of this.usedLinks) {
                if (expires <= now) this.usedLinks.delete(id);
            }
            check(!this.usedLinks.has(link.channel), 'Data link already used');
            check(this.usedLinks.size < 256, 'Pending data link replay limit');
            this.usedLinks.set(link.channel, now + link.expiresInMs);
        }
        const channel = new HttpChannel(link, this.options, !supplied, () =>
            this.channels.delete(link.channel),
        );
        this.channels.set(link.channel, channel);
        return channel;
    }

    async openChannel(
        open: ChannelOpen,
        receiver: ChannelReceiver,
        link?: DataLink,
        signal?: AbortSignal,
    ): Promise<DataChannel> {
        check(
            this.options.role === 'host',
            'Only the host opens data channels',
        );
        open = validOpen(open, this.options.supportsPurpose);
        let channel: HttpChannel | undefined;
        try {
            if (link) {
                channel = this.create(open, this.validateLink(link, open));
                channel.setReceiver(receiver);
                channel.attachSignal(signal);
                await channel.connect();
            } else if (this.endpoint) {
                check(
                    this.options.requestOpen,
                    'Missing data/open control client',
                );
                channel = this.create(open);
                channel.setReceiver(receiver);
                channel.attachSignal(signal);
                await channel.wait(
                    this.options.requestOpen(
                        {
                            open,
                            binding: this.options.binding,
                            link: channel.link,
                        },
                        channel.abort.signal,
                    ),
                );
            } else {
                check(
                    this.options.requestOpen,
                    'Missing data/open control client',
                );
                // Reserve a bounded slot BEFORE awaiting RPC, including stalled metadata calls.
                this.admit();
                const pending = new AbortController();
                const deadline = setTimeout(
                    () => pending.abort(),
                    this.options.openTimeoutMs ?? 15_000,
                );
                deadline.unref?.();
                const combined = AbortSignal.any([
                    pending.signal,
                    ...(signal ? [signal] : []),
                ]);
                this.pendingOpens.add(pending);
                let result: DataOpenResult;
                try {
                    result = await new Promise<DataOpenResult>(
                        (resolve, reject) => {
                            const abort = () =>
                                reject(
                                    new Error(
                                        'Data/open cancelled or timed out',
                                    ),
                                );
                            combined.addEventListener('abort', abort, {
                                once: true,
                            });
                            if (combined.aborted) abort();
                            else
                                void this.options.requestOpen!(
                                    { open, binding: this.options.binding },
                                    combined,
                                ).then(resolve, reject);
                        },
                    );
                } finally {
                    clearTimeout(deadline);
                    pending.abort();
                    this.pendingOpens.delete(pending);
                }
                check(result.link, 'Data/open did not return a link');
                channel = this.create(
                    open,
                    this.validateLink(result.link, open),
                );
                channel.setReceiver(receiver);
                channel.attachSignal(signal);
                await channel.connect();
            }
            await channel.waitConnected();
            channel.activate();
            return channel;
        } catch (error) {
            if (channel) channel.fail(errorOf(error));
            else receiver.close(errorOf(error));
            throw error;
        }
    }

    async acceptOpen(raw: unknown): Promise<DataOpenResult> {
        check(
            this.options.role === 'remote' && this.options.accept,
            'Data accept is unavailable',
        );
        const params = raw as DataOpenParams;
        check(
            params && params.binding === this.options.binding,
            'Data/open connection binding mismatch',
        );
        const open = validOpen(params.open, this.options.supportsPurpose);
        const link = params.link
            ? this.validateLink(params.link, open)
            : undefined;
        const channel = this.create(open, link);
        try {
            // A reverse descriptor must first claim live, single-use HTTP legs.
            // Replaying a completed/expired descriptor must not re-enter business accept.
            if (link) await channel.connect();
            const accepting = Promise.resolve().then(() =>
                this.options.accept!(open, channel),
            );
            const installed = accepting.then((receiver) =>
                channel.setReceiver(receiver),
            );
            await channel.wait(installed);
            channel.activate();
            return link ? {} : { link: channel.link };
        } catch (error) {
            channel.fail(errorOf(error));
            throw error;
        }
    }

    async handleRequest(request: Request): Promise<Response | undefined> {
        if (!this.endpoint) return undefined;
        const url = new URL(request.url);
        const prefix = this.endpoint.pathname + '/';
        if (!url.pathname.startsWith(prefix)) return undefined;
        if (request.headers.has('origin') || url.search || url.hash)
            return new Response(null, { status: 403, headers: HEADERS });
        const match = /^([a-f0-9]{48})\/(get|put|ack|ready|close)$/.exec(
            url.pathname.slice(prefix.length),
        );
        const channel = match && this.channels.get(match[1]);
        const token = Buffer.from(request.headers.get('authorization') ?? '');
        const expected = Buffer.from(
            channel ? `Bearer ${channel.link.token}` : '',
        );
        if (
            !channel ||
            !channel.serving ||
            token.length !== expected.length ||
            !timingSafeEqual(token, expected) ||
            request.headers.get('x-data-binding') !== this.options.binding
        ) {
            return new Response(null, { status: 401, headers: HEADERS });
        }
        const leg = match![2];
        if (
            (leg === 'ready' && request.method !== 'POST') ||
            (leg === 'get' && request.method !== 'GET') ||
            (leg === 'put' && request.method !== 'PUT') ||
            (leg === 'ack' && !['GET', 'POST'].includes(request.method)) ||
            (leg === 'close' && request.method !== 'DELETE')
        ) {
            return new Response(null, { status: 405, headers: HEADERS });
        }
        // Expiry gates initial leg admission, not a healthy long-running transfer.
        if (
            leg !== 'close' &&
            !(leg === 'ack' && request.method === 'POST') &&
            channel.ticketExpired()
        ) {
            channel.close('Data ticket expired');
            return new Response(null, { status: 410, headers: HEADERS });
        }
        const cancel = () => channel.close('HTTP data request aborted');
        request.signal.addEventListener('abort', cancel, { once: true });
        if (
            !(
                leg === 'close' ||
                leg === 'ready' ||
                (leg === 'ack' && request.method === 'POST')
            )
        ) {
            void channel.closed
                .finally(() =>
                    request.signal.removeEventListener('abort', cancel),
                )
                .catch(() => {});
        }
        if (request.signal.aborted) cancel();
        const transient =
            leg === 'close' ||
            leg === 'ready' ||
            (leg === 'ack' && request.method === 'POST');
        try {
            if (leg === 'close') {
                channel.close();
                return new Response(null, { status: 204, headers: HEADERS });
            }
            if (leg === 'ready') {
                check(
                    !request.headers.has('transfer-encoding') &&
                        (!request.headers.has('content-length') ||
                            request.headers.get('content-length') === '0'),
                    'Data ready must have no body',
                );
                channel.claim(leg);
                await channel.waitConnected();
                return new Response(null, { status: 204, headers: HEADERS });
            }
            if (leg === 'ack' && request.method === 'POST') {
                channel.beginAck();
                const text = await readSmallBody(request, channel);
                channel.applyAck(JSON.parse(text));
                return new Response(null, { status: 204, headers: HEADERS });
            }
            channel.claim(leg);
            if (leg === 'get')
                return new Response(channel.outgoing, {
                    headers: {
                        ...HEADERS,
                        'Content-Type': 'application/octet-stream',
                    },
                });
            if (leg === 'ack')
                return new Response(channel.acknowledgments, {
                    headers: {
                        ...HEADERS,
                        'Content-Type': 'application/x-ndjson',
                    },
                });
            check(
                !request.headers.get('content-encoding') ||
                    request.headers.get('content-encoding') === 'identity',
                'Encoded data body is forbidden',
            );
            await channel.receive(request.body);
            return new Response(null, { status: 204, headers: HEADERS });
        } catch (error) {
            channel.fail(errorOf(error));
            return new Response(null, { status: 409, headers: HEADERS });
        } finally {
            if (transient) {
                if (leg === 'ack') channel.endAck();
                request.signal.removeEventListener('abort', cancel);
            }
        }
    }

    close(reason = 'Data connection closed') {
        if (this.stopped) return;
        this.stopped = true;
        for (const pending of this.pendingOpens) pending.abort();
        this.pendingOpens.clear();
        for (const channel of this.channels.values()) channel.close(reason);
        this.channels.clear();
        this.usedLinks.clear();
    }
}

async function readSmallBody(
    request: Request,
    channel: HttpChannel,
): Promise<string> {
    const reader = request.body?.getReader();
    check(reader, 'Missing acknowledgment');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const next = await channel.wait(reader.read());
            if (next.done) break;
            size += next.value.byteLength;
            check(size <= 256, 'Acknowledgment metadata limit');
            chunks.push(next.value);
        }
        return Buffer.concat(chunks).toString('utf8');
    } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
