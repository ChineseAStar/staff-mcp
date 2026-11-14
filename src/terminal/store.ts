import { performance } from 'node:perf_hooks';
import type { IDisposable } from 'node-pty';
import { extensionError } from '../extensions/protocol.js';
import type { TerminalPty, TerminalRuntime } from './pty.js';

export const RETAINED_FOR_MS = 2 * 60 * 60 * 1000;
const MAX_PTYS = 32;

/** A wire attachment is never reused, even when its shell is. */
export interface TerminalAttachment {
    readonly id: symbol;
    data(raw: string | Buffer): void;
    exited(exit: { code: number | null; signal: string | null }): void;
    stopped(code: string): void;
}
export interface StoredTerminal {
    readonly rootId: string;
    readonly cwd: string;
    readonly reuseKey?: string;
    readonly pty: TerminalPty;
    state: 'running' | 'closing' | 'closed';
    attachment?: TerminalAttachment;
    lastOwner: symbol;
    bound: boolean;
    detachedUntil?: number;
    input?: Promise<void>;
    readonly exited: Promise<void>;
    resolveExit(): void;
    subscriptions: IDisposable[];
    killTimer?: NodeJS.Timeout;
}
const stores = new Set<TerminalStore>();
process.once('exit', () => {
    for (const store of stores) store.cleanupOnExit();
});

/** Factory-owned live processes only. No output, wire cursors or persisted secrets. */
export class TerminalStore {
    private readonly live = new Set<StoredTerminal>();
    private readonly reusable = new Map<string, StoredTerminal>();
    private readonly creations = new Set<Promise<void>>();
    private disposed = false;
    private closing?: Promise<void>;
    private readonly timer: NodeJS.Timeout;

    constructor(private readonly runtime: TerminalRuntime) {
        stores.add(this);
        this.timer = setInterval(() => this.sweep(), 1000);
        this.timer.unref();
    }

    trackCreation(job: Promise<void>) {
        this.creations.add(job);
        void job.then(
            () => this.creations.delete(job),
            () => this.creations.delete(job),
        );
    }

    private sweep() {
        const now = performance.now();
        for (const item of this.live)
            if (item.detachedUntil !== undefined && item.detachedUntil <= now)
                this.stop(item, 'RETENTION_EXPIRED');
    }

    claim(
        rootId: string,
        cwd: string,
        cols: number,
        rows: number,
        attachment: TerminalAttachment,
        reuseKey?: string,
    ): { terminal: StoredTerminal; resumed: boolean } {
        if (this.disposed)
            extensionError('STALE_CONNECTION', 'Terminal store closed');
        this.sweep();
        const existing = reuseKey ? this.reusable.get(reuseKey) : undefined;
        if (existing) {
            if (existing.rootId !== rootId || existing.cwd !== cwd)
                extensionError('INVALID_PARAMS', 'Terminal root changed');
            if (existing.state !== 'running')
                extensionError('INVALID_STATE', 'Terminal is stopping');
            if (existing.attachment)
                extensionError(
                    'WRITER_CONFLICT',
                    'Terminal already has a writer',
                );
            // Reserve before waiting for old admitted input to settle.
            existing.pty.pause();
            existing.attachment = attachment;
            existing.lastOwner = attachment.id;
            existing.detachedUntil = undefined;
            return { terminal: existing, resumed: true };
        }
        if (this.live.size >= MAX_PTYS)
            extensionError('RESOURCE_LIMIT', 'Terminal process limit reached');
        const pty = this.runtime.spawn(cwd, cols, rows);
        let resolveExit!: () => void;
        const item: StoredTerminal = {
            rootId,
            cwd,
            reuseKey,
            pty,
            state: 'running',
            attachment,
            lastOwner: attachment.id,
            bound: false,
            exited: new Promise<void>((resolve) => {
                resolveExit = resolve;
            }),
            resolveExit: () => resolveExit(),
            subscriptions: [],
        };
        this.live.add(item);
        if (reuseKey) this.reusable.set(reuseKey, item);
        pty.pause();
        item.subscriptions.push(
            pty.onData((raw) => {
                if (item.state === 'running') item.attachment?.data(raw);
            }),
        );
        item.subscriptions.push(
            pty.onExit((event) => {
                item.state = 'closed';
                clearTimeout(item.killTimer);
                this.live.delete(item);
                if (reuseKey && this.reusable.get(reuseKey) === item)
                    this.reusable.delete(reuseKey);
                for (const subscription of item.subscriptions)
                    subscription.dispose();
                item.subscriptions.length = 0;
                item.attachment?.exited({
                    code: event.exitCode ?? null,
                    signal: event.signal ? String(event.signal) : null,
                });
                item.attachment = undefined;
                item.resolveExit();
            }),
        );
        return { terminal: item, resumed: false };
    }

