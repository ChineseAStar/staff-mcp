import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { ExtensionDataFactory, ExtensionOwner } from './runtime.js';
import { parseDataConfiguration } from './runtime.js';
import {
    DATA,
    MAX_RECORDS,
    RECORD_TTL_MS,
    extensionError,
    parse,
} from './protocol.js';

export const HTTP_DATA_LEASE_MS = 90_000;
// Matches the existing HTTP session admission bound; composition may pass it explicitly.
const MAX_BINDINGS = 64;
const controlSchema = z
    .object({
        binding: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
        token: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
export type DataControl = z.infer<typeof controlSchema>;
export type OwnerAccess = 'active' | 'receipt';
interface Binding {
    owner: ExtensionOwner;
    secret: Buffer;
    grants: ReadonlySet<string>;
    expires: number;
    closing?: Promise<void>;
    retainUntil?: number;
}

/** Business owners outlive request-local SDK facades, never process restarts. */
export class HttpDataBindings {
    private readonly bindings = new Map<string, Binding>();
    private readonly timer: NodeJS.Timeout;
    private shuttingDown = false;
    private shutdown?: Promise<void>;

    constructor(
        private readonly factory: ExtensionDataFactory,
        private readonly maximum = MAX_BINDINGS,
        private readonly canCreate?: () => boolean,
    ) {
        if (!Number.isSafeInteger(maximum) || maximum < 1)
            throw new Error('Invalid HTTP data binding limit');
        this.timer = setInterval(() => this.sweep(), 1000);
        this.timer.unref();
    }

    /** Publication/cleanup retains admission until it has safely completed. */
    get activeCount(): number {
        let count = 0;
        for (const entry of this.bindings.values()) {
            if (entry.retainUntil === undefined) count++;
        }
        return count;
    }

    private retire(entry: Binding): Promise<void> {
        if (entry.closing) return entry.closing;
        // Install the stop fence before invoking any asynchronous business cleanup.
        entry.expires = 0;
        entry.closing = Promise.resolve();
        // owner.close fences synchronously, including bytes and pending creation.
        try {
            const cleanup = entry.owner.close();
            entry.closing = Promise.resolve(cleanup).then(() => {
                entry.retainUntil = performance.now() + RECORD_TTL_MS;
            });
        } catch (error) {
            entry.closing = Promise.reject(error);
        }
        void entry.closing.catch(() => {});
        return entry.closing;
    }

    private sweep() {
        const now = performance.now();
        for (const [binding, entry] of this.bindings) {
            if (!entry.closing && entry.expires <= now) void this.retire(entry);
            // Failed/incomplete cleanup never frees admission capacity or its proof.
            if (entry.retainUntil !== undefined && entry.retainUntil <= now)
                this.bindings.delete(binding);
        }
    }

    async configure(
        input: unknown,
        signal: AbortSignal,
        grants: ReadonlySet<string>,
        createOwner: (isActive: () => boolean) => ExtensionOwner,
        requestUrl?: string,
    ) {
        const config = parseDataConfiguration(input, 'http', requestUrl);
        if (!grants.has(DATA))
            extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Data extension is unavailable',
            );
        if (signal.aborted || this.shuttingDown)
            extensionError(
                'STALE_CONNECTION',
                'Data request connection closed',
            );
        this.sweep();
        // Receipt retention is bounded separately from active admission. Never
        // evict an unexpired proof to admit a new owner.
        if (
            this.bindings.has(config.binding) ||
            this.activeCount >= this.maximum ||
            this.bindings.size >= MAX_RECORDS ||
            this.canCreate?.() === false
        )
            extensionError('LIMIT_EXCEEDED', 'Data binding is unavailable');
        const secret = randomBytes(32);
        let entry: Binding;
        const isActive = () => {
            if (!entry.closing && entry.expires <= performance.now())
                void this.retire(entry);
            return !entry.closing && !this.shuttingDown;
        };
        entry = {
            owner: createOwner(isActive),
            secret,
            grants: new Set(grants),
            expires: performance.now() + HTTP_DATA_LEASE_MS,
        };
        this.bindings.set(config.binding, entry);
        const cancel = () => {
            void this.retire(entry);
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
            const result = await entry.owner.configure(
                config,
                { factory: this.factory, transport: 'http' },
                entry.grants,
            );
            if (signal.aborted || entry.closing || this.shuttingDown)
                extensionError(
                    'STALE_CONNECTION',
                    'Data connection closed during setup',
                );
            if (typeof result.endpoint !== 'string')
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Data endpoint setup failed',
                );
            return {
                endpoint: result.endpoint,
                control: {
                    binding: config.binding,
                    token: entry.secret.toString('hex'),
                },
                leaseMs: HTTP_DATA_LEASE_MS,
            };
        } catch (error) {
            await this.retire(entry).catch(() => {});
            throw error;
        } finally {
            // Once configuration has returned, request disconnect cannot own this lifetime.
            signal.removeEventListener('abort', cancel);
        }
    }

    resolve(
        input: unknown,
        current: (extension: string) => boolean,
        required: readonly string[],
        access: OwnerAccess = 'active',
    ): {
        owner: ExtensionOwner;
        params: Record<string, unknown>;
        control: DataControl;
    } {
        const object =
            input && typeof input === 'object' && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : {};
        const parsed = controlSchema.safeParse(object.control);
        const entry = parsed.success
            ? this.bindings.get(parsed.data.binding)
            : undefined;
        const supplied = parsed.success
            ? Buffer.from(parsed.data.token, 'hex')
            : Buffer.alloc(32);
        // Always perform a fixed-length comparison, also for unknown/malformed proofs.
        const equal = timingSafeEqual(
            entry?.secret ?? Buffer.alloc(32),
            supplied,
        );
        if (!parsed.success || !entry || !equal || this.shuttingDown)
            extensionError('INVALID_CONTROL', 'Data control is unavailable');
        const now = performance.now();
        if (!entry.closing && entry.expires <= now) void this.retire(entry);
        if (
            (access === 'active' && entry.closing) ||
            (entry.retainUntil !== undefined && entry.retainUntil <= now)
        )
            extensionError('INVALID_CONTROL', 'Data control is unavailable');
        for (const extension of new Set([DATA, ...required])) {
            if (!entry.grants.has(extension) || !current(extension))
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Extension is unavailable for this data owner',
                );
        }
        const { control: _control, ...params } = object;
        return { owner: entry.owner, params, control: parsed.data };
    }

    renew(input: unknown, current: (extension: string) => boolean) {
        const { params, control } = this.resolve(input, current, []);
        parse(z.object({}).strict(), params);
        this.bindings.get(control.binding)!.expires =
            performance.now() + HTTP_DATA_LEASE_MS;
        return { leaseMs: HTTP_DATA_LEASE_MS };
    }

    async closeBinding(
        input: unknown,
        current: (extension: string) => boolean,
    ) {
        const { params, control } = this.resolve(input, current, [], 'receipt');
        parse(z.object({}).strict(), params);
        await this.retire(this.bindings.get(control.binding)!);
        return { closed: true };
    }

    close(): Promise<void> {
        if (this.shutdown) return this.shutdown;
        this.shuttingDown = true;
        clearInterval(this.timer);
        this.shutdown = Promise.allSettled(
            [...this.bindings.values()].map((entry) => this.retire(entry)),
        ).then((results) => {
            const errors = results
                .filter((result) => result.status === 'rejected')
                .map((result) => result.reason);
            if (errors.length)
                throw new AggregateError(
                    errors,
                    'HTTP data owner cleanup failed',
                );
        });
        return this.shutdown;
    }
}
