import * as fs from 'node:fs/promises';
import { constants, rmSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
    FILE_LIMIT,
    FileCore,
    FileError,
    Mutex,
    fail,
    fileError,
    secureDirectory,
} from './file-core.js';
import {
    FILES,
    LEASE_MS,
    MAX_RECORDS,
    RECORD_TTL_MS,
} from '../extensions/protocol.js';
import type {
    ChannelOpen,
    ChannelReceiver,
    DataChannel,
} from '../data/types.js';

export interface PrepareParams {
    operationId: string;
    mode: 'read' | 'write';
    rootId: string;
    path: string;
    size?: number;
    sha256?: string;
    overwrite?: boolean;
    expectedVersion?: string;
}
type State =
    | 'preparing'
    | 'prepared'
    | 'streaming'
    | 'ready'
    | 'complete'
    | 'committing'
    | 'committed'
    | 'released'
    | 'expired'
    | 'failed'
    | 'unknown';
interface Prepared {
    params: PrepareParams;
    fingerprint: string;
    transferId: string;
    state: State;
    expires: number;
    finished?: number;
    directory?: string;
    staging?: string;
    size: number;
    loaded: number;
    version?: string;
    sha256?: string;
    error?: { code: string; message: string };
    result?: { path: string; size: number; sha256: string; version: string };
    published?: false;
    commitHash?: string;
    job?: Promise<unknown>;
    cleanup?: Promise<void>;
    commit?: Promise<void>;
    bound: boolean;
    fd?: FileHandle;
    hash: ReturnType<typeof createHash>;
    io: Mutex;
    abort: AbortController;
    channel?: DataChannel;
}
const terminal = (state: State) =>
    ['committed', 'released', 'expired', 'failed', 'unknown'].includes(state);
const managers = new Set<TransferManager>();
process.once('exit', () => {
    for (const manager of managers) manager.cleanupOnExit();
});

/** Session-owned files v1 resources, independent of the data session transport. */
export class TransferManager {
    private readonly operations = new Map<string, Prepared>();
    private readonly resources = new Map<string, Prepared>();
    private disposed = false;
    private closing?: Promise<void>;
    private readonly timer: NodeJS.Timeout;

    constructor(
        private readonly core: FileCore,
        private readonly runtimeDirectory: string,
        private readonly authorize: () => void = () => {},
    ) {
        managers.add(this);
        this.timer = setInterval(() => this.sweep(), 1000);
        this.timer.unref();
    }

    private sweep() {
        const now = performance.now();
        for (const [id, item] of this.operations) {
            if (
                !terminal(item.state) &&
                item.state !== 'committing' &&
                item.expires <= now
            )
                this.finish(item, 'expired');
            if (
                item.finished !== undefined &&
                now - item.finished >= RECORD_TTL_MS &&
                !item.job &&
                !item.cleanup
            ) {
                this.operations.delete(id);
                this.resources.delete(item.transferId);
            }
        }
    }

    private alive(item: Prepared) {
        if (this.disposed) fail('STALE_CONNECTION', 'File session is closed');
        if (
            item.expires <= performance.now() &&
            !terminal(item.state) &&
            item.state !== 'committing'
        )
            this.finish(item, 'expired');
        if (item.state === 'expired')
            fail('LEASE_EXPIRED', 'Transfer lease expired');
        if (terminal(item.state))
            fail('INVALID_STATE', 'Transfer is no longer active');
    }

    private finish(item: Prepared, state: State, error?: unknown) {
        if (terminal(item.state) || item.state === 'committing') return;
        item.state = state;
        item.finished = performance.now();
        item.published = false;
        if (error) {
            const failure = fileError(error);
            item.error = { code: failure.code, message: failure.message };
        }
        item.abort.abort();
        item.channel?.close(state.toUpperCase());
        void this.cleanup(item).catch(() => {});
    }

    private cleanup(item: Prepared): Promise<void> {
        if (item.cleanup) return item.cleanup;
        const pending = item.job;
        const cleanup = (async () => {
            await pending?.catch(() => {});
            await item.io.run(async () => {
                const fd = item.fd;
                item.fd = undefined;
                await fd?.close().catch(() => {});
                if (item.directory)
                    await fs.rm(item.directory, {
                        recursive: true,
                        force: true,
                    });
            });
        })();
        item.cleanup = cleanup;
        void cleanup
            .finally(() => {
                if (item.cleanup === cleanup) item.cleanup = undefined;
            })
            .catch(() => {});
        return cleanup;
    }

