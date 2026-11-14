import * as fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { ProtocolError } from '@modelcontextprotocol/server';
import type {
    ChannelOpen,
    ChannelReceiver,
    DataChannel,
} from '../data/types.js';
import { FileCore } from '../file-manager/file-core.js';
import {
    TERMINAL,
    LEASE_MS,
    MAX_RECORDS,
    RECORD_TTL_MS,
    extensionError,
} from '../extensions/protocol.js';
import { TerminalStartupError } from './pty.js';
import { TerminalStore, RETAINED_FOR_MS } from './store.js';
import type { StoredTerminal, TerminalAttachment } from './store.js';
import type { TerminalRuntime, TerminalStartupReason } from './pty.js';

export interface CreateTerminal {
    operationId: string;
    rootId: string;
    cols: number;
    rows: number;
    reuseKey?: string;
}
interface Terminal {
    params?: CreateTerminal;
    operationId: string;
    fingerprint?: string;
    terminalId?: string;
    cwd?: string;
    state: 'starting' | 'running' | 'closing' | 'closed' | 'failed';
    expires: number;
    finished?: number;
    job?: Promise<void>;
    terminal?: StoredTerminal;
    attachment?: TerminalAttachment;
    resumed?: boolean;
    bound: boolean;
    fenced: boolean;
    outputIncomplete?: boolean;
    failureReason?: TerminalStartupReason;
    channel?: DataChannel;
    queue: Buffer[];
    bytes: number;
    pumping: boolean;
    exit: { code: number | null; signal: string | null };
}
const INPUT_LIMIT = 32 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
export class TerminalSession {
    private readonly operations = new Map<string, Terminal>();
    private readonly resources = new Map<string, Terminal>();
    private outputBytes = 0;
    private disposed = false;
    private closing?: Promise<void>;
    private readonly timer: NodeJS.Timeout;
    private readonly store: TerminalStore;
    private readonly ownsStore: boolean;

    constructor(
        private readonly core: FileCore,
        private readonly runtime: TerminalRuntime,
        private readonly authorize: () => void,
        store?: TerminalStore,
    ) {
        this.ownsStore = !store;
        this.store = store ?? new TerminalStore(runtime);
        this.timer = setInterval(() => this.sweep(), 1000);
        this.timer.unref();
    }

    private sweep() {
        const now = performance.now();
        for (const [operationId, item] of this.operations) {
            if (
                (item.state === 'starting' ||
                    item.state === 'running' ||
                    (item.state === 'closed' && item.bound && !item.fenced)) &&
                item.expires <= now
            )
                this.stop(item, 'LEASE_EXPIRED', true);
            if (
                item.finished !== undefined &&
                now - item.finished >= RECORD_TTL_MS &&
                !item.job &&
                !item.pumping
            ) {
                this.operations.delete(operationId);
                if (item.terminalId) this.resources.delete(item.terminalId);
            }
        }
    }

    private check(item: Terminal) {
        this.authorize();
        if (this.disposed)
            extensionError('STALE_CONNECTION', 'Terminal connection closed');
        if (item.expires <= performance.now()) {
            this.stop(item, 'LEASE_EXPIRED', true);
            extensionError('LEASE_EXPIRED', 'Terminal lease expired');
        }
        if (
            item.fenced ||
            (item.state !== 'starting' && item.state !== 'running') ||
            (item.terminal && item.terminal.attachment !== item.attachment)
        )
            extensionError('INVALID_STATE', 'Terminal is not running');
    }

    private view(item: Terminal) {
        const base = {
            operationId: item.operationId,
            ...(item.terminalId ? { terminalId: item.terminalId } : {}),
            state: item.state,
        };
        if (item.state === 'closed')
            return {
                ...base,
                exit: item.exit,
                ...(item.outputIncomplete
                    ? {
                          error: {
                              code: 'OUTPUT_INCOMPLETE',
                              message:
                                  'PTY exited while output was backpressured; output may be incomplete',
                          },
                      }
                    : {}),
            };
        if (item.state === 'failed')
            return {
                ...base,
                error: {
                    code: 'TERMINAL_START_FAILED',
                    message: item.failureReason
                        ? `Terminal could not be started: reason=${item.failureReason}`
                        : 'Terminal could not be started',
                },
            };
        return base;
    }

