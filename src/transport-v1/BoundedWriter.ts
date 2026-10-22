import type WebSocket from 'ws';
import { ChannelCancelled, WIRE, deferred } from './Wire.js';

export interface WriteReservation {
    bytes: number;
    active: boolean;
}
interface Entry {
    value: string | Buffer;
    bytes: number;
    id?: number;
    reserve: boolean;
    open: boolean;
    beforeSend?: () => void;
    done: ReturnType<typeof deferred<void>>;
}
/** One socket send in flight. Control has reserved capacity; channel FIFOs rotate. */
export class BoundedWriter {
    private control: Entry[] = [];
    private channels = new Map<number, Entry[]>();
    private inflight?: Entry;
    private bytes = 0;
    private reserved = 0;
    private count = 0;
    private heldBytes = 0;
    private heldCount = 0;
    private stopped = false;
    constructor(
        private readonly ws: WebSocket,
        private readonly fail: (error: Error) => void,
    ) {}

    reserve(bytes: number): WriteReservation | undefined {
        if (
            this.stopped ||
            this.heldCount + this.count >= 2048 ||
            this.bytes + this.heldBytes + this.ws.bufferedAmount + bytes >
                WIRE.queue
        )
            return undefined;
        this.heldBytes += bytes;
        this.heldCount++;
        return { bytes, active: true };
    }
    releaseReservation(reservation: WriteReservation) {
        if (!reservation.active) return;
        reservation.active = false;
        this.heldBytes -= reservation.bytes;
        this.heldCount--;
    }
    send(
        value: string | Buffer,
        options: {
            id?: number;
            ordered?: boolean;
            reserve?: boolean;
            open?: boolean;
            beforeSend?: () => void;
            reservation?: WriteReservation;
        } = {},
    ): Promise<void> {
        if (options.reservation) this.releaseReservation(options.reservation);
        if (this.stopped) return Promise.reject(new Error('Writer closed'));
        const bytes =
            typeof value === 'string' ? Buffer.byteLength(value) : value.length;
        const reserve = options.reserve ?? false;
        if (
            this.count + this.heldCount >= 2048 ||
            (reserve
                ? this.reserved + bytes > WIRE.reserve
                : this.bytes + this.heldBytes + this.ws.bufferedAmount + bytes >
                  WIRE.queue)
        ) {
            return Promise.reject(new Error('Outgoing queue limit'));
        }
        if (reserve) this.reserved += bytes;
        else this.bytes += bytes;
        this.count++;
        const entry: Entry = {
            value,
            bytes,
            id: options.id,
            reserve,
            open: options.open ?? false,
            beforeSend: options.beforeSend,
            done: deferred<void>(),
        };
        if (options.ordered && options.id !== undefined) {
            let queue = this.channels.get(options.id);
            if (!queue) {
                queue = [];
                this.channels.set(options.id, queue);
            }
            queue.push(entry);
        } else this.control.push(entry);
        this.pump();
        return entry.done.promise;
    }
    private release(entry: Entry) {
        if (entry.reserve) this.reserved -= entry.bytes;
        else this.bytes -= entry.bytes;
        this.count--;
    }
    private pump() {
        if (this.stopped || this.inflight) return;
        let entry = this.control.shift();
        if (!entry) {
            const first = this.channels.entries().next().value as
                | [number, Entry[]]
                | undefined;
            if (first) {
                const [id, queue] = first;
                entry = queue.shift();
                this.channels.delete(id);
                if (queue.length) this.channels.set(id, queue);
            }
        }
        if (!entry) return;
        if (this.ws.bufferedAmount + entry.bytes > WIRE.queue + WIRE.reserve) {
            this.release(entry);
            entry.done.reject(new Error('Socket queue limit'));
            this.fail(new Error('Socket queue limit'));
            return;
        }
        this.inflight = entry;
        const current = entry;
        try {
            current.beforeSend?.();
            this.ws.send(
                current.value,
                { binary: typeof current.value !== 'string', compress: false },
                (error) => {
                    if (this.inflight !== current) return;
                    this.inflight = undefined;
                    this.release(current);
                    if (error) {
                        current.done.reject(error);
                        this.fail(error);
                    } else {
                        current.done.resolve();
                        this.pump();
                    }
                },
            );
        } catch (error) {
            this.inflight = undefined;
            this.release(current);
            current.done.reject(error as Error);
            this.fail(error as Error);
        }
    }
    cancel(id: number, preserveOpen = false) {
        const remove = (entries: Entry[]) =>
            entries.filter((entry) => {
                if (entry.id !== id || (preserveOpen && entry.open))
                    return true;
                this.release(entry);
                entry.done.reject(new ChannelCancelled('Channel cancelled'));
                return false;
            });
        this.control = remove(this.control);
        const queue = this.channels.get(id);
        if (queue) {
            const kept = remove(queue);
            if (kept.length) this.channels.set(id, kept);
            else this.channels.delete(id);
        }
    }
    close(error: Error) {
        if (this.stopped) return;
        this.stopped = true;
        for (const entry of [
            ...this.control,
            ...[...this.channels.values()].flat(),
            ...(this.inflight ? [this.inflight] : []),
        ])
            entry.done.reject(error);
        this.control = [];
        this.channels.clear();
        this.inflight = undefined;
        this.bytes = this.reserved = this.count = 0;
    }
}