    private view(item: Prepared) {
        const operationId = item.params.operationId;
        if (item.state === 'preparing')
            return { operationId, state: item.state };
        if (item.state === 'committed')
            return {
                operationId,
                transferId: item.transferId,
                state: item.state,
                result: item.result,
            };
        if (item.state === 'committing')
            return {
                operationId,
                transferId: item.transferId,
                state: item.state,
            };
        if (item.state === 'failed')
            return {
                operationId,
                state: item.state,
                published: false,
                error: item.error,
            };
        if (item.state === 'released' || item.state === 'expired')
            return { operationId, state: item.state, published: false };
        if (item.state === 'unknown') return { operationId, state: item.state };
        return {
            operationId,
            transferId: item.transferId,
            state: item.state,
            loaded: item.loaded,
            size: item.size,
        };
    }

    private preparedView(item: Prepared) {
        if (terminal(item.state) || item.state === 'committing')
            return this.view(item);
        return {
            ...this.view(item),
            name: path.basename(item.params.path),
            ...(item.sha256 ? { sha256: item.sha256 } : {}),
            ...(item.version ? { version: item.version } : {}),
            expiresInMs: Math.max(
                1,
                Math.ceil(item.expires - performance.now()),
            ),
            recordTtlMs: RECORD_TTL_MS,
        };
    }

    async prepare(params: PrepareParams) {
        this.authorize();
        if (this.disposed) fail('STALE_CONNECTION', 'File session is closed');
        this.sweep();
        const normalized = { ...params, overwrite: params.overwrite ?? false };
        const fingerprint = JSON.stringify([
            normalized.mode,
            normalized.rootId,
            normalized.path,
            normalized.size ?? null,
            normalized.sha256 ?? null,
            normalized.overwrite,
            normalized.expectedVersion ?? null,
        ]);
        const existing = this.operations.get(params.operationId);
        if (existing) {
            if (existing.fingerprint && existing.fingerprint !== fingerprint)
                fail('IDEMPOTENCY_CONFLICT', 'Operation parameters changed');
            await existing.job?.catch(() => {});
            return this.preparedView(existing);
        }
        if (this.operations.size >= MAX_RECORDS)
            fail('LIMIT_EXCEEDED', 'Transfer record limit reached');
        if (
            [...this.operations.values()].filter(
                (item) => !terminal(item.state),
            ).length >= 2
        )
            fail(
                'LIMIT_EXCEEDED',
                'At most two transfers are allowed per session',
            );
        if (params.mode === 'write') {
            if (
                !Number.isSafeInteger(params.size) ||
                params.size! < 0 ||
                params.size! > FILE_LIMIT
            )
                fail('INVALID_PARAMS', 'Write size must be 0..100 MiB');
            if (!!params.overwrite !== (params.expectedVersion !== undefined))
                fail(
                    'INVALID_PARAMS',
                    'Overwrite requires expectedVersion; new files forbid it',
                );
        } else if (
            params.size !== undefined ||
            params.sha256 !== undefined ||
            params.overwrite !== undefined ||
            params.expectedVersion !== undefined
        ) {
            fail(
                'INVALID_PARAMS',
                'Read prepare does not accept write parameters',
            );
        }
        const item: Prepared = {
            params: normalized,
            fingerprint,
            transferId: randomUUID(),
            state: 'preparing',
            expires: performance.now() + LEASE_MS,
            size: params.size ?? 0,
            loaded: 0,
            bound: false,
            hash: createHash('sha256'),
            io: new Mutex(),
            abort: new AbortController(),
        };
        // Register synchronously, before the first filesystem await, including in-flight deduplication.
        this.operations.set(params.operationId, item);
        this.resources.set(item.transferId, item);
        const job = this.prepareItem(item);
        item.job = job;
        try {
            await job;
        } finally {
            item.job = undefined;
            if (terminal(item.state)) await this.cleanup(item);
        }
        return this.preparedView(item);
    }

    private async prepareItem(item: Prepared) {
        try {
            const p = item.params;
            if (p.mode === 'write')
                await this.core.mutex.run(() =>
                    this.core.checkDestination(
                        p.rootId,
                        p.path,
                        p.overwrite,
                        p.expectedVersion,
                    ),
                );
            else await this.core.resolve(p.rootId, p.path);
            this.alive(item);
            await secureDirectory(this.runtimeDirectory);
            this.alive(item);
            item.directory = await fs.mkdtemp(
                path.join(this.runtimeDirectory, 'transfer-'),
            );
            item.staging = path.join(item.directory, 'data');
            this.alive(item);
            if (p.mode === 'read') {
                const snapshot = await this.core.snapshot(
                    p.rootId,
                    p.path,
                    item.staging,
                );
                item.size = snapshot.size;
                item.version = snapshot.version;
                item.sha256 = snapshot.version;
            }
            this.alive(item);
            this.authorize();
            item.state = 'prepared';
        } catch (error) {
            this.finish(item, 'failed', error);
            throw error;
        }
    }

