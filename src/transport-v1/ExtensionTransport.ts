import WebSocket from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { BoundedWriter } from './BoundedWriter.js';
import {
    WIRE,
    ChannelCancelled,
    assert,
    safe,
    validId,
    deferred,
    canSend,
    decodeFrame,
    decodeText,
    encodeFrame,
} from './Wire.js';
import type {
    ChannelOpen,
    ChannelReceiver,
    DataChannel,
    Envelope,
} from './Wire.js';
export type {
    ChannelPurpose,
    ChannelReceiver,
    DataChannel,
    ChannelOpen,
} from './Wire.js';

class Channel implements DataChannel {
    readonly completion = deferred();
    readonly closed = this.completion.promise;
    readonly accepted = deferred();
    receiver?: ChannelReceiver;
    submitted = false;
    active = false;
    disposed = false;
    sent = 0;
    consumedByPeer = 0;
    received = 0;
    consumed = 0;
    endRequested = false;
    sentEnd: boolean;
    receivedEnd: boolean;
    endConsumed: boolean;
    private sendTail = Promise.resolve();
    private receiveTail = Promise.resolve();
    private wake = deferred();
    private readonly openTimer: ReturnType<typeof setTimeout>;
    constructor(
        readonly peer: ExtensionTransport,
        readonly id: number,
        readonly open: ChannelOpen,
    ) {
        this.sentEnd = false;
        this.receivedEnd = false;
        this.endConsumed = false;
        this.openTimer = setTimeout(() => this.close('OPEN_TIMEOUT'), 10000);
        this.openTimer.unref();
        void this.accepted.promise
            .finally(() => clearTimeout(this.openTimer))
            .catch(() => {});
    }
    write(data: Uint8Array): Promise<void> {
        if (
            this.disposed ||
            this.endRequested ||
            this.sentEnd ||
            !canSend(this.peer.role, this.open.direction)
        )
            return Promise.reject(new Error('Channel not writable'));
        if (!data.byteLength || data.byteLength > WIRE.chunk)
            return Promise.reject(new Error('Write requires 1..65536 bytes'));
        const reservation = this.peer.writer.reserve(data.byteLength + 20);
        if (!reservation)
            return Promise.reject(new Error('Pending write limit'));
        // Own the bytes: callers may reuse their buffer once write resolves.
        const payload = Buffer.from(data);
        const task = this.sendTail
            .then(async () => {
                await this.accepted.promise;
                while (
                    !this.disposed &&
                    this.sent + payload.length >
                        this.consumedByPeer + WIRE.window
                )
                    await this.wake.promise;
                assert(!this.disposed, 'Channel closed');
                const offset = this.sent;
                assert(safe(offset + payload.length), 'Send offset overflow');
                await this.peer.writer.send(
                    encodeFrame(this.id, offset, payload),
                    {
                        id: this.id,
                        ordered: true,
                        reservation,
                        beforeSend: () => {
                            this.sent = offset + payload.length;
                        },
                    },
                );
            })
            .finally(() => this.peer.writer.releaseReservation(reservation));
        this.sendTail = task.catch(() => {});
        return task;
    }
    end(): Promise<void> {
        if (!canSend(this.peer.role, this.open.direction))
            return Promise.reject(new Error('Channel is receive-only'));
        return this.queueEnd();
    }
    private queueEnd(): Promise<void> {
        if (this.disposed || this.endRequested || this.sentEnd)
            return Promise.reject(new Error('Channel already ended/closed'));
        this.endRequested = true;
        const task = this.sendTail.then(async () => {
            await this.accepted.promise;
            assert(!this.disposed, 'Channel closed');
            await this.peer.control(
                { kind: 'channel.end', id: this.id, offset: this.sent },
                this.id,
                true,
            );
            if (!this.disposed) {
                this.sentEnd = true;
                this.finish();
            }
        });
        this.sendTail = task.catch(() => {});
        return task;
    }
    close(code = 'CANCELLED'): void {
        this.peer.cancel(this, code);
    }
    credit(consumed: number) {
        assert(
            consumed >= this.consumedByPeer && consumed <= this.sent,
            'Credit beyond sent bytes',
        );
        this.consumedByPeer = consumed;
        this.wake.resolve();
        this.wake = deferred();
        this.finish();
    }
    receive(data: Buffer) {
        this.received += data.length;
        this.receiveTail = this.receiveTail
            .then(async () => {
                if (this.disposed) return;
                assert(this.receiver, 'Missing channel receiver');
                await this.receiver.data(data);
                if (this.disposed) return;
                this.consumed += data.length;
                await this.peer.control(
                    {
                        kind: 'channel.credit',
                        id: this.id,
                        consumed: this.consumed,
                    },
                    this.id,
                );
                this.finish();
            })
            .catch(() => this.close('RECEIVER_FAILED'));
    }
    receiveEnd() {
        this.receivedEnd = true;
        this.receiveTail = this.receiveTail
            .then(async () => {
                if (this.disposed) return;
                await this.receiver?.end();
                this.endConsumed = true;
                if (!canSend(this.peer.role, this.open.direction))
                    await this.queueEnd();
                this.finish();
            })
            .catch(() => this.close('RECEIVER_FAILED'));
    }
    finish() {
        if (
            !this.disposed &&
            this.sentEnd &&
            this.receivedEnd &&
            this.endConsumed &&
            this.consumed === this.received &&
            this.consumedByPeer === this.sent
        )
            this.dispose();
    }
    dispose(reason?: Error) {
        if (this.disposed) return;
        this.disposed = true;
        clearTimeout(this.openTimer);
        this.peer.channels.delete(this.id);
        this.peer.writer.cancel(this.id);
        this.accepted.reject(
            reason ?? new ChannelCancelled('Channel finished'),
        );
        this.wake.resolve();
        try {
            this.receiver?.close(reason);
        } catch {
            /* Cleanup cannot revive a channel. */
        }
        if (reason) this.completion.reject(reason);
        else this.completion.resolve();
    }
}

