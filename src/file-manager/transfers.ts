import * as fs from 'node:fs/promises';
import { constants, rmSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
    CHUNK_LIMIT,
    FILE_LIMIT,
    FileCore,
    FileError,
    Mutex,
    fail,
    secureDirectory,
} from './file-core.js';

export const FTE_PREFIX = 'cc.qqxing/file-transfer/';
const TTL = 300;
// Stdio's existing EOF handler exits immediately. Only our own private staging is removed here.
const liveManagers = new Set<TransferManager>();
process.once('exit', () => {
    for (const manager of liveManagers) manager.cleanupOnExit();
});
interface Prepared {
    handle: string;
    uri: string;
    directory: string;
    staging: string;
    rootId: string;
    path: string;
    name: string;
    size: number;
    direction: 'read' | 'write';
    version?: string;
    overwrite: boolean;
    expectedVersion?: string;
    expires: number;
    transferId?: string;
    fd?: FileHandle;
    offset: number;
    status: 'prepared' | 'active' | 'closed';
    hash?: string;
}
function fteFail(code: string, message: string, rpcCode: number): never {
    throw new FileError(code, message, rpcCode);
}
function integer(
    value: unknown,
    name: string,
    min: number,
    max: number,
): number {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < min ||
        value > max
    )
        fteFail('INVALID_OFFSET', `Invalid ${name}`, -32002);
    return value;
}
function string(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value)
        fail('INVALID_PARAMS', `Missing ${name}`);
    return value;
}
/** Deliberately handle-only FTE adapter. No file:// paths, no direct target writes. */
export class TransferManager {
    private readonly prepared = new Map<string, Prepared>();
    private readonly transfers = new Map<string, Prepared>();
    private readonly mutex = new Mutex();
    private readonly timer: NodeJS.Timeout;
    private disposed = false;
    constructor(
        private readonly core: FileCore,
        private readonly runtimeDirectory: string,
    ) {
        liveManagers.add(this);
        this.timer = setInterval(() => {
            void this.mutex.run(() => this.sweep()).catch(() => {});
        }, 15000);
        this.timer.unref();
    }
    private async remove(item: Prepared) {
        // Invalidate first; a failed cleanup must not leave an accessible stale handle.
        this.prepared.delete(item.handle);
        if (item.transferId) this.transfers.delete(item.transferId);
        const fd = item.fd;
        item.fd = undefined;
        try {
            await fd?.close();
        } finally {
            await fs.rm(item.directory, { recursive: true, force: true });
        }
    }
    private async sweep() {
        const now = Date.now();
        for (const item of this.prepared.values())
            if (item.expires <= now) await this.remove(item);
    }
    private async operation<T>(fn: () => Promise<T>): Promise<T> {
        return this.mutex.run(async () => {
            if (this.disposed) fail('SESSION_CLOSED', 'Session is closed');
            await this.sweep();
            return fn();
        });
    }
    private async make(
        rootId: string,
        file: string,
        size: number,
        direction: 'read' | 'write',
        overwrite = false,
        expectedVersion?: string,
    ): Promise<Prepared> {
        if (this.prepared.size >= 2)
            fail(
                'TRANSFER_LIMIT',
                'At most 2 prepared transfers are allowed per session',
            );
        await secureDirectory(this.runtimeDirectory);
        const directory = await fs.mkdtemp(
            path.join(this.runtimeDirectory, 'transfer-'),
        );
        const handle = randomUUID();
        return {
            handle,
            uri: `staff-transfer://${handle}`,
            directory,
            staging: path.join(directory, 'data'),
            rootId,
            path: file,
            name: path.basename(file),
            size,
            direction,
            overwrite,
            expectedVersion,
            expires: Date.now() + TTL * 1000,
            offset: 0,
            status: 'prepared',
        };
    }
    async prepareUpload(
        rootId: string,
        file: string,
        size: number,
        overwrite = false,
        expectedVersion?: string,
    ) {
        return this.operation(async () => {
            if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT)
                fail('TOO_LARGE', 'Upload size must be 0..100 MiB');
            await this.core.mutex.run(() =>
                this.core.checkDestination(
                    rootId,
                    file,
                    overwrite,
                    expectedVersion,
                ),
            );
            const item = await this.make(
                rootId,
                file,
                size,
                'write',
                overwrite,
                expectedVersion,
            );
            this.prepared.set(item.handle, item);
            return {
                uploadHandle: item.handle,
                uri: item.uri,
                name: item.name,
                size,
                ...(expectedVersion ? { version: expectedVersion } : {}),
            };
        });
    }
    async prepareDownload(rootId: string, file: string) {
        return this.operation(async () => {
            // Validate before allocating staging; snapshot checks again inside the shared I/O mutex.
            await this.core.resolve(rootId, file);
            const item = await this.make(rootId, file, 0, 'read');
            try {
                const snapshot = await this.core.snapshot(
                    rootId,
                    file,
                    item.staging,
                );
                Object.assign(item, snapshot);
                this.prepared.set(item.handle, item);
                return {
                    downloadHandle: item.handle,
                    uri: item.uri,
                    ...snapshot,
                };
            } catch (e) {
                await this.remove(item);
                throw e;
            }
        });
    }
    private handle(handle: string, direction: Prepared['direction']) {
        const item = this.prepared.get(handle);
        if (!item || item.direction !== direction)
            fail('INVALID_HANDLE', 'Unknown or expired session-bound handle');
        item.expires = Date.now() + TTL * 1000;
        return item;
    }
    private transfer(id: unknown, direction?: Prepared['direction']) {
        const item = this.transfers.get(string(id, 'transfer_id'));
        if (!item || (direction && item.direction !== direction))
            fteFail(
                'TRANSFER_NOT_FOUND',
                'Unknown transfer in this session',
                -32000,
            );
        if (item.status !== 'active')
            fteFail('TRANSFER_NOT_FOUND', 'Transfer is closed', -32000);
        item.expires = Date.now() + TTL * 1000;
        return item;
    }
    private async hash(item: Prepared) {
        const fd = await fs.open(
            item.staging,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
            const hash = createHash('sha256');
            const buffer = Buffer.alloc(CHUNK_LIMIT);
            let offset = 0;
            while (true) {
                const { bytesRead } = await fd.read(
                    buffer,
                    0,
                    buffer.length,
                    offset,
                );
                if (!bytesRead) break;
                hash.update(buffer.subarray(0, bytesRead));
                offset += bytesRead;
            }
            if (offset !== item.size)
                fail(
                    'SIZE_MISMATCH',
                    'Staged size does not match prepared size',
                );
            return hash.digest('hex');
        } finally {
            await fd.close();
        }
    }
    async commit(uploadHandle: string, sha256: string) {
        return this.operation(async () => {
            const item = this.handle(uploadHandle, 'write');
            if (item.status !== 'closed')
                fail(
                    'TRANSFER_INCOMPLETE',
                    'write/close must finish before upload/commit',
                );
            if (!/^[a-fA-F0-9]{64}$/.test(sha256))
                fail(
                    'INVALID_PARAMS',
                    'sha256 must be a hexadecimal SHA-256 digest',
                );
            const actual = await this.hash(item);
            if (actual !== sha256.toLowerCase() || actual !== item.hash)
                fteFail(
                    'HASH_MISMATCH',
                    'Upload SHA-256 does not match',
                    -32004,
                );
            const result = await this.core.commitUpload(
                item.rootId,
                item.path,
                item.staging,
                item.overwrite,
                item.expectedVersion,
            );
            await this.remove(item);
            return result;
        });
    }
    async discard(uploadHandle: string) {
        return this.operation(async () => {
            const item = this.handle(uploadHandle, 'write');
            await this.remove(item);
            return {};
        });
    }
    async release(downloadHandle: string) {
        return this.operation(async () => {
            const item = this.handle(downloadHandle, 'read');
            await this.remove(item);
            return {};
        });
    }
    async fte(method: string, params: Record<string, unknown>) {
        return this.operation(async () => {
            if (method === 'write/init' || method === 'read/init') {
                const uri = string(params.uri, 'uri');
                const direction = method === 'write/init' ? 'write' : 'read';
                const item = [...this.prepared.values()].find(
                    (value) =>
                        value.uri === uri && value.direction === direction,
                );
                if (!item)
                    fteFail(
                        'URI_NOT_ALLOWED',
                        'Only prepared staff-transfer URIs from this session are allowed',
                        -32001,
                    );
                if (item.status !== 'prepared')
                    fteFail(
                        'WRITE_CONFLICT',
                        'Transfer already initialized',
                        -32007,
                    );
                if (
                    direction === 'write' &&
                    params.expected_size !== undefined &&
                    params.expected_size !== item.size
                )
                    fail(
                        'SIZE_MISMATCH',
                        'expected_size must equal prepared size',
                    );
                if (
                    params.force !== undefined &&
                    typeof params.force !== 'boolean'
                )
                    fail('INVALID_PARAMS', 'force must be a boolean');
                item.fd = await fs.open(
                    item.staging,
                    direction === 'write'
                        ? constants.O_WRONLY |
                              constants.O_CREAT |
                              constants.O_EXCL |
                              constants.O_NOFOLLOW
                        : constants.O_RDONLY | constants.O_NOFOLLOW,
                    0o600,
                );
                item.transferId = `staff-transfer-${randomUUID()}`;
                item.status = 'active';
                item.expires = Date.now() + TTL * 1000;
                this.transfers.set(item.transferId, item);
                return {
                    transfer_id: item.transferId,
                    ...(direction === 'read' ? { total_size: item.size } : {}),
                    ttl: TTL,
                };
            }
            if (method === 'write/chunk') {
                const item = this.transfer(params.transfer_id, 'write');
                const offset = integer(params.offset, 'offset', 0, FILE_LIMIT);
                if (offset !== item.offset)
                    fteFail(
                        'INVALID_OFFSET',
                        'Writes must be sequential without gaps or replay',
                        -32002,
                    );
                const data =
                    typeof params.data === 'string'
                        ? params.data
                        : fail('INVALID_PARAMS', 'data must be Base64');
                if (data.length > 4 * Math.ceil(CHUNK_LIMIT / 3))
                    fail('TOO_LARGE', 'Chunk limit is 512 KiB');
                if (
                    data.length % 4 !== 0 ||
                    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                        data,
                    )
                )
                    fail('INVALID_PARAMS', 'Invalid Base64');
                const bytes = Buffer.from(data, 'base64');
                if (bytes.toString('base64') !== data)
                    fail(
                        'INVALID_PARAMS',
                        'Base64 must use canonical encoding',
                    );
                if (
                    bytes.length > CHUNK_LIMIT ||
                    offset + bytes.length > item.size ||
                    offset + bytes.length > FILE_LIMIT
                )
                    fail('TOO_LARGE', 'Chunk exceeds transfer bounds');
                let written = 0;
                while (written < bytes.length) {
                    const result = await item.fd!.write(
                        bytes,
                        written,
                        bytes.length - written,
                        offset + written,
                    );
                    if (!result.bytesWritten)
                        fail('IO_ERROR', 'Unable to write chunk');
                    written += result.bytesWritten;
                }
                item.offset += written;
                return { bytes_written: written };
            }
            if (method === 'read/chunk') {
                const item = this.transfer(params.transfer_id, 'read');
                const offset = integer(params.offset, 'offset', 0, item.size);
                const length = integer(params.length, 'length', 1, CHUNK_LIMIT);
                const bytes = Buffer.alloc(
                    Math.min(length, item.size - offset),
                );
                let read = 0;
                while (read < bytes.length) {
                    const { bytesRead } = await item.fd!.read(
                        bytes,
                        read,
                        bytes.length - read,
                        offset + read,
                    );
                    if (!bytesRead)
                        fail('IO_ERROR', 'Download snapshot was truncated');
                    read += bytesRead;
                }
                return {
                    data: bytes.toString('base64'),
                    eof: offset + read >= item.size,
                };
            }
            if (method === 'write/close') {
                const item = this.transfer(params.transfer_id, 'write');
                if (item.offset !== item.size)
                    fail('SIZE_MISMATCH', 'Transfer is incomplete');
                if (
                    params.hash_algorithm !== undefined &&
                    params.hash_algorithm !== 'sha256'
                )
                    fail('INVALID_PARAMS', 'Only sha256 is supported');
                if (
                    params.expected_hash !== undefined &&
                    (typeof params.expected_hash !== 'string' ||
                        !/^[a-fA-F0-9]{64}$/.test(params.expected_hash))
                )
                    fail('INVALID_PARAMS', 'Invalid expected_hash');
                await item.fd!.sync();
                await item.fd!.close();
                item.fd = undefined;
                item.hash = await this.hash(item);
                item.status = 'closed';
                this.transfers.delete(item.transferId!);
                if (
                    params.expected_hash !== undefined &&
                    item.hash !== (params.expected_hash as string).toLowerCase()
                ) {
                    await this.remove(item);
                    fteFail(
                        'HASH_MISMATCH',
                        'Upload SHA-256 does not match',
                        -32004,
                    );
                }
                return params.expected_hash !== undefined
                    ? { verified: true }
                    : {};
            }
            if (method === 'read/close') {
                const item = this.transfer(params.transfer_id, 'read');
                await item.fd!.close();
                item.fd = undefined;
                item.status = 'closed';
                this.transfers.delete(item.transferId!);
                return {};
            }
            if (method === 'abort') {
                const item = this.transfer(params.transfer_id);
                await this.remove(item);
                return {};
            }
            throw new FileError(
                'METHOD_NOT_FOUND',
                'Unknown FTE method',
                -32601,
            );
        });
    }
    cleanupOnExit() {
        for (const item of this.prepared.values()) {
            try {
                rmSync(item.directory, { recursive: true, force: true });
            } catch {
                /* process exit */
            }
        }
    }
    async close() {
        this.disposed = true;
        liveManagers.delete(this);
        clearInterval(this.timer);
        await this.mutex.run(async () => {
            const errors: unknown[] = [];
            for (const item of this.prepared.values()) {
                try {
                    await this.remove(item);
                } catch (e) {
                    errors.push(e);
                }
            }
            if (errors.length) throw errors[0];
        });
    }
}