    async ready(
        item: StoredTerminal,
        attachment: TerminalAttachment,
        cols: number,
        rows: number,
        check: () => void,
    ) {
        // No new generation may write/resize while an old OS write is outstanding.
        await item.input;
        if (
            this.disposed ||
            item.attachment !== attachment ||
            item.state !== 'running'
        )
            extensionError('INVALID_STATE', 'Terminal attachment closed');
        check();
        item.pty.resize(cols, rows);
    }

    writeInput(
        item: StoredTerminal,
        attachment: TerminalAttachment,
        data: Uint8Array,
        check: () => void,
    ) {
        check();
        if (item.attachment !== attachment || item.input)
            extensionError('INVALID_STATE', 'Terminal input is unavailable');
        let fenceRejected = false;
        const pending = Promise.resolve()
            .then(() =>
                item.pty.writeInput(data, () => {
                    try {
                        check();
                    } catch (error) {
                        fenceRejected = true;
                        throw error;
                    }
                }),
            )
            .catch((error) => {
                // Real I/O failure retires the physical PTY before the settlement
                // barrier opens. An old attachment fence must never kill its successor.
                if (!fenceRejected) this.stop(item, 'INPUT_FAILED');
                throw error;
            });
        // Store only a settlement barrier: failure is delivered to the original RPC.
        const settled = pending
            .then(
                () => {},
                () => {},
            )
            .finally(() => {
                if (item.input === settled) item.input = undefined;
            });
        item.input = settled;
        return pending.then(
            async () => {
                await settled;
            },
            async (error) => {
                await settled;
                throw error;
            },
        );
    }

    detach(item: StoredTerminal, attachment: TerminalAttachment): boolean {
        if (item.attachment !== attachment || item.state !== 'running')
            return false;
        if (!item.reuseKey || !item.bound) return false;
        item.attachment = undefined;
        item.detachedUntil = performance.now() + RETAINED_FOR_MS;
        // Offline output is drained and discarded, never retained or acknowledged.
        item.pty.resume();
        return true;
    }

    terminateOwned(
        item: StoredTerminal,
        attachment: TerminalAttachment,
        code: string,
    ) {
        // Late cleanup may kill its own detached shell, never a later claimant.
        if (item.lastOwner === attachment.id) this.stop(item, code);
    }

    private stop(item: StoredTerminal, code: string) {
        if (item.state !== 'running') return;
        item.state = 'closing';
        item.detachedUntil = undefined;
        item.attachment?.stopped(code);
        item.pty.resume();
        item.pty.kill('SIGTERM');
        // ConPTY can exit synchronously.
        if (item.state !== 'closing') return;
        item.killTimer = setTimeout(() => {
            if (item.state === 'closing') item.pty.kill('SIGKILL');
        }, 1000);
        if (!this.disposed) item.killTimer.unref();
    }

    cleanupOnExit() {
        for (const item of this.live) item.pty.kill('SIGKILL');
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.disposed = true;
        clearInterval(this.timer);
        const pending = [...this.live];
        for (const item of pending) {
            this.stop(item, 'STAFF_SHUTDOWN');
            item.killTimer?.ref();
        }
        this.closing = Promise.all([
            Promise.allSettled([...this.creations]),
            ...pending.map(async (item) => {
                await item.input;
                await item.exited;
            }),
        ]).then(() => {
            stores.delete(this);
        });
        return this.closing;
    }
}
