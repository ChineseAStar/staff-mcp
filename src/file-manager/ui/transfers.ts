import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, BridgeError, errorMessage } from './bridge';
import type { TransferProgress } from './bridge';

// Numeric validity boundary, also used by the upload retry button; not a byte budget.
export const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;

type TransferStatus =
    | 'queued'
    | 'checking'
    | 'confirm'
    | 'preparing'
    | 'ready'
    | 'saving'
    | 'handed-off'
    | 'running'
    | 'finishing'
    | 'unknown'
    | 'verifying'
    | 'cancelling'
    | 'done'
    | 'cancelled'
    | 'error';

export interface TransferJob {
    id: string;
    transferId?: string;
    direction: 'upload' | 'download';
    rootId: string;
    path: string;
    name: string;
    size: number;
    loaded: number;
    status: TransferStatus;
    file?: File;
    error?: string;
    overwrite?: boolean;
    expectedVersion?: string;
    cancelRequested?: boolean;
}

export const transferLabels: Record<TransferStatus, string> = {
    queued: '等待上传',
    checking: '检查目标',
    confirm: '等待覆盖确认',
    preparing: '准备下载快照…',
    ready: '准备就绪',
    saving: '正在交给浏览器…',
    'handed-off': '已交给浏览器',
    running: '传输中',
    finishing: '校验并提交中',
    unknown: '提交结果待核实',
    verifying: '正在核实提交结果',
    cancelling: '正在取消',
    done: '已完成',
    cancelled: '已取消',
    error: '失败',
};

export function transferActive(job: TransferJob) {
    return [
        'queued',
        'checking',
        'confirm',
        'preparing',
        'ready',
        'running',
        'saving',
        'finishing',
        'cancelling',
    ].includes(job.status);
}

function progressStatus(progress: TransferProgress): TransferStatus {
    if (progress.status === 'ready') return 'ready';
    if (progress.status === 'handed-off') return 'handed-off';
    if (progress.status === 'preparing') return 'preparing';
    if (progress.status === 'cancelling') return 'cancelling';
    if (['done', 'complete', 'completed', 'success'].includes(progress.status))
        return 'done';
    if (['error', 'failed'].includes(progress.status)) return 'error';
    if (['cancelled', 'canceled'].includes(progress.status)) return 'cancelled';
    return 'running';
}

