import type { Terminal } from '@xterm/xterm';

const INPUT_LIMIT = 32 * 1024;
const QUEUE_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const encoder = new TextEncoder();

interface Bridge {
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

interface OpenResult {
    terminalId: string;
    rootId: string;
    path: string;
    shell: string;
    leaseMs: number;
}

interface ReadResult {
    cursor: number;
    output: string;
    state: 'running' | 'exited' | 'closed';
    exitCode?: number;
    outputIncomplete?: boolean;
    error?: { code: string; message: string };
}

export interface SessionView {
    phase: 'idle' | 'opening' | 'running' | 'stopped';
    message: string;
    shell?: string;
    path?: string;
    error?: boolean;
}

interface Instance {
    terminalId?: string;
    inputs: string[];
    inputBytes: number;
    sending: boolean;
    renewing: boolean;
    resizing: boolean;
    ending?: boolean;
    outputWarning?: string;
    size?: { cols: number; rows: number };
    renewTimer?: ReturnType<typeof setInterval>;
    resizeTimer?: ReturnType<typeof setTimeout>;
}

// Bound the entire pending paste, not just each individual bridge request.
// Iterate code points so a UTF-16 surrogate pair never straddles requests.
export function inputChunks(data: string): { chunks: string[]; bytes: number } {
    const chunks: string[] = [];
    let chunk = '';
    let chunkBytes = 0;
    let bytes = 0;
    for (const point of data) {
        const code = point.codePointAt(0)!;
        let size = 4;
        if (code <= 0x7f) size = 1;
        else if (code <= 0x7ff) size = 2;
        else if (code <= 0xffff) size = 3;
        bytes += size;
        if (bytes > QUEUE_LIMIT)
            throw new Error(
                '输入积压超过 256 KiB，终端已停止；未发送的输入不会重放。',
            );
        if (chunkBytes + size > INPUT_LIMIT) {
            chunks.push(chunk);
            chunk = '';
            chunkBytes = 0;
        }
        chunk += point;
        chunkBytes += size;
    }
    if (chunk) chunks.push(chunk);
    return { chunks, bytes };
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : '宿主请求失败。';
}

// One instance owns all in-flight work. Invalidating it fences every late
// receipt before it can write output, send queued input, or restart a reader.
export class TerminalSession {
    private instance?: Instance;
    private available = false;
    private visible = true;
    private rendered: Promise<void> = Promise.resolve();
    private release?: Promise<unknown>;
    private view: SessionView = {
        phase: 'idle',
        message: '点击打开，宿主确认后启动终端。',
    };

    constructor(
        private readonly bridge: Bridge,
        private readonly terminal: Pick<
            Terminal,
            'options' | 'cols' | 'rows' | 'write' | 'reset' | 'focus'
        >,
        private readonly update: (view: SessionView) => void,
    ) {}

    setAvailability(available: boolean, detail?: string) {
        this.available = available;
        if (!available && this.instance) {
            this.stop(detail || '宿主连接不可用；请重新打开终端。', true);
        } else if (!available && this.view.phase !== 'stopped') {
            this.publish({ ...this.view, message: detail || '等待宿主连接…' });
        } else if (this.view.phase === 'idle') {
            this.publish({
                phase: 'idle',
                message: '点击打开，宿主确认后启动终端。',
            });
        }
    }

    setVisible(visible: boolean) {
        this.visible = visible;
        if (!visible && this.instance) {
            this.stop('页面已隐藏；终端已停止续租，请重新打开。');
        }
    }

    private publish(view: SessionView) {
        this.view = view;
        this.update(view);
    }

    private current(instance: Instance): boolean {
        return this.instance === instance && this.available && this.visible;
    }

    private cleanup(instance: Instance) {
        clearInterval(instance.renewTimer);
        clearTimeout(instance.resizeTimer);
        instance.inputs.length = 0;
        instance.inputBytes = 0;
        instance.size = undefined;
    }

    private closeRemote(terminalId: string) {
        // A rejected close is never retried against a new scope. The host and
        // remote lease remain responsible for cleanup when the bridge is gone.
        return this.bridge.request('terminalClose', { terminalId });
    }

