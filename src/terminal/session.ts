import * as fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { IDisposable } from 'node-pty';
import type {
    ChannelOpen,
    ChannelReceiver,
    DataChannel,
} from '../transport-v1/ExtensionTransport.js';
import { FileCore } from '../file-manager/file-core.js';
import {
    TERMINAL,
    LEASE_MS,
    MAX_RECORDS,
    RECORD_TTL_MS,
    extensionError,
} from '../extensions/protocol.js';
import { signalGroup, writeInput } from './pty.js';
import type { LinuxPty, TerminalRuntime } from './pty.js';

export interface CreateTerminal {
    operationId: string;
    rootId: string;
    cols: number;
    rows: number;
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
    pty?: LinuxPty;
    bound: boolean;
    fenced: boolean;
    outputIncomplete?: boolean;
    channel?: DataChannel;
    queue: Buffer[];
    bytes: number;
    pumping: boolean;
    subscriptions: IDisposable[];
    killTimer?: NodeJS.Timeout;
    exit: { code: number | null; signal: string | null };
}
const INPUT_LIMIT = 32 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const sessions = new Set<TerminalSession>();
process.once('exit', () => {
    for (const session of sessions) session.cleanupOnExit();
});

export class TerminalSession {
    private readonly operations = new Map<string, Terminal>();
    private readonly resources = new Map<string, Terminal>();
    private outputBytes = 0;
    private disposed = false;
    private readonly timer: NodeJS.Timeout;

