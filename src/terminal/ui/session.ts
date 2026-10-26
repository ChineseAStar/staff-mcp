import type { Terminal } from '@xterm/xterm';
import { BridgeError } from '../../file-manager/ui/bridge';
import type { TerminalPresentation } from './stream-adapter';

const INPUT_LIMIT = 32 * 1024;
const QUEUE_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const encoder = new TextEncoder();

export interface SessionView {
    phase: 'idle' | 'opening' | 'running' | 'stopped';
    message: string;
    shell?: string;
    path?: string;
    error?: boolean;
}

interface Instance {
    terminalId?: string;
    // An open may wait for previous cleanup, but must not start while hidden.
    opening: boolean;
    inputs: string[];
    inputBytes: number;
    sending: boolean;
    resizing: boolean;
    ending?: boolean;
    outputWarning?: string;
    size?: { cols: number; rows: number };
    inputTimer?: ReturnType<typeof setTimeout>;
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
        message: '等待连接终端…',
    };

    constructor(
        private readonly presentation: TerminalPresentation,
        private readonly terminal: Pick<
            Terminal,
            'options' | 'cols' | 'rows' | 'write' | 'reset' | 'focus'
        >,
        private readonly update: (view: SessionView) => void,
    ) {}

    setAvailability(available: boolean, detail?: string) {
        this.available = available;
        if (!available && this.instance) {
            this.stop(detail || '宿主连接不可用；请重连终端。', true);
        } else if (!available && this.view.phase !== 'stopped') {
            this.publish({ ...this.view, message: detail || '等待宿主连接…' });
        } else if (available && this.visible && this.view.phase === 'idle') {
            // Initial availability opens once. A stopped/failed PTY never retries itself.
            void this.open();
        }
    }

    setVisible(visible: boolean) {
        this.visible = visible;
        const instance = this.instance;
        this.terminal.options.disableStdin =
            !visible ||
            !instance?.terminalId ||
            !!instance.ending ||
            this.view.phase !== 'running';
        if (!visible && instance) {
            clearTimeout(instance.resizeTimer);
            instance.size = undefined;
        }
        if (visible && this.available) {
            if (instance && !instance.terminalId) void this.startOpen(instance);
            else if (this.view.phase === 'idle') void this.open();
        }
    }

    private publish(view: SessionView) {
        this.view = view;
        this.update(view);
    }

    private current(instance: Instance): boolean {
        return this.instance === instance && this.available;
    }

    private cleanup(instance: Instance) {
        clearTimeout(instance.inputTimer);
        clearTimeout(instance.resizeTimer);
        instance.inputs.length = 0;
        instance.inputBytes = 0;
        instance.size = undefined;
    }

    private waitForExit(instance: Instance) {
        instance.ending = true;
        this.terminal.options.disableStdin = true;
        this.cleanup(instance);
        const detail =
            '进程已停止接收输入，正在等待尾部输出和退出状态；未提交的输入已丢弃，不会重放，输入回执不代表命令已执行。';
        this.publish({
            ...this.view,
            message: instance.outputWarning
                ? `${instance.outputWarning} ${detail}`
                : detail,
            error: !!instance.outputWarning,
        });
    }

    private closeRemote(terminalId: string) {
        // A rejected close is never retried against a new scope. The host and
        // remote lease remain responsible for cleanup when the bridge is gone.
        return this.presentation.close(terminalId);
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
            opening: false,
            inputs: [],
            inputBytes: 0,
            sending: false,
            resizing: false,
        };
        this.instance = instance;
        this.terminal.options.disableStdin = true;
        this.publish({ phase: 'opening', message: '正在连接终端…' });
        await this.startOpen(instance);
    }

    private async startOpen(instance: Instance) {
        if (instance.opening || !this.current(instance) || !this.visible)
            return;
        instance.opening = true;
        try {
            // An explicit reopen waits for prior cleanup; it must not race the
            // host's one-terminal-per-instance ownership check. Never retry close.
            if (this.release) await this.release;
            if (!this.current(instance) || !this.visible) return;
            const result = await this.presentation.open({
                cols: this.terminal.cols,
                rows: this.terminal.rows,
            });
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
            this.terminal.options.disableStdin = !this.visible;
            this.publish({
                phase: 'running',
                message: '已连接',
                shell: result.shell,
                path: result.path,
            });
            if (this.visible) this.terminal.focus();
            this.resize(this.terminal.cols, this.terminal.rows);
            void this.read(instance);
        } catch (error) {
            if (this.current(instance))
                this.stop(`打开失败：${message(error)} 请点击重连。`, true);
        } finally {
            instance.opening = false;
        }
    }

    input(data: string) {
        const instance = this.instance;
        if (
            !instance?.terminalId ||
            !this.current(instance) ||
            !this.visible ||
            instance.ending ||
            this.view.phase !== 'running' ||
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
            for (const chunk of input.chunks) {
                const last = instance.inputs.length - 1;
                if (
                    last >= 0 &&
                    encoder.encode(instance.inputs[last]).byteLength +
                        encoder.encode(chunk).byteLength <=
                        INPUT_LIMIT
                )
                    instance.inputs[last] += chunk;
                else instance.inputs.push(chunk);
            }
            instance.inputBytes += input.bytes;
            if (!instance.sending && !instance.inputTimer) {
                // A short bounded microbatch coalesces onData events without changing
                // xterm's keyboard/composition handling or replaying uncertain input.
                instance.inputTimer = setTimeout(() => {
                    instance.inputTimer = undefined;
                    void this.send(instance);
                }, 4);
            }
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
                try {
                    await this.presentation.input(instance.terminalId!, data);
                } finally {
                    // Drain/stop may have cleared the queue during this request.
                    instance.inputBytes = Math.max(
                        0,
                        instance.inputBytes - encoder.encode(data).byteLength,
                    );
                }
                if (!this.current(instance) || instance.ending) return;
            }
        } catch (error) {
            if (this.current(instance)) {
                if (
                    error instanceof BridgeError &&
                    error.code === 'STREAM_DRAINING'
                )
                    this.waitForExit(instance);
                else
                    this.stop(
                        `输入结果未确认：${message(error)} 不会自动重发。`,
                        true,
                    );
            }
        } finally {
            instance.sending = false;
        }
    }

    private async read(instance: Instance) {
        let cursor = 0;
        try {
            while (this.current(instance)) {
                const result = await this.presentation.read(
                    instance.terminalId!,
                    cursor,
                );
                if (!this.current(instance)) return;
                if (
                    !Number.isSafeInteger(result.cursor) ||
                    result.cursor < cursor ||
                    !(result.output instanceof Uint8Array) ||
                    result.output.byteLength > OUTPUT_LIMIT ||
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
                    if (instance.ending) this.waitForExit(instance);
                    else
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
                if (result.output.byteLength) {
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
                            ? `进程已退出${result.exitCode === undefined ? '' : `（${result.exitCode}）`}；可重连。`
                            : '终端已关闭；可重连。',
                    );
                    return;
                }
                // The next read acknowledges the bytes only after xterm rendered them.
                // The adapter keeps raw output byte boundaries, including split UTF-8.
            }
        } catch (error) {
            if (this.current(instance))
                this.stop(
                    `读取中断：${message(error)} 输出完整性无法确认；请重连。`,
                    true,
                );
        }
    }

    resize(cols: number, rows: number) {
        const instance = this.instance;
        if (
            !instance?.terminalId ||
            !this.current(instance) ||
            !this.visible ||
            instance.ending ||
            this.view.phase !== 'running' ||
            !Number.isInteger(cols) ||
            !Number.isInteger(rows) ||
            cols < 2 ||
            rows < 2
        )
            return;
        instance.size = { cols, rows };
        clearTimeout(instance.resizeTimer);
        instance.resizeTimer = setTimeout(
            () => void this.sendResize(instance),
            120,
        );
    }

    private async sendResize(instance: Instance) {
        if (
            !this.current(instance) ||
            !this.visible ||
            instance.ending ||
            instance.resizing
        )
            return;
        instance.resizing = true;
        try {
            while (
                this.current(instance) &&
                this.visible &&
                !instance.ending &&
                instance.size
            ) {
                const size = instance.size;
                instance.size = undefined;
                await this.presentation.resize(
                    instance.terminalId!,
                    size.cols,
                    size.rows,
                );
            }
        } catch (error) {
            if (this.current(instance)) {
                if (
                    error instanceof BridgeError &&
                    error.code === 'STREAM_DRAINING'
                )
                    this.waitForExit(instance);
                else
                    this.stop(`调整窗口失败：${message(error)} 请重连。`, true);
            }
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