    private stop(detail: string, error = false) {
        const instance = this.instance;
        if (instance?.outputWarning) {
            detail = `${instance.outputWarning} ${detail}`;
            error = true;
        }
        this.instance = undefined;
        this.terminal.options.disableStdin = true;
        if (instance) this.cleanup(instance);
        const stopped: SessionView = {
            ...this.view,
            phase: 'stopped',
            message: detail,
            error,
        };
        this.publish(stopped);
        if (instance?.terminalId) {
            this.release = this.closeRemote(instance.terminalId).catch(() => {
                if (!this.instance && this.view === stopped) {
                    this.publish({
                        ...this.view,
                        message: `${detail} 关闭结果未确认，将由宿主清理或租约到期回收。`,
                        error: true,
                    });
                }
            });
        }
    }

    async open() {
        if (this.instance || !this.available || !this.visible) return;
        const instance: Instance = {
            inputs: [],
            inputBytes: 0,
            sending: false,
            renewing: false,
            resizing: false,
        };
        this.instance = instance;
        this.terminal.options.disableStdin = true;
        this.publish({ phase: 'opening', message: '等待宿主确认并打开…' });
        try {
            // An explicit reopen waits for prior cleanup; it must not race the
            // host's one-terminal-per-instance ownership check. Never retry close.
            if (this.release) await this.release;
            if (!this.current(instance)) return;
            const result = await this.bridge.request<OpenResult>(
                'terminalOpen',
                {
                    cols: this.terminal.cols,
                    rows: this.terminal.rows,
                },
            );
            if (!this.current(instance)) {
                // Only cleanup is allowed for a receipt from a closed instance.
                if (result.terminalId)
                    void this.closeRemote(result.terminalId).catch(() => {});
                return;
            }
            instance.terminalId = result.terminalId;
            if (
                !result.terminalId ||
                !Number.isFinite(result.leaseMs) ||
                result.leaseMs <= 0
            ) {
                throw new Error('宿主返回了无效的终端信息。');
            }
            // An accepted old write may still be in xterm's parser queue.
            // Drain it before resetting the display for this new instance.
            await this.rendered;
            if (!this.current(instance)) return;
            this.terminal.reset();
            this.terminal.options.disableStdin = false;
            this.publish({
                phase: 'running',
                message: '已连接',
                shell: result.shell,
                path: result.path,
            });
            this.terminal.focus();
            instance.renewTimer = setInterval(
                () => void this.renew(instance),
                10_000,
            );
            this.resize(this.terminal.cols, this.terminal.rows);
            void this.read(instance);
        } catch (error) {
            if (this.current(instance))
                this.stop(`打开失败：${message(error)} 请点击重新打开。`, true);
        }
    }

    input(data: string) {
        const instance = this.instance;
        if (
            !instance?.terminalId ||
            !this.current(instance) ||
            instance.ending ||
            !data
        )
            return;
        try {
            const input = inputChunks(data);
            if (instance.inputBytes + input.bytes > QUEUE_LIMIT) {
                throw new Error(
                    '输入积压超过 256 KiB，终端已停止；未发送的输入不会重放。',
                );
            }
            instance.inputs.push(...input.chunks);
            instance.inputBytes += input.bytes;
            void this.send(instance);
        } catch (error) {
            this.stop(message(error), true);
        }
    }

    private async send(instance: Instance) {
        if (instance.sending) return;
        instance.sending = true;
        try {
            while (
                this.current(instance) &&
                !instance.ending &&
                instance.inputs.length
            ) {
                const data = instance.inputs.shift()!;
                await this.bridge.request('terminalInput', {
                    terminalId: instance.terminalId,
                    data,
                });
                if (!this.current(instance) || instance.ending) return;
                instance.inputBytes -= encoder.encode(data).byteLength;
            }
        } catch (error) {
            if (this.current(instance) && !instance.ending)
                this.stop(
                    `输入结果未确认：${message(error)} 不会自动重发。`,
                    true,
                );
        } finally {
            instance.sending = false;
        }
    }

