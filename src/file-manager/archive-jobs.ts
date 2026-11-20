import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MAX_RECORDS } from '../extensions/protocol.js';
import { FileError, fail, fileError, secureDirectory } from './file-core.js';
import type { FileCore } from './file-core.js';

// Reserve a staging slot through preparation, ready retention and disk cleanup.
const MAX_STAGED_JOBS = 2;
const PREPARING_MAX_MS = 60 * 60_000;
const PREPARING_IDLE_MS = 5 * 60_000;
const FINISHED_TTL_MS = 5 * 60_000;

type ArchiveSnapshot = Awaited<ReturnType<FileCore['archiveSnapshot']>>;
interface ArchiveJob {
    jobId: string;
    rootId: string;
    path: string;
    state: 'preparing' | 'ready' | 'failed' | 'discarded';
    expires: number;
    pollDeadline: number;
    abort: AbortController;
    directory?: string;
    snapshot?: ArchiveSnapshot;
    error?: { code: string; message: string };
    pending?: Promise<void>;
    cleanup?: Promise<void>;
}

/** Private ZIP work for one DATA1 session or DATA2 owner. No transfer lease until claim. */
export class ArchiveJobs {
    private readonly jobs = new Map<string, ArchiveJob>();
    private closed = false;

    constructor(
        private readonly core: FileCore,
        private readonly runtimeDirectory: string,
        private readonly authorize: () => void,
    ) {}

    start(rootId: string, file: string) {
        this.authorize();
        this.checkOpen();
        this.core.checkArchivePath(rootId, file);
        this.sweep();
        const staged = [...this.jobs.values()].filter(
            (job) => job.state === 'preparing' || job.directory || job.pending,
        );
        if (this.jobs.size >= MAX_RECORDS || staged.length >= MAX_STAGED_JOBS)
            fail('LIMIT_EXCEEDED', 'Archive job limit reached');

        const now = performance.now();
        const job: ArchiveJob = {
            jobId: randomUUID(),
            rootId,
            path: file,
            state: 'preparing',
            expires: now + PREPARING_MAX_MS,
            pollDeadline: now + PREPARING_IDLE_MS,
            abort: new AbortController(),
        };
        this.jobs.set(job.jobId, job);
        job.pending = this.build(job).finally(() => {
            job.pending = undefined;
            if (job.state === 'failed' || job.state === 'discarded')
                this.cleanSoon(job);
        });
        return { jobId: job.jobId, state: 'preparing' as const };
    }

    status(jobId: string) {
        this.authorize();
        const job = this.get(jobId);
        if (job.state === 'preparing') {
            // Authorized polls keep active work alive, but never beyond the absolute cap.
            job.pollDeadline = performance.now() + PREPARING_IDLE_MS;
            return { jobId, state: job.state };
        }
        if (job.state === 'failed')
            return { jobId, state: job.state, error: job.error! };
        return { jobId, state: job.state };
    }

    cancel(jobId: string) {
        // As with transfer release, cleanup does not grant read access.
        this.discard(this.get(jobId));
        return { jobId, state: 'cancelled' as const };
    }

    /** Called in the same synchronous turn as authorized transfer admission. */
    take(jobId: string, rootId: string, file: string) {
        const job = this.get(jobId);
        if (job.rootId !== rootId || job.path !== file)
            fail(
                'INVALID_PARAMS',
                'Archive job does not match the requested root and path',
            );
        if (job.state === 'failed')
            throw new FileError(
                job.error!.code,
                job.error!.message,
                -32000,
                'archive',
            );
        if (job.state !== 'ready')
            fail('NOT_READY', 'Archive is still preparing');
        const directory = job.directory!;
        const staging = path.join(directory, 'data');
        const snapshot = job.snapshot!;
        // The caller becomes the only owner of the entire private staging directory.
        this.jobs.delete(jobId);
        return { directory, staging, snapshot };
    }

    private checkOpen() {
        if (this.closed) fail('STALE_CONNECTION', 'File session is closed');
    }

    private get(jobId: string) {
        this.checkOpen();
        this.sweep();
        const job = this.jobs.get(jobId);
        if (!job || job.state === 'discarded')
            fail(
                'RESOURCE_NOT_FOUND',
                'Unknown or expired archive job in this session',
            );
        return job as ArchiveJob & { state: 'preparing' | 'ready' | 'failed' };
    }

    private async build(job: ArchiveJob) {
        try {
            await secureDirectory(this.runtimeDirectory);
            if (job.abort.signal.aborted || this.expire(job, performance.now()))
                return;
            // close/cancel await this worker before removing its staging.
            job.directory = await fs.mkdtemp(
                path.join(this.runtimeDirectory, 'archive-'),
            );
            job.abort.signal.throwIfAborted();
            const snapshot = await this.core.archiveSnapshot(
                job.rootId,
                job.path,
                path.join(job.directory, 'data'),
                job.abort.signal,
            );
            if (job.abort.signal.aborted || this.expire(job, performance.now()))
                return;
            this.authorize();
            job.snapshot = snapshot;
            job.state = 'ready';
            job.expires = performance.now() + FINISHED_TTL_MS;
        } catch (error) {
            if (job.abort.signal.aborted || this.expire(job, performance.now()))
                return;
            const failure = fileError(error, 'archive');
            job.error = { code: failure.code, message: failure.message };
            job.state = 'failed';
            job.expires = performance.now() + FINISHED_TTL_MS;
        }
    }

    private expire(job: ArchiveJob, now: number) {
        if (
            now < job.expires &&
            (job.state !== 'preparing' || now < job.pollDeadline)
        )
            return false;
        this.discard(job);
        return true;
    }

    sweep() {
        const now = performance.now();
        for (const job of this.jobs.values()) {
            if (
                job.state === 'discarded' ||
                (job.state === 'failed' && job.directory)
            )
                this.cleanSoon(job); // retain and retry failed removals
            if (job.state !== 'discarded') this.expire(job, now);
        }
    }

    private discard(job: ArchiveJob) {
        job.state = 'discarded';
        job.abort.abort(new FileError('CANCELLED', 'Archive job ended'));
        this.cleanSoon(job);
    }

    private cleanSoon(job: ArchiveJob) {
        void this.cleanup(job).catch(() => {});
    }

    private cleanup(job: ArchiveJob): Promise<void> {
        return (job.cleanup ??= (async () => {
            await job.pending;
            if (job.directory) {
                await fs.rm(job.directory, { recursive: true, force: true });
                job.directory = undefined;
            }
            if (job.state === 'discarded') this.jobs.delete(job.jobId);
        })().finally(() => {
            job.cleanup = undefined;
        }));
    }

    close() {
        this.closed = true;
        const jobs = [...this.jobs.values()];
        for (const job of jobs) this.discard(job);
        return Promise.allSettled(jobs.map((job) => this.cleanup(job))).then(
            (results) => {
                const errors = results
                    .filter((result) => result.status === 'rejected')
                    .map((result) => result.reason);
                if (errors.length)
                    throw new AggregateError(
                        errors,
                        'Archive job cleanup failed',
                    );
            },
        );
    }

    cleanupOnExit(remove: (directory: string) => void) {
        for (const job of this.jobs.values()) {
            if (job.directory) remove(job.directory);
        }
    }
}
