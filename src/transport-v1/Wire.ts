import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const WIRE = Object.freeze({
    protocol: 'cc.qqxing.reverse.v1',
    window: 256 * 1024,
    chunk: 64 * 1024,
    channels: 4,
    receiveBudget: 1024 * 1024,
    queue: 8 * 1024 * 1024,
    reserve: 64 * 1024,
    mcp: 4 * 1024 * 1024,
    control: 64 * 1024,
    binary: 20 + 64 * 1024,
});
export type ChannelPurpose = 'cc.qqxing/files' | 'cc.qqxing/terminal';
export type Direction = 'host-to-remote' | 'remote-to-host' | 'duplex';
export interface ChannelOpen {
    purpose: ChannelPurpose;
    resourceId: string;
    direction: Direction;
}
export interface DataChannel {
    id: number;
    write(data: Uint8Array): Promise<void>;
    end(): Promise<void>;
    close(code?: string): void;
    readonly closed: Promise<void>;
}
export interface ChannelReceiver {
    data(data: Uint8Array): Promise<void>;
    end(): Promise<void> | void;
    close(reason?: Error): void;
}
export function assert(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
}
export function safe(value: unknown): value is number {
    return (
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    );
}
export function validId(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value > 0 &&
        value <= 0xffffffff &&
        value % 2 === 1
    );
}
export function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
export class ChannelCancelled extends Error {}
export type Envelope =
    | { kind: 'ready'; epoch: string }
    | { kind: 'paired'; epoch: string }
    | { kind: 'mcp'; message: JSONRPCMessage }
    | ({ kind: 'channel.open'; id: number; window: number } & ChannelOpen)
    | { kind: 'channel.accept'; id: number; window: number }
    | { kind: 'channel.credit'; id: number; consumed: number }
    | { kind: 'channel.end'; id: number; offset: number }
    | { kind: 'channel.close'; id: number; code: string };
export function decodeText(bytes: Buffer): Envelope {
    assert(bytes.length <= WIRE.mcp, 'Text message limit');
    const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    assert(
        value && typeof value === 'object' && !Array.isArray(value),
        'Invalid envelope',
    );
    if (value.kind === 'mcp') {
        assert(
            JSONRPCMessageSchema.safeParse(value.message).success,
            'Invalid MCP JSON-RPC',
        );
        return value;
    }
    assert(bytes.length <= WIRE.control, 'Control message limit');
    if (value.kind === 'ready' || value.kind === 'paired') {
        assert(
            typeof value.epoch === 'string' &&
                /^[0-9a-f]{32}$/.test(value.epoch),
            'Invalid epoch',
        );
        return value;
    }
    assert(validId(value.id), 'Invalid channel id');
    switch (value.kind) {
        case 'channel.open':
            assert(
                value.purpose === 'cc.qqxing/files' ||
                    value.purpose === 'cc.qqxing/terminal',
                'Invalid purpose',
            );
            assert(
                typeof value.resourceId === 'string' &&
                    value.resourceId.length > 0 &&
                    value.resourceId.length <= 256,
                'Invalid resource id',
            );
            assert(
                ['host-to-remote', 'remote-to-host', 'duplex'].includes(
                    value.direction,
                ),
                'Invalid direction',
            );
            assert(value.window === WIRE.window, 'Invalid window');
            break;
        case 'channel.accept':
            assert(value.window === WIRE.window, 'Invalid window');
            break;
        case 'channel.credit':
            assert(safe(value.consumed), 'Invalid credit');
            break;
        case 'channel.end':
            assert(safe(value.offset), 'Invalid end offset');
            break;
        case 'channel.close':
            assert(
                typeof value.code === 'string' &&
                    /^[A-Za-z0-9_.-]{1,64}$/.test(value.code),
                'Invalid close code',
            );
            break;
        default:
            throw new Error('Unknown envelope kind');
    }
    return value;
}
export function encodeFrame(
    id: number,
    offset: number,
    data: Uint8Array,
): Buffer {
    assert(
        validId(id) &&
            safe(offset) &&
            data.byteLength > 0 &&
            data.byteLength <= WIRE.chunk &&
            safe(offset + data.byteLength),
        'Invalid outgoing DATA',
    );
    const bytes = Buffer.allocUnsafe(20 + data.byteLength);
    bytes.write('CAEX', 0, 'ascii');
    bytes[4] = 1;
    bytes[5] = 1;
    bytes.writeUInt16BE(0, 6);
    bytes.writeUInt32BE(id, 8);
    bytes.writeBigUInt64BE(BigInt(offset), 12);
    bytes.set(data, 20);
    return bytes;
}
export function decodeFrame(bytes: Buffer) {
    assert(
        bytes.length > 20 && bytes.length <= WIRE.binary,
        'Binary message limit',
    );
    assert(
        bytes[0] === 0x43 &&
            bytes[1] === 0x41 &&
            bytes[2] === 0x45 &&
            bytes[3] === 0x58 &&
            bytes[4] === 1 &&
            bytes[5] === 1 &&
            bytes.readUInt16BE(6) === 0,
        'Invalid DATA header',
    );
    const id = bytes.readUInt32BE(8);
    const offset = bytes.readBigUInt64BE(12);
    assert(
        validId(id) && offset <= BigInt(Number.MAX_SAFE_INTEGER),
        'Invalid DATA id/offset',
    );
    assert(safe(Number(offset) + bytes.length - 20), 'DATA offset overflow');
    return { id, offset: Number(offset), data: bytes.subarray(20) };
}
export function canSend(
    role: 'host' | 'remote',
    direction: Direction,
): boolean {
    return (
        direction === 'duplex' ||
        direction === (role === 'host' ? 'host-to-remote' : 'remote-to-host')
    );
}