    constructor(
        private readonly core: FileCore,
        private readonly runtime: TerminalRuntime,
        private readonly authorize: () => void,
    ) {
        sessions.add(this);
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
                this.stop(item, 'LEASE_EXPIRED');
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
            this.stop(item, 'LEASE_EXPIRED');
            extensionError('LEASE_EXPIRED', 'Terminal lease expired');
        }
        if (
            item.fenced ||
            (item.state !== 'starting' && item.state !== 'running')
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
                    message: 'Terminal could not be started',
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
            subscriptions: [],
            exit: { code: null, signal: null },
        };
        this.operations.set(params.operationId, item);
        const job = this.start(item, params);
        item.job = job;
        try {
            await job;
        } finally {
            item.job = undefined;
        }
        return this.createView(item);
    }

    private async start(item: Terminal, params: CreateTerminal) {
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
            const pty = this.runtime.spawn(cwd, params.cols, params.rows);
            item.pty = pty;
            pty.pause();
            item.terminalId = randomUUID();
            this.resources.set(item.terminalId, item);
            item.subscriptions.push(
                pty.onData((raw) => {
                    // encoding:null makes node-pty emit raw Buffers. No per-chunk UTF-8 decoding.
                    const data = Buffer.isBuffer(raw)
                        ? raw
                        : Buffer.from(raw, 'utf8');
                    pty.pause();
                    if (item.fenced || this.disposed || !data.length) return;
                    if (this.outputBytes + data.length > OUTPUT_LIMIT) {
                        this.stop(item, 'OUTPUT_LIMIT');
                        return;
                    }
                    this.outputBytes += data.length;
                    item.bytes += data.length;
                    item.queue.push(data);
                    void this.pump(item);
                }),
            );
            item.subscriptions.push(
                pty.onExit((event) => {
                    item.exit = {
                        code: event.exitCode ?? null,
                        signal: event.signal ? String(event.signal) : null,
                    };
                    this.exited(item);
                }),
            );
            this.check(item);
            item.state = 'running';
        } catch {
            if (item.pty) this.stop(item, 'START_FAILED');
            else if (item.state === 'starting') {
                item.state = 'failed';
                item.finished = performance.now();
            }
        }
    }

    private async pump(item: Terminal) {
        if (item.pumping || !item.channel) return;
        item.pumping = true;
        try {
            while (item.queue.length && !item.fenced && !this.disposed) {
                this.authorize();
                const data = item.queue[0];
                for (let offset = 0; offset < data.length; offset += 65536) {
                    if (item.fenced || this.disposed) return;
                    await item.channel.write(
                        data.subarray(offset, offset + 65536),
                    );
                }
                // Include the in-flight chunk in the bounded budget until write releases it.
                if (item.queue[0] === data) {
                    item.queue.shift();
                    item.bytes -= data.length;
                    this.outputBytes -= data.length;
                }
            }
            if (!item.fenced && !this.disposed) {
                if (item.state === 'closed') await item.channel.end();
                else if (item.state === 'running') item.pty?.resume();
            }
        } catch {
            this.stop(item, 'OUTPUT_FAILED');
        } finally {
            item.pumping = false;
        }
    }

    private exited(item: Terminal) {
        // node-pty destroys the read socket 200ms after child exit, even while paused.
        // A congested exit therefore cannot promise a complete output stream.
        item.outputIncomplete =
            !item.fenced && (!item.bound || item.pumping || item.bytes > 0);
        clearTimeout(item.killTimer);
        item.state = 'closed';
        item.finished = performance.now();
        for (const subscription of item.subscriptions) subscription.dispose();
        item.subscriptions.length = 0;
        if (item.outputIncomplete) this.stop(item, 'OUTPUT_INCOMPLETE');
        else if (item.fenced) this.clearOutput(item);
        else void this.pump(item);
        if (
            this.disposed &&
            ![...this.operations.values()].some(
                (resource) => resource.state === 'closing',
            )
        )
            sessions.delete(this);
    }

    private clearOutput(item: Terminal) {
        this.outputBytes -= item.bytes;
        item.bytes = 0;
        item.queue.length = 0;
    }

    private stop(item: Terminal, code: string) {
        if (item.fenced) return;
        item.fenced = true;
        item.channel?.close(code);
        this.clearOutput(item);
        if (!item.pty || item.state === 'closed' || item.state === 'failed') {
            if (item.state !== 'failed') item.state = 'closed';
            item.finished ??= performance.now();
            return;
        }
        item.state = 'closing';
        item.pty.pause();
        signalGroup(item.pty, 'SIGTERM');
        item.killTimer = setTimeout(() => {
            if (item.pty && item.state === 'closing')
                signalGroup(item.pty, 'SIGKILL');
        }, 1000);
        item.killTimer.unref();
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
            item.pty!.resize(cols, rows);
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

    closeOperation(operationId: string, reason: string) {
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
                subscriptions: [],
                exit: { code: null, signal: null },
            };
            this.operations.set(operationId, item);
        } else this.stop(item, reason === 'page-exit' ? 'PAGE_EXIT' : 'USER');
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
        item.channel = channel;
        void this.pump(item);
        return {
            data: async (data) => {
                this.check(item);
                if (data.byteLength > INPUT_LIMIT)
                    extensionError(
                        'LIMIT_EXCEEDED',
                        'Terminal input frame limit is 32 KiB',
                    );
                try {
                    await writeInput(item.pty!, data, () => this.check(item));
                } catch {
                    this.stop(item, 'INPUT_FAILED');
                    extensionError('INVALID_STATE', 'Terminal input failed');
                }
            },
            end: () => {
                this.stop(item, 'INPUT_ENDED');
            },
            close: (reason) => {
                this.stop(item, reason ? 'CHANNEL_CLOSED' : 'CHANNEL_ENDED');
            },
        };
    }

    cleanupOnExit() {
        for (const item of this.operations.values()) {
            if (
                item.pty &&
                (item.state === 'running' || item.state === 'closing')
            )
                signalGroup(item.pty, 'SIGKILL');
        }
    }

    close() {
        if (this.disposed) return;
        this.disposed = true;
        clearInterval(this.timer);
        for (const item of this.operations.values())
            this.stop(item, 'STALE_CONNECTION');
        // The exit hook remains registered until all directly-owned PTYs have exited.
        if (
            ![...this.operations.values()].some(
                (item) => item.state === 'closing',
            )
        )
            sessions.delete(this);
    }
}