export function useTransfers(
    available: boolean,
    onUploaded: (rootId: string, path: string) => void,
) {
    const [jobs, setJobs] = useState<TransferJob[]>([]);
    const jobsRef = useRef(jobs);
    const enabledRef = useRef(available);
    const runningUpload = useRef(false);
    const uploadCancels = useRef(new Map<string, Promise<unknown>>());
    const sequence = useRef(0);
    const onUploadedRef = useRef(onUploaded);
    const earlyProgress = useRef(new Map<string, TransferProgress>());
    enabledRef.current = available;
    onUploadedRef.current = onUploaded;

    const change = useCallback((id: string, patch: Partial<TransferJob>) => {
        jobsRef.current = jobsRef.current.map((job) =>
            job.id === id ? { ...job, ...patch } : job,
        );
        setJobs(jobsRef.current);
    }, []);

    const add = useCallback((job: TransferJob) => {
        jobsRef.current = [...jobsRef.current, job];
        setJobs(jobsRef.current);
    }, []);

    useEffect(() => {
        return bridge.onProgress((progress) => {
            const job = jobsRef.current.find(
                (entry) => entry.transferId === progress.transferId,
            );
            if (!job) {
                earlyProgress.current.set(progress.transferId, progress);
                if (earlyProgress.current.size > 30) {
                    earlyProgress.current.delete(
                        earlyProgress.current.keys().next().value!,
                    );
                }
                return;
            }
            // Cancellation owns the state until its cleanup promise settles.
            // In particular, a late running/ready event must not make it clearable.
            if (job.cancelRequested) return;
            if (
                job.status === 'cancelling' &&
                !['error', 'cancelled'].includes(progressStatus(progress))
            )
                return;
            if (!transferActive(job)) return;
            if (job.direction === 'upload') {
                // The upload promise, not a byte-progress event, confirms commit.
                change(job.id, {
                    loaded: Math.min(
                        job.size,
                        Math.max(job.loaded, progress.loaded || 0),
                    ),
                });
            } else {
                change(job.id, {
                    loaded: progress.loaded,
                    size: progress.total,
                    status: progressStatus(progress),
                    error: progress.error,
                });
            }
        });
    }, [change]);

    useEffect(() => {
        if (available) return;
        for (const job of jobsRef.current) {
            if (job.direction === 'upload' && job.status === 'finishing') {
                change(job.id, {
                    status: 'unknown',
                    error: '连接已暂停或断开，提交结果未确定。请核实原操作状态，不要重新上传。',
                });
                continue;
            }
            if (
                transferActive(job) &&
                job.status !== 'confirm' &&
                job.status !== 'queued'
            ) {
                change(job.id, {
                    status:
                        job.direction === 'upload' && job.transferId
                            ? 'cancelling'
                            : 'error',
                    cancelRequested: true,
                    error: '连接已暂停或断开。结果待核实；重试前会重新检查目标，不会自动重放写入。',
                });
                if (job.direction === 'download' && job.transferId) {
                    void bridge
                        .request('transferCancel', {
                            transferId: job.transferId,
                        })
                        .catch((error: unknown) => {
                            change(job.id, {
                                error: `连接已暂停，取消结果待核实：${errorMessage(error)}`,
                            });
                        });
                }
            }
        }
    }, [available, change]);

    useEffect(() => {
        if (!available || runningUpload.current) return;
        const job = jobsRef.current.find(
            (entry) =>
                entry.direction === 'upload' && entry.status === 'queued',
        );
        if (!job) return;
        runningUpload.current = true;

        const run = async () => {
            let transferId: string | undefined;
            let committed = false;
            let commitAttempted = false;
            const cancelled = () =>
                !enabledRef.current ||
                !!jobsRef.current.find((entry) => entry.id === job.id)
                    ?.cancelRequested;
            change(job.id, { status: 'checking', error: undefined });
            try {
                if (!job.overwrite) {
                    try {
                        const existing = await bridge.request<{
                            type: string;
                            version: string;
                        }>('stat', {
                            rootId: job.rootId,
                            path: job.path,
                            includeVersion: true,
                        });
                        if (cancelled()) throw new Error('已取消');
                        if (existing.type !== 'file')
                            throw new Error(
                                '目标是目录或符号链接，不能覆盖。请重命名本地文件后上传。',
                            );
                        change(job.id, {
                            status: 'confirm',
                            expectedVersion: existing.version,
                        });
                        return;
                    } catch (error) {
                        if (
                            !(error instanceof BridgeError) ||
                            error.code !== 'NOT_FOUND'
                        )
                            throw error;
                    }
                }
                if (cancelled()) throw new Error('已取消');
                const prepared = await bridge.request<{
                    transferId: string;
                }>('uploadStart', {
                    rootId: job.rootId,
                    path: job.path,
                    size: job.size,
                    ...(job.overwrite
                        ? {
                              overwrite: true,
                              expectedVersion: job.expectedVersion,
                          }
                        : {}),
                });
                transferId = prepared.transferId;
                change(job.id, { transferId });
                if (cancelled()) throw new Error('已取消');
                change(job.id, { status: 'running', loaded: 0 });
                await bridge.request('uploadStream', {
                    transferId,
                    file: job.file,
                });
                if (cancelled()) throw new Error('已取消');
                change(job.id, { status: 'finishing' });
                commitAttempted = true;
                await bridge.request('uploadFinish', { transferId });
                committed = true;
                change(job.id, {
                    status: 'done',
                    loaded: job.size,
                    error: undefined,
                });
                onUploadedRef.current(job.rootId, job.path);
            } catch (error) {
                if (
                    commitAttempted ||
                    (error instanceof BridgeError &&
                        ['UNKNOWN_COMMIT', 'TOO_LATE'].includes(error.code))
                ) {
                    change(job.id, {
                        status: 'unknown',
                        error: `提交结果未确定，禁止重新上传。请核实原操作状态：${errorMessage(error)}`,
                        overwrite: false,
                    });
                    return;
                }
                const current = jobsRef.current.find(
                    (entry) => entry.id === job.id,
                );
                change(job.id, {
                    status: transferId
                        ? 'cancelling'
                        : current?.cancelRequested && enabledRef.current
                          ? 'cancelled'
                          : 'error',
                    error:
                        current?.cancelRequested && enabledRef.current
                            ? undefined
                            : errorMessage(error),
                    // Every explicit retry rechecks the destination and asks again.
                    overwrite: false,
                });
            } finally {
                if (
                    transferId &&
                    !committed &&
                    !commitAttempted &&
                    jobsRef.current.find((entry) => entry.id === job.id)
                        ?.status !== 'unknown'
                ) {
                    try {
                        await (uploadCancels.current.get(transferId) ??
                            bridge.request('transferCancel', { transferId }));
                        if (
                            jobsRef.current.find((entry) => entry.id === job.id)
                                ?.cancelRequested &&
                            enabledRef.current
                        ) {
                            change(job.id, {
                                status: 'cancelled',
                                error: undefined,
                            });
                        } else {
                            change(job.id, { status: 'error' });
                        }
                    } catch (error) {
                        const current = jobsRef.current.find(
                            (entry) => entry.id === job.id,
                        );
                        change(job.id, {
                            status: 'unknown',
                            error: `${current?.error ?? '传输未完成。'} 清理结果未确定，禁止重新上传；请核实原操作状态：${errorMessage(error)}`,
                        });
                    }
                }
                if (transferId) uploadCancels.current.delete(transferId);
                runningUpload.current = false;
                // Trigger the next queued file only after cleanup, keeping one
                // upload slot free for downloads within the host's two-slot cap.
                setJobs([...jobsRef.current]);
            }
        };
        void run();
    }, [available, jobs, change]);

    const upload = (files: File[], rootId: string, directory: string) => {
        for (const file of files) {
            const invalidSize =
                !Number.isSafeInteger(file.size) || file.size < 0;
            add({
                id: `transfer-${++sequence.current}`,
                direction: 'upload',
                rootId,
                path: directory ? `${directory}/${file.name}` : file.name,
                name: file.name,
                file,
                size: file.size,
                loaded: 0,
                status: invalidSize ? 'error' : 'queued',
                error: invalidSize
                    ? '文件大小必须是非负安全整数，未开始上传。'
                    : undefined,
            });
        }
    };

    const discardDownload = async (job: TransferJob) => {
        if (job.direction !== 'download' || !job.transferId) return;
        earlyProgress.current.delete(job.transferId);
        // Lifecycle invalidation also releases the host's temporary download resources.
        if (!enabledRef.current) return;
        await bridge.request('downloadDiscard', { transferId: job.transferId });
    };

    const runDownload = async (job: TransferJob) => {
        change(job.id, {
            status: 'preparing',
            loaded: 0,
            error: undefined,
            cancelRequested: false,
            transferId: undefined,
        });
        let transferId: string | undefined;
        let cleanupAttempted = false;
        const cancelled = () =>
            !enabledRef.current ||
            !!jobsRef.current.find((entry) => entry.id === job.id)
                ?.cancelRequested;
        try {
            await discardDownload(job);
            change(job.id, { transferId: undefined });
            if (cancelled()) {
                change(job.id, { status: 'cancelled' });
                return;
            }
            const result = await bridge.request<{ transferId: string }>(
                'download',
                {
                    rootId: job.rootId,
                    path: job.path,
                },
            );
            transferId = result.transferId;
            change(job.id, { transferId });
            if (cancelled()) {
                // Prepare can finish after the user cancelled. Release the new
                // handle before acknowledging cancellation; never receive bytes.
                change(job.id, { status: 'cancelling' });
                cleanupAttempted = true;
                await bridge.request('transferCancel', { transferId });
                change(job.id, {
                    status: enabledRef.current ? 'cancelled' : 'error',
                });
                return;
            }
            const progress = earlyProgress.current.get(transferId);
            earlyProgress.current.delete(transferId);
            if (progress) {
                change(job.id, {
                    loaded: progress.loaded,
                    size: progress.total,
                    status: progressStatus(progress),
                    error: progress.error,
                });
            }
            await bridge.request('downloadReceive', { transferId });
        } catch (error) {
            if (cleanupAttempted) {
                change(job.id, {
                    status: 'error',
                    error: `取消结果待核实：${errorMessage(error)}`,
                });
                return;
            }
            // Once bound, explicit/lifecycle cancellation owns its cleanup promise.
            if (
                transferId &&
                jobsRef.current.find((entry) => entry.id === job.id)
                    ?.cancelRequested
            )
                return;
            // No automatic replay. On a receive/ack failure a stream may already
            // exist, so cancel it and wait for cleanup before allowing retry.
            if (transferId) {
                change(job.id, { status: 'cancelling' });
                try {
                    await bridge.request('transferCancel', { transferId });
                } catch (cleanupError) {
                    change(job.id, {
                        status: 'error',
                        error: `${errorMessage(error)} 清理结果待核实：${errorMessage(cleanupError)}`,
                    });
                    return;
                }
            }
            change(job.id, {
                status: 'error',
                error:
                    cancelled() && !transferId
                        ? `准备请求未确认，取消结果待核实：${errorMessage(error)}`
                        : errorMessage(error),
            });
        }
    };

    const save = async (id: string) => {
        const job = jobsRef.current.find((entry) => entry.id === id);
        if (!job || job.status !== 'ready' || !enabledRef.current) return;
        change(id, { status: 'saving', error: undefined });
        try {
            const result = await bridge.request<{ receiving?: boolean }>(
                'downloadSave',
                { transferId: job.transferId },
            );
            const current = jobsRef.current.find((entry) => entry.id === id);
            // Progress/cancellation may settle before the native GET ack arrives.
            // Only this attempt's still-pending save can be advanced by its reply.
            if (
                !current ||
                current.transferId !== job.transferId ||
                current.status !== 'saving' ||
                current.cancelRequested
            )
                return;
            change(id, {
                status: result?.receiving ? 'running' : 'handed-off',
            });
        } catch (error) {
            const current = jobsRef.current.find((entry) => entry.id === id);
            if (
                !current ||
                current.transferId !== job.transferId ||
                current.status !== 'saving' ||
                current.cancelRequested
            )
                return;
            change(id, {
                status: 'error',
                error: `交给浏览器的结果未确认，请检查浏览器下载记录：${errorMessage(error)}`,
            });
            await discardDownload(job).catch(() => {});
        }
    };

    const download = (rootId: string, path: string, size = 0) => {
        const job: TransferJob = {
            id: `transfer-${++sequence.current}`,
            direction: 'download',
            rootId,
            path,
            name: path.split('/').pop() ?? path,
            size,
            loaded: 0,
            status: 'preparing',
        };
        add(job);
        void runDownload(job);
    };

    const cancel = async (id: string) => {
        const job = jobsRef.current.find((entry) => entry.id === id);
        if (
            !job ||
            !transferActive(job) ||
            ['finishing', 'saving', 'cancelling'].includes(job.status)
        )
            return;
        change(id, { cancelRequested: true });
        if (['queued', 'confirm'].includes(job.status)) {
            change(id, { status: 'cancelled' });
            return;
        }
        change(id, { status: 'cancelling' });
        if (job.direction === 'download' && job.transferId) {
            try {
                await bridge.request('transferCancel', {
                    transferId: job.transferId,
                });
                change(id, { status: 'cancelled' });
            } catch (error) {
                change(id, {
                    status: 'error',
                    error: `取消结果待核实：${errorMessage(error)}`,
                });
            }
        }
        if (
            job.direction === 'upload' &&
            job.transferId &&
            !uploadCancels.current.has(job.transferId)
        ) {
            const cancellation = bridge.request('transferCancel', {
                transferId: job.transferId,
            });
            uploadCancels.current.set(job.transferId, cancellation);
            // The upload runner owns the final state and awaits this same cleanup.
            void cancellation.catch(() => {});
        }
    };

    const verify = async (id: string) => {
        const job = jobsRef.current.find((entry) => entry.id === id);
        if (
            !job ||
            job.direction !== 'upload' ||
            job.status !== 'unknown' ||
            !job.transferId
        )
            return;
        change(id, { status: 'verifying' });
        try {
            const result = await bridge.request<{
                state: string;
                published?: boolean;
                result?: {
                    path: string;
                    size: number;
                    sha256: string;
                    version: string;
                };
                error?: { code: string; message: string };
            }>('transferStatus', { transferId: job.transferId });
            if (result.state === 'committed') {
                if (
                    !result.result ||
                    result.result.path !== job.path ||
                    result.result.size !== job.size ||
                    !/^[a-f0-9]{64}$/.test(result.result.sha256) ||
                    !result.result.version
                ) {
                    throw new Error('提交结果元信息不符，不能确认成功。');
                }
                change(id, {
                    status: 'done',
                    loaded: job.size,
                    error: undefined,
                    cancelRequested: false,
                });
                onUploadedRef.current(job.rootId, job.path);
            } else if (
                result.published === false &&
                ['failed', 'released'].includes(result.state)
            ) {
                change(id, {
                    status: result.state === 'released' ? 'cancelled' : 'error',
                    error: `已确认未发布，可重新上传。${result.error ? ` ${result.error.message} [${result.error.code}]` : ''}`,
                    overwrite: false,
                    cancelRequested: false,
                });
            } else {
                change(id, {
                    status: 'unknown',
                    error: '原操作尚未确认提交或未发布，不能重新上传。可稍后再次核实状态。',
                });
            }
        } catch (error) {
            change(id, {
                status: 'unknown',
                error: `无法核实原操作；旧连接或已过期记录不能视为失败。请勿重新上传：${errorMessage(error)}`,
            });
        }
    };

    const retry = (id: string, overwrite = false) => {
        const job = jobsRef.current.find((entry) => entry.id === id);
        if (
            !job ||
            !available ||
            !['confirm', 'error', 'cancelled', 'handed-off'].includes(
                job.status,
            )
        )
            return;
        if (job.direction === 'download') {
            void runDownload(job);
        } else if (Number.isSafeInteger(job.size) && job.size >= 0) {
            change(id, {
                status: 'queued',
                overwrite,
                cancelRequested: false,
                loaded: 0,
                error: undefined,
                transferId: undefined,
            });
        }
    };

    const clearFinished = async () => {
        const finished = jobsRef.current.filter(
            (job) =>
                !transferActive(job) &&
                !['unknown', 'verifying'].includes(job.status),
        );
        const removed = new Set<string>();
        for (const job of finished) {
            // Do not erase a record whose save/cancel/retry began while an earlier
            // record was being released.
            if (jobsRef.current.find((entry) => entry.id === job.id) !== job)
                continue;
            if (job.direction !== 'download') {
                removed.add(job.id);
                continue;
            }
            change(job.id, { status: 'cancelling', cancelRequested: true });
            try {
                await discardDownload(job);
                removed.add(job.id);
            } catch (error) {
                change(job.id, {
                    status: 'error',
                    error: `释放下载资源失败：${errorMessage(error)}`,
                });
            }
        }
        jobsRef.current = jobsRef.current.filter((job) => !removed.has(job.id));
        setJobs(jobsRef.current);
    };

    return {
        jobs,
        upload,
        download,
        save,
        cancel,
        retry,
        verify,
        clearFinished,
    };
}