    private createView(item: Terminal) {
        return {
            ...this.view(item),
            ...(item.state === 'running'
                ? {
                      rootId: item.params!.rootId,
                      path: item.cwd!,
                      shell: this.runtime.shell,
                      resumed: item.resumed ?? false,
                      retainedForMs: item.params!.reuseKey
                          ? RETAINED_FOR_MS
                          : 0,
                      leaseMs: Math.max(
                          1,
                          Math.ceil(item.expires - performance.now()),
                      ),
                      recordTtlMs: RECORD_TTL_MS,
                      link: {
                          kind: 'channel',
                          purpose: TERMINAL,
                          resourceId: item.terminalId,
                          direction: 'duplex',
                      },
                  }
                : {}),
        };
    }

    async create(params: CreateTerminal) {
        this.authorize();
        if (this.disposed)
            extensionError('STALE_CONNECTION', 'Terminal connection closed');
        this.sweep();
        const fingerprint = JSON.stringify([
            params.rootId,
            params.cols,
            params.rows,
            params.reuseKey ?? null,
        ]);
        const existing = this.operations.get(params.operationId);
        if (existing) {
            if (existing.fingerprint && existing.fingerprint !== fingerprint)
                extensionError(
                    'IDEMPOTENCY_CONFLICT',
                    'Terminal creation parameters changed',
                );
            await existing.job;
            return this.createView(existing);
        }
        if (this.operations.size >= MAX_RECORDS)
            extensionError('RESOURCE_LIMIT', 'Terminal record limit reached');
        if (
            [...this.operations.values()].filter((item) =>
                ['starting', 'running', 'closing'].includes(item.state),
            ).length >= 2
        )
            extensionError(
                'RESOURCE_LIMIT',
                'At most two terminals are allowed per connection',
            );
        const item: Terminal = {
            operationId: params.operationId,
            params,
            fingerprint,
            state: 'starting',
            expires: performance.now() + LEASE_MS,
            bound: false,
            fenced: false,
            queue: [],
            bytes: 0,
            pumping: false,
            exit: { code: null, signal: null },
        };
        this.operations.set(params.operationId, item);
        const job = this.start(item, params);
        item.job = job;
        this.store.trackCreation(job);
        try {
            await job;
        } finally {
            item.job = undefined;
        }
        return this.createView(item);
    }

    private async start(item: Terminal, params: CreateTerminal) {
        let admitting = false;
        try {
            // cwd starts at an administrator-configured root; it is not a shell sandbox.
            const cwd = await this.core.resolve(params.rootId, '');
            item.cwd = cwd;
            if (!(await fs.lstat(cwd)).isDirectory())
                extensionError(
                    'INVALID_PARAMS',
                    'Terminal cwd must be a directory',
                );
            this.check(item);
            const attachment: TerminalAttachment = {
                id: Symbol('terminal attachment'),
                data: (raw) => {
                    // Store dispatch and this fence both belong to this attachment.
                    if (
                        item.fenced ||
                        this.disposed ||
                        item.terminal?.attachment !== attachment
                    )
                        return;
                    const data = Buffer.isBuffer(raw)
                        ? raw
                        : Buffer.from(raw, 'utf8');
                    item.terminal.pty.pause();
                    if (!data.length) return;
                    if (this.outputBytes + data.length > OUTPUT_LIMIT) {
                        this.stop(item, 'OUTPUT_LIMIT', true);
                        return;
                    }
                    this.outputBytes += data.length;
                    item.bytes += data.length;
                    item.queue.push(data);
                    void this.pump(item);
                },
                exited: (exit) => {
                    if (item.terminal?.attachment !== attachment) return;
                    item.exit = exit;
                    this.exited(item);
                },
                stopped: (code) => {
                    if (item.state !== 'closed') item.state = 'closing';
                    this.fence(item, code);
                },
            };
            item.attachment = attachment;
            admitting = true;
            const claimed = this.store.claim(
                params.rootId,
                cwd,
                params.cols,
                params.rows,
                attachment,
                params.reuseKey,
            );
            admitting = false;
            item.terminal = claimed.terminal;
            item.resumed = claimed.resumed;
            item.terminalId = randomUUID();
            this.resources.set(item.terminalId, item);
            await this.store.ready(
                claimed.terminal,
                attachment,
                params.cols,
                params.rows,
                () => this.check(item),
            );
            this.check(item);
            item.state = 'running';
        } catch (error) {
            if (error instanceof TerminalStartupError)
                item.failureReason = error.reason;
            if (item.terminal) this.stop(item, 'START_FAILED', true);
            else if (item.state === 'starting') {
                item.state = 'failed';
                item.finished = performance.now();
                // Admission conflicts must retain their protocol error code.
                if (admitting && error instanceof ProtocolError) throw error;
            }
        }
    }