    status(operationId: string) {
        this.sweep();
        const item = this.operations.get(operationId);
        return item ? this.view(item) : { operationId, state: 'unknown' };
    }

    renew(operationId: string) {
        this.authorize();
        const item = this.operations.get(operationId);
        if (!item) fail('RESOURCE_NOT_FOUND', 'Unknown transfer');
        this.alive(item);
        if (item.state === 'committing')
            fail('TOO_LATE', 'Commit already admitted');
        item.expires = performance.now() + LEASE_MS;
        return { operationId, expiresInMs: LEASE_MS };
    }

    private async bind(item: Prepared, channel: DataChannel) {
        this.authorize();
        this.alive(item);
        if (item.state !== 'prepared' || item.bound)
            fail('INVALID_STATE', 'Transfer may be bound only once');
        item.bound = true;
        item.state = 'streaming';
        item.channel = channel;
        if (item.params.mode === 'write') {
            try {
                await item.io.run(async () => {
                    this.alive(item);
                    item.fd = await fs.open(
                        item.staging!,
                        constants.O_WRONLY |
                            constants.O_CREAT |
                            constants.O_EXCL |
                            constants.O_NOFOLLOW,
                        0o600,
                    );
                    this.alive(item);
                });
            } catch (error) {
                this.finish(item, 'failed', error);
                throw error;
            }
        }
    }

    private async write(item: Prepared, data: Uint8Array) {
        await item.io.run(async () => {
            this.authorize();
            this.alive(item);
            if (item.state !== 'streaming' || item.params.mode !== 'write')
                fail('INVALID_STATE', 'Not writable');
            if (
                data.byteLength > 65536 ||
                item.loaded + data.byteLength > item.size
            )
                fail(
                    'SIZE_MISMATCH',
                    'Data exceeds prepared size or frame limit',
                );
            let written = 0;
            while (written < data.byteLength) {
                const result = await item.fd!.write(
                    data,
                    written,
                    data.byteLength - written,
                    item.loaded + written,
                );
                if (!result.bytesWritten)
                    fail('IO_ERROR', 'Unable to write transfer data');
                written += result.bytesWritten;
            }
            item.hash.update(data);
            item.loaded += written;
            this.alive(item);
        });
    }

    private async endWrite(item: Prepared) {
        await item.io.run(async () => {
            this.alive(item);
            if (item.state !== 'streaming')
                fail('INVALID_STATE', 'Transfer is not streaming');
            if (item.loaded !== item.size)
                fail('SIZE_MISMATCH', 'Transfer is incomplete');
            await item.fd!.sync();
            await item.fd!.close();
            item.fd = undefined;
            item.sha256 = item.hash.digest('hex');
            if (item.params.sha256 && item.params.sha256 !== item.sha256)
                fail('HASH_MISMATCH', 'Transfer digest differs');
            this.alive(item);
            item.state = 'ready';
        });
    }

    private async read(
        item: Prepared,
        write: (data: Uint8Array) => Promise<void>,
    ) {
        const input = (
            await fs.open(
                item.staging!,
                constants.O_RDONLY | constants.O_NOFOLLOW,
            )
        ).createReadStream({ highWaterMark: 65536 });
        const abort = () =>
            input.destroy(new FileError('INVALID_STATE', 'Transfer closed'));
        item.abort.signal.addEventListener('abort', abort, { once: true });
        try {
            for await (const chunk of input) {
                this.authorize();
                this.alive(item);
                await write(chunk);
                item.loaded += chunk.byteLength;
            }
            this.alive(item);
            if (item.loaded !== item.size)
                fail('SIZE_MISMATCH', 'Snapshot is incomplete');
            item.state = 'complete';
        } finally {
            item.abort.signal.removeEventListener('abort', abort);
            input.destroy();
        }
    }

    async acceptChannel(
        open: ChannelOpen,
        channel: DataChannel,
    ): Promise<ChannelReceiver> {
        const item = this.resources.get(open.resourceId);
        if (!item)
            fail('RESOURCE_NOT_FOUND', 'Unknown transfer in this session');
        const direction =
            item.params.mode === 'write' ? 'host-to-remote' : 'remote-to-host';
        if (open.purpose !== FILES || open.direction !== direction)
            fail('INVALID_PARAMS', 'Invalid files channel direction');
        await this.bind(item, channel);
        const failure = (error: unknown) => {
            this.finish(item, 'failed', error);
        };
        if (item.params.mode === 'read') {
            // Start asynchronously: the data writer waits for channel acceptance.
            const job = this.read(item, (data) => channel.write(data))
                .then(() => channel.end())
                .catch(failure);
            item.job = job;
            void job
                .finally(() => {
                    if (item.job === job) item.job = undefined;
                })
                .catch(() => {});
        }
        return {
            data: async (data) => {
                try {
                    if (item.params.mode !== 'write')
                        fail(
                            'INVALID_STATE',
                            'Read channel cannot receive data',
                        );
                    // Resolution, and therefore wire credit, follows the async disk write.
                    await this.write(item, data);
                } catch (error) {
                    failure(error);
                    throw error;
                }
            },
            end: async () => {
                if (item.params.mode !== 'write') return;
                try {
                    await this.endWrite(item);
                } catch (error) {
                    failure(error);
                    throw error;
                }
            },
            close: (reason) => {
                if (
                    item.state === 'ready' ||
                    item.state === 'complete' ||
                    terminal(item.state) ||
                    item.state === 'committing'
                )
                    return;
                failure(
                    reason ??
                        new FileError(
                            'INVALID_STATE',
                            'Channel closed before completion',
                        ),
                );
            },
        };
    }