    private async read(instance: Instance) {
        let cursor = 0;
        try {
            while (this.current(instance)) {
                const result = await this.bridge.request<ReadResult>(
                    'terminalRead',
                    {
                        terminalId: instance.terminalId,
                        cursor,
                    },
                );
                if (!this.current(instance)) return;
                if (
                    !Number.isSafeInteger(result.cursor) ||
                    result.cursor < cursor ||
                    typeof result.output !== 'string' ||
                    encoder.encode(result.output).byteLength > OUTPUT_LIMIT ||
                    !['running', 'exited', 'closed'].includes(result.state) ||
                    (result.outputIncomplete !== undefined &&
                        typeof result.outputIncomplete !== 'boolean') ||
                    (result.error !== undefined &&
                        (!result.error ||
                            typeof result.error.code !== 'string' ||
                            typeof result.error.message !== 'string'))
                )
                    throw new Error('宿主输出超限或格式无效。');
                if (result.outputIncomplete || result.error) {
                    instance.outputWarning = result.error
                        ? `输出可能不完整（${result.error.code}: ${result.error.message}）。`
                        : '输出可能不完整。';
                    this.publish({
                        ...this.view,
                        message: instance.outputWarning,
                        error: true,
                    });
                }
                if (result.state !== 'running') {
                    // Freeze writes/renewal immediately, but retain this instance
                    // until its final output has actually rendered.
                    instance.ending = true;
                    this.terminal.options.disableStdin = true;
                    this.cleanup(instance);
                }
                if (result.output) {
                    this.rendered = new Promise<void>((resolve) =>
                        this.terminal.write(result.output, resolve),
                    );
                    await this.rendered;
                    if (!this.current(instance)) return;
                }
                cursor = result.cursor;
                if (result.state !== 'running') {
                    this.stop(
                        result.state === 'exited'
                            ? `进程已退出${result.exitCode === undefined ? '' : `（${result.exitCode}）`}；可重新打开。`
                            : '终端已关闭；可重新打开。',
                    );
                    return;
                }
                // The host long-polls empty reads (up to 20 s); no fast timer,
                // speculative concurrent read, or unbounded output queue here.
            }
        } catch (error) {
            if (this.current(instance))
                this.stop(
                    `读取中断：${message(error)} 输出完整性无法确认；请重新打开。`,
                    true,
                );
        }
    }

    private async renew(instance: Instance) {
        if (!this.current(instance) || instance.ending || instance.renewing)
            return;
        instance.renewing = true;
        try {
            await this.bridge.request('terminalRenew', {
                terminalId: instance.terminalId,
            });
        } catch (error) {
            if (this.current(instance) && !instance.ending)
                this.stop(`续租失败：${message(error)} 请重新打开。`, true);
        } finally {
            instance.renewing = false;
        }
    }

    resize(cols: number, rows: number) {
        const instance = this.instance;
        if (!instance?.terminalId || !this.current(instance) || instance.ending)
            return;
        instance.size = { cols, rows };
        clearTimeout(instance.resizeTimer);
        instance.resizeTimer = setTimeout(
            () => void this.sendResize(instance),
            120,
        );
    }

    private async sendResize(instance: Instance) {
        if (!this.current(instance) || instance.ending || instance.resizing)
            return;
        instance.resizing = true;
        try {
            while (
                this.current(instance) &&
                !instance.ending &&
                instance.size
            ) {
                const size = instance.size;
                instance.size = undefined;
                await this.bridge.request('terminalResize', {
                    terminalId: instance.terminalId,
                    ...size,
                });
            }
        } catch (error) {
            if (this.current(instance) && !instance.ending)
                this.stop(`调整窗口失败：${message(error)} 请重新打开。`, true);
        } finally {
            instance.resizing = false;
        }
    }

    close() {
        if (this.instance)
            this.stop('已请求关闭终端；不保证已结束所有子进程或撤销外部操作。');
    }

    dispose() {
        this.close();
        this.available = false;
    }
}