/** A fresh instance per paired epoch. Never set SDK sessionId (that skips initialize). */
export class ExtensionTransport implements Transport {
    onmessage?: Transport['onmessage'];
    onerror?: Transport['onerror'];
    onclose?: Transport['onclose'];
    onChannel?: (
        open: {
            id: number;
            purpose: string;
            resourceId: string;
            direction: ChannelOpen['direction'];
        },
        channel: DataChannel,
    ) => Promise<ChannelReceiver>;
    readonly writer: BoundedWriter;
    readonly channels = new Map<number, Channel>();
    readonly closed: Promise<void>;
    private readonly completion = deferred();
    private readonly paired = deferred();
    private currentEpoch = '';
    private highest = 0;
    private isPaired = false;
    private started = false;
    private stopped = false;
    private earlyMessages: JSONRPCMessage[] = [];
    private earlyBytes = 0;
    private readonly pairTimer: ReturnType<typeof setTimeout>;
    get epoch(): string {
        return this.currentEpoch;
    }

    constructor(
        readonly socket: WebSocket,
        readonly role: 'host' | 'remote',
        private readonly expectedEpoch?: string,
    ) {
        this.closed = this.completion.promise;
        this.writer = new BoundedWriter(socket, (error) => this.fail(error));
        this.pairTimer = setTimeout(
            () => this.fail(new Error('Pair timeout')),
            5000,
        );
        this.pairTimer.unref();
        socket.on('message', (raw, binary) => {
            try {
                const bytes = Array.isArray(raw)
                    ? Buffer.concat(raw)
                    : Buffer.isBuffer(raw)
                      ? raw
                      : Buffer.from(raw);
                this.receive(bytes, binary);
            } catch (error) {
                this.fail(error as Error);
            }
        });
        socket.on('error', (error) => this.fail(error));
        socket.on('close', () =>
            this.cleanup(new Error('Reverse connection closed')),
        );
    }
    waitUntilPaired(): Promise<void> {
        return this.paired.promise;
    }
    async start(): Promise<void> {
        assert(
            !this.started && !this.stopped,
            'Transport already started/closed',
        );
        this.started = true;
        await this.paired.promise;
        assert(!this.stopped, 'Transport closed');
        for (const message of this.earlyMessages.splice(0))
            this.onmessage?.(message);
        this.earlyBytes = 0;
    }
    async send(message: JSONRPCMessage): Promise<void> {
        assert(
            this.started && this.isPaired && !this.stopped,
            'Transport not paired/started',
        );
        const text = JSON.stringify({ kind: 'mcp', message });
        // Official JSON-RPC schema is the wire fence in both directions.
        decodeText(Buffer.from(text));
        await this.writer.send(text);
    }
    async close(): Promise<void> {
        this.cleanup(new Error('Transport closed'));
        this.socket.terminate();
    }
    control(
        message: Envelope,
        id?: number,
        ordered = false,
        open = false,
        beforeSend?: () => void,
    ): Promise<void> {
        return this.writer.send(JSON.stringify(message), {
            id,
            ordered,
            open,
            beforeSend,
            reserve: true,
        });
    }
    async openChannel(
        open: ChannelOpen,
        receiver: ChannelReceiver,
    ): Promise<DataChannel> {
        assert(
            this.role === 'host' && this.isPaired && !this.stopped,
            'Only paired host opens channels',
        );
        assert(this.channels.size < WIRE.channels, 'Channel limit');
        const id = this.highest + (this.highest ? 2 : 1);
        assert(validId(id), 'Channel ids exhausted; reconnect required');
        const envelope: Envelope = {
            kind: 'channel.open',
            id,
            ...open,
            window: WIRE.window,
        };
        decodeText(Buffer.from(JSON.stringify(envelope)));
        this.highest = id;
        const channel = new Channel(this, id, open);
        channel.receiver = receiver;
        this.channels.set(id, channel);
        const sent = this.control(envelope, id, false, true, () => {
            channel.submitted = true;
        });
        void sent.catch((error) => {
            if (error instanceof ChannelCancelled || channel.disposed) return;
            this.fail(error);
        });
        // Return the local reservation immediately so an opening channel can be cancelled.
        // Writes/end wait for the peer accept; no business data is sent early.
        return channel;
    }
    cancel(channel: Channel, code: string) {
        if (channel.disposed) return;
        const notify = this.role === 'remote' || channel.submitted;
        const reason = new ChannelCancelled(
            /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'CANCELLED',
        );
        channel.dispose(reason);
        if (notify && !this.stopped)
            void this.control({
                kind: 'channel.close',
                id: channel.id,
                code: reason.message,
            }).catch((error) => this.fail(error));
    }
    private receive(bytes: Buffer, binary: boolean) {
        if (this.stopped) return;
        if (binary) {
            assert(this.isPaired, 'DATA before paired');
            const frame = decodeFrame(bytes);
            const channel = this.channels.get(frame.id);
            if (!channel && frame.id <= this.highest) return;
            assert(
                channel && channel.active && !channel.receivedEnd,
                'DATA on unopened/ended channel',
            );
            assert(
                canSend(
                    this.role === 'host' ? 'remote' : 'host',
                    channel.open.direction,
                ),
                'Wrong DATA direction',
            );
            assert(
                frame.offset === channel.received &&
                    frame.offset + frame.data.length <=
                        channel.consumed + WIRE.window,
                'DATA offset/window',
            );
            channel.receive(frame.data);
            return;
        }
        const message = decodeText(bytes);
        if (message.kind === 'ready') {
            assert(
                !this.currentEpoch &&
                    (!this.expectedEpoch ||
                        this.expectedEpoch === message.epoch),
                'Unexpected ready epoch',
            );
            this.currentEpoch = message.epoch;
            return;
        }
        if (message.kind === 'paired') {
            assert(
                this.currentEpoch &&
                    this.currentEpoch === message.epoch &&
                    !this.isPaired,
                'Unexpected paired epoch',
            );
            this.isPaired = true;
            clearTimeout(this.pairTimer);
            this.paired.resolve();
            return;
        }
        assert(this.isPaired, 'Application message before paired');
        if (message.kind === 'mcp') {
            if (this.started) this.onmessage?.(message.message);
            else {
                assert(
                    this.earlyMessages.length < 64 &&
                        this.earlyBytes + bytes.length <= WIRE.mcp,
                    'Pre-start MCP limit',
                );
                this.earlyBytes += bytes.length;
                this.earlyMessages.push(message.message);
            }
            return;
        }
        if (message.kind === 'channel.open') {
            assert(
                this.role === 'remote' && message.id > this.highest,
                'Channel id reuse/issuer',
            );
            assert(this.channels.size < WIRE.channels, 'Receive window budget');
            this.highest = message.id;
            const channel = new Channel(this, message.id, message);
            channel.submitted = true;
            this.channels.set(channel.id, channel);
            void this.acceptChannel(channel);
            return;
        }
        const channel = this.channels.get(message.id);
        if (!channel && message.id <= this.highest) return;
        assert(channel, 'Unknown future channel');
        switch (message.kind) {
            case 'channel.accept':
                assert(
                    this.role === 'host' &&
                        !channel.active &&
                        channel.submitted,
                    'Invalid accept',
                );
                channel.active = true;
                channel.accepted.resolve();
                break;
            case 'channel.credit':
                assert(channel.active, 'Credit before accept');
                channel.credit(message.consumed);
                break;
            case 'channel.end':
                assert(
                    channel.active &&
                        !channel.receivedEnd &&
                        message.offset === channel.received,
                    'Invalid end',
                );
                channel.receiveEnd();
                break;
            case 'channel.close':
                channel.dispose(new ChannelCancelled(message.code));
                break;
        }
    }
    private async acceptChannel(channel: Channel) {
        try {
            assert(this.onChannel, 'No channel handler');
            const receiver = await this.onChannel(
                { id: channel.id, ...channel.open },
                channel,
            );
            if (channel.disposed) {
                receiver.close(new ChannelCancelled('Opening cancelled'));
                return;
            }
            channel.receiver = receiver;
            await this.control(
                { kind: 'channel.accept', id: channel.id, window: WIRE.window },
                channel.id,
                false,
                false,
                () => {
                    channel.active = true;
                },
            );
            if (!channel.disposed) channel.accepted.resolve();
        } catch {
            channel.close('OPEN_REJECTED');
        }
    }
    private fail(error: Error) {
        if (this.stopped) return;
        try {
            this.onerror?.(error);
        } finally {
            this.cleanup(error);
            this.socket.terminate();
        }
    }
    private cleanup(error: Error) {
        if (this.stopped) return;
        this.stopped = true;
        clearTimeout(this.pairTimer);
        this.paired.reject(error);
        for (const channel of this.channels.values()) channel.dispose(error);
        this.writer.close(error);
        this.earlyMessages = [];
        this.earlyBytes = 0;
        this.completion.resolve();
        this.onclose?.();
    }
}

export function connectExtensionTransport(
    url: string,
    role: 'host' | 'remote',
    credential: string,
    serverName?: string,
    epoch?: string,
): ExtensionTransport {
    const target = new URL(url);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(
        target.hostname,
    );
    assert(
        !target.search && !target.hash && !target.username && !target.password,
        'Invalid gateway URL',
    );
    assert(
        target.protocol === 'wss:' || (target.protocol === 'ws:' && loopback),
        'Gateway requires TLS',
    );
    assert(role !== 'host' || loopback, 'Host gateway must be loopback');
    const socket = new WebSocket(target, WIRE.protocol, {
        headers: {
            Authorization: `Bearer ${credential}`,
            ...(serverName ? { 'X-MCP-Server-Name': serverName } : {}),
        },
        perMessageDeflate: false,
        maxPayload: WIRE.mcp,
        handshakeTimeout: 5000,
        followRedirects: false,
        rejectUnauthorized: true,
    });
    return new ExtensionTransport(socket, role, epoch);
}