    private async pump(item: Terminal) {
        if (item.pumping || !item.channel) return;
        item.pumping = true;
        try {
            while (item.queue.length && !item.fenced && !this.disposed) {
                this.authorize();
                // Do not retain a whole output buffer in an async pump after detach.
                const length = item.queue[0].length;
                for (let offset = 0; offset < length; offset += 65536) {
                    if (item.fenced || this.disposed) return;
                    await item.channel!.write(
                        item.queue[0].subarray(offset, offset + 65536),
                    );
                }
                if (item.fenced || this.disposed) return;
                item.queue.shift();
                item.bytes -= length;
                this.outputBytes -= length;
            }
            if (!item.fenced && !this.disposed) {
                if (item.state === 'closed') await item.channel.end();
                else if (
                    item.state === 'running' &&
                    item.terminal &&
                    item.terminal.attachment === item.attachment
                )
                    item.terminal.pty.resume();
            }
        } catch {
            this.stop(item, 'OUTPUT_FAILED', true);
        } finally {
            item.pumping = false;
        }
    }

    private exited(item: Terminal) {
        // node-pty destroys the read socket 200ms after child exit, even while paused.
        // A congested exit therefore cannot promise a complete output stream.
        item.outputIncomplete =
            !item.fenced && (!item.bound || item.pumping || item.bytes > 0);
        item.state = 'closed';
        item.finished = performance.now();
        if (item.outputIncomplete) this.stop(item, 'OUTPUT_INCOMPLETE');
        else if (item.fenced) this.clearOutput(item);
        else void this.pump(item);
    }

    private clearOutput(item: Terminal) {
        this.outputBytes -= item.bytes;
        item.bytes = 0;
        item.queue.length = 0;
    }

    private fence(item: Terminal, code: string) {
        if (item.fenced) return;
        item.fenced = true;
        const channel = item.channel;
        item.channel = undefined;
        this.clearOutput(item);
        // Fence before close: channel close can synchronously reenter the receiver.
        channel?.close(code);
    }

    private stop(item: Terminal, code: string, retain = false) {
        if (item.fenced) {
            if (!retain && item.terminal && item.attachment)
                this.store.terminateOwned(item.terminal, item.attachment, code);
            return;
        }
        this.fence(item, code);
        if (item.terminal && item.attachment) {
            if (retain && this.store.detach(item.terminal, item.attachment)) {
                item.state = 'closed';
                item.finished = performance.now();
                return;
            }
            this.store.terminateOwned(item.terminal, item.attachment, code);
            if (item.state === 'closed') return;
            item.state =
                item.terminal.state === 'closed' ? 'closed' : 'closing';
        } else if (item.state !== 'failed') item.state = 'closed';
        if (item.state === 'closed' || item.state === 'failed')
            item.finished ??= performance.now();
    }

    status(operationId: string) {
        this.sweep();
        const item = this.operations.get(operationId);
        return item ? this.view(item) : { operationId, state: 'unknown' };
    }