    async commit(operationId: string, transferId: string, sha256: string) {
        this.authorize();
        const item = this.operations.get(operationId);
        if (
            !item ||
            item.transferId !== transferId ||
            item.params.mode !== 'write'
        )
            fail('RESOURCE_NOT_FOUND', 'Unknown write transfer');
        if (item.commitHash !== undefined) {
            if (item.commitHash !== sha256)
                fail('IDEMPOTENCY_CONFLICT', 'Commit digest changed');
            return this.view(item);
        }
        this.alive(item);
        if (item.state !== 'ready')
            fail('NOT_READY', 'Write stream must finish before commit');
        if (sha256 !== item.sha256) {
            this.finish(
                item,
                'failed',
                new FileError('HASH_MISMATCH', 'Transfer digest differs'),
            );
            fail('HASH_MISMATCH', 'Transfer digest differs');
        }
        // Synchronous admission fences cancellation before any await or publication.
        item.commitHash = sha256;
        item.state = 'committing';
        const commit = (async () => {
            try {
                const result = await this.core.commitUpload(
                    item.params.rootId,
                    item.params.path,
                    item.staging!,
                    item.params.overwrite ?? false,
                    item.params.expectedVersion,
                    sha256,
                );
                item.result = { ...result, sha256 };
                item.state = 'committed';
            } catch (error) {
                // A post-link/rename I/O failure can have published. Never claim rollback.
                if (error instanceof FileError) {
                    item.state = 'failed';
                    item.published = false;
                    item.error = { code: error.code, message: error.message };
                } else {
                    item.state = 'unknown';
                }
                throw error;
            } finally {
                item.finished = performance.now();
            }
        })();
        item.commit = commit;
        try {
            await commit;
        } finally {
            item.commit = undefined;
            await this.cleanup(item).catch(() => {});
        }
        return this.view(item);
    }

    release(operationId: string) {
        const item = this.operations.get(operationId);
        if (!item) {
            // A cancel-before-prepare tombstone prevents a delayed create on this operation.
            this.sweep();
            if (this.operations.size >= MAX_RECORDS)
                fail('LIMIT_EXCEEDED', 'Transfer record limit reached');
            const tombstone: Prepared = {
                params: { operationId, mode: 'read', rootId: '', path: '' },
                fingerprint: '',
                transferId: randomUUID(),
                state: 'released',
                expires: 0,
                finished: performance.now(),
                size: 0,
                loaded: 0,
                bound: false,
                hash: createHash('sha256'),
                io: new Mutex(),
                abort: new AbortController(),
            };
            this.operations.set(operationId, tombstone);
            return this.view(tombstone);
        }
        if (
            item.state === 'committing' ||
            item.state === 'committed' ||
            (item.state === 'unknown' && item.commitHash !== undefined)
        )
            fail('TOO_LATE', 'Commit already admitted');
        this.sweep();
        if (!terminal(item.state)) this.finish(item, 'released');
        return this.view(item);
    }

    cleanupOnExit() {
        for (const item of this.operations.values()) {
            if (item.directory) {
                try {
                    rmSync(item.directory, { recursive: true, force: true });
                } catch {
                    /* process exit */
                }
            }
        }
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.disposed = true;
        clearInterval(this.timer);
        for (const item of this.operations.values())
            this.finish(item, 'released');
        this.closing = Promise.allSettled(
            [...this.operations.values()].map(async (item) => {
                // Admission owns publication until it settles. Never release its
                // state or remove a staging directory underneath commitUpload.
                await item.commit?.catch(() => {});
                await this.cleanup(item);
            }),
        ).then((results) => {
            const errors = results
                .filter((result) => result.status === 'rejected')
                .map((result) => result.reason);
            if (errors.length)
                throw new AggregateError(errors, 'Transfer cleanup failed');
            // Keep synchronous exit fallback until every async cleanup succeeds.
            managers.delete(this);
        });
        return this.closing;
    }
}