    resize(terminalId: string, cols: number, rows: number) {
        const item = this.resource(terminalId);
        this.check(item);
        if (item.state !== 'running')
            extensionError('INVALID_STATE', 'Terminal is not running');
        try {
            item.terminal!.pty.resize(cols, rows);
        } catch {
            extensionError('INVALID_STATE', 'Terminal resize failed');
        }
        return { terminalId, cols, rows };
    }

    renew(terminalId: string) {
        const item = this.resource(terminalId);
        this.check(item);
        item.expires = performance.now() + LEASE_MS;
        return { terminalId, leaseMs: LEASE_MS };
    }

    closeOperation(operationId: string, reason: string, retain = false) {
        this.sweep();
        let item = this.operations.get(operationId);
        if (!item) {
            if (this.operations.size >= MAX_RECORDS)
                extensionError(
                    'RESOURCE_LIMIT',
                    'Terminal record limit reached',
                );
            item = {
                operationId,
                state: 'closed',
                expires: 0,
                finished: performance.now(),
                bound: false,
                fenced: true,
                queue: [],
                bytes: 0,
                pumping: false,
                exit: { code: null, signal: null },
            };
            this.operations.set(operationId, item);
        } else
            this.stop(
                item,
                reason === 'page-exit' ? 'PAGE_EXIT' : 'USER',
                retain,
            );
        return this.view(item);
    }

    private resource(terminalId: string) {
        const item = this.resources.get(terminalId);
        if (!item)
            extensionError(
                'RESOURCE_NOT_FOUND',
                'Unknown terminal in this connection',
            );
        return item;
    }

    async acceptChannel(
        open: ChannelOpen,
        channel: DataChannel,
    ): Promise<ChannelReceiver> {
        if (open.purpose !== TERMINAL || open.direction !== 'duplex')
            extensionError('INVALID_PARAMS', 'Terminal channel must be duplex');
        const item = this.resource(open.resourceId);
        this.check(item);
        if (item.bound || item.state !== 'running')
            extensionError(
                'WRITER_CONFLICT',
                'Terminal may be bound only once',
            );
        item.bound = true;
        item.terminal!.bound = true;
        item.channel = channel;
        void this.pump(item);
        return {
            data: async (data) => {
                this.check(item);
                if (data.byteLength > 64 * 1024)
                    extensionError(
                        'LIMIT_EXCEEDED',
                        'Terminal input delivery limit is 64 KiB',
                    );
                try {
                    // HTTP delivery boundaries need not match the host's <=32 KiB
                    // inputs. Split raw bytes, not UTF-8 text, and await each write.
                    for (
                        let offset = 0;
                        offset < data.byteLength;
                        offset += INPUT_LIMIT
                    ) {
                        this.check(item);
                        await this.store.writeInput(
                            item.terminal!,
                            item.attachment!,
                            data.subarray(offset, offset + INPUT_LIMIT),
                            () => this.check(item),
                        );
                    }
                } catch {
                    this.stop(item, 'INPUT_FAILED', true);
                    extensionError('INVALID_STATE', 'Terminal input failed');
                }
            },
            end: () => {
                this.stop(item, 'INPUT_ENDED', true);
            },
            close: (reason) => {
                this.stop(
                    item,
                    reason ? 'CHANNEL_CLOSED' : 'CHANNEL_ENDED',
                    true,
                );
            },
        };
    }

    terminate(terminalId: string) {
        const item = this.resource(terminalId);
        this.check(item);
        this.stop(item, 'USER');
        return this.view(item);
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.disposed = true;
        clearInterval(this.timer);
        for (const item of this.operations.values())
            this.stop(item, 'STALE_CONNECTION', true);
        this.closing = Promise.all(
            [...this.operations.values()].map(async (item) => {
                await item.job?.catch(() => {});
                if (item.terminal?.state === 'closing')
                    await item.terminal.exited;
            }),
        ).then(async () => {
            if (this.ownsStore) await this.store.close();
        });
        return this.closing;
    }
}
