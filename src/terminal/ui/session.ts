import type { Terminal } from '@xterm/xterm';
import { BridgeError } from '../../file-manager/ui/bridge';
import type { TerminalPresentation } from './stream-adapter';

const INPUT_LIMIT = 32 * 1024;
const QUEUE_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const encoder = new TextEncoder();
const ERROR_CODE = /^(?:[A-Z][A-Z0-9_]{0,63}|-?[0-9]{1,10})$/;

export interface SessionView {
    phase: 'idle' | 'opening' | 'running' | 'stopped';
    message: string;
    shell?: string;
    path?: string;
    error?: boolean;
    code?: string;
    recovery?: 'terminal' | 'app';
    ending?: boolean;
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
                '此次输入超过剩余 256 KiB 预算，整批未接受；已有输入继续按序发送。',
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

// Fit, initial create and later resize share exactly the same remote boundary.
export function terminalSize(cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
    return {
        cols: Math.max(2, Math.min(1000, Math.floor(cols))),
        rows: Math.max(2, Math.min(1000, Math.floor(rows))),
    };
}

type TerminalSurface = Pick<
    Terminal,
    'options' | 'cols' | 'rows' | 'write' | 'focus'
>;

// One instance owns all in-flight work. Invalidating it fences every late
// receipt before it can write output, send queued input, or restart a reader.
export class TerminalSession {
    private instance?: Instance;
    // Allows a structured receipt already in flight to annotate lifecycle loss,
    // but never a subsequently opened session (or a disposed view).
    private stoppedInstance?: Instance;
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
        private terminal: TerminalSurface,
        private readonly update: (view: SessionView) => void,
        private readonly resetSurface: () => TerminalSurface,
    ) {}

    setAvailability(available: boolean) {
        this.available = available;
        if (!available && this.instance) {
            this.stop(
                '应用不可用；请从工作区重新打开终端应用。',
                true,
                undefined,
                'app',
            );
        } else if (!available && this.view.phase !== 'stopped') {
            this.publish({ ...this.view, message: '等待宿主连接…' });
        } else if (!available && this.view.recovery !== 'app') {
            this.publish({
                ...this.view,
                recovery: 'app',
                message: `${this.view.message} 应用不可用；请从工作区重新打开终端应用。`,
            });
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

    private waitForExit(
        instance: Instance,
        detail = '进程已停止接收输入，正在等待尾部输出和退出状态；未提交的输入已丢弃，不会重放，输入回执不代表命令已执行。',
    ) {
        instance.ending = true;
        this.terminal.options.disableStdin = true;
        this.cleanup(instance);
        this.publish({
            ...this.view,
            message: instance.outputWarning
                ? `${instance.outputWarning} ${detail}`
                : detail,
            error: !!instance.outputWarning,
            ending: true,
        });
    }

    private closeRemote(terminalId: string) {
        // A rejected detach is never retried against a new scope. Host cleanup
        // and backend retention bound the shell lifetime when the bridge is gone.
        return this.presentation.close(terminalId);
    }

    private fail(instance: Instance, error: unknown, detail: string) {
        if (!this.current(instance) && this.stoppedInstance !== instance)
            return;
        // Never echo remote messages, URLs or payloads. Retain the first safe,
        // structured cause across read/control/close and lifecycle callbacks.
        const rawCode = error instanceof BridgeError ? error.code : undefined;
        const code = rawCode && ERROR_CODE.test(rawCode) ? rawCode : undefined;
        const appUnavailable =
            this.view.recovery === 'app' ||
            (code &&
                [
                    'APP_UNAVAILABLE',
                    'APP_NOT_FOUND',
                    'APP_CHANGED',
                    'STREAM_DENIED',
                    'MCP_DISABLED',
                    'CONNECTION_CLOSED',
                    'STALE_CONNECTION',
                    'CHAT_NOT_FOUND',
                    'CHAT_ARCHIVED',
                    'SETTINGS_REQUIRED',
                    'ROLE_NOT_FOUND',
                    'ORIGIN_DENIED',
                    'UNAUTHORIZED',
                    'EXTENSION_NOT_NEGOTIATED',
                ].includes(code));
        const openUnconfirmed =
            code &&
            ['STREAM_OPEN_UNCONFIRMED', 'STREAM_OPEN_PENDING'].includes(code);
        const recovery = appUnavailable || openUnconfirmed ? 'app' : 'terminal';
        const action = appUnavailable
            ? '应用不可用；请从工作区重新打开终端应用。'
            : openUnconfirmed
              ? '请从工作区重新打开终端应用；当前页不能再次创建终端。'
              : code === 'WRITER_CONFLICT'
                ? '原会话仍被另一页面使用或旧连接尚未释放；请关闭另一页面或稍后手动重新连接，不会自动抢占或重试。'
                : '可手动重新连接，优先接回原会话；不会重放输入。';
        if (this.current(instance))
            this.stop(`${detail} ${action}`, true, code, recovery);
        else if (!this.view.code && code)
            this.publish({
                ...this.view,
                code,
                recovery,
                message: `${instance.outputWarning ? `${instance.outputWarning} ` : ''}${detail} ${action}`,
                error: true,
            });
    }

    private stop(
        detail: string,
        error = false,
        code?: string,
        recovery: SessionView['recovery'] = 'terminal',
    ) {
        const instance = this.instance;
        if (instance?.outputWarning) {
            detail = `${instance.outputWarning} ${detail}`;
            error = true;
        }
        this.instance = undefined;
        this.stoppedInstance = instance;
        this.terminal.options.disableStdin = true;
        if (instance) this.cleanup(instance);
        const stopped: SessionView = {
            ...this.view,
            phase: 'stopped',
            message: detail,
            error,
            code: this.view.code ?? code,
            recovery,
        };
        this.publish(stopped);
        if (instance?.terminalId) {
            this.release = this.closeRemote(instance.terminalId).catch(() => {
                if (!this.instance && this.view === stopped) {
                    this.publish({
                        ...this.view,
                        message: `${detail} 断开结果未确认；不会重发断开请求，原会话可能仍在运行。`,
                        error: true,
                    });
                }
            });
        }
    }

    async open() {
        if (
            this.instance ||
            !this.available ||
            !this.visible ||
            this.view.recovery === 'app'
        )
            return;
        const instance: Instance = {
            opening: false,
            inputs: [],
            inputBytes: 0,
            sending: false,
            resizing: false,
        };
        this.instance = instance;
        this.stoppedInstance = undefined;
        this.terminal.options.disableStdin = true;
        this.publish({ phase: 'opening', message: '正在连接终端…' });
        await this.startOpen(instance);
    }

    private async startOpen(instance: Instance) {
        if (instance.opening || !this.current(instance) || !this.visible)
            return;
        instance.opening = true;
        try {
            // An explicit reconnect waits for prior detach; never retry close or
            // race the host's one-stream-per-instance ownership check.
            if (this.release) await this.release;
            if (!this.current(instance) || !this.visible) return;
            // Drain accepted writes before replacing the surface. xterm.reset()
            // resets the screen, but leaves partial ANSI/UTF-8 parser state alive.
            await this.rendered;
            if (!this.current(instance) || !this.visible) return;
            this.terminal = this.resetSurface();
            const size = terminalSize(this.terminal.cols, this.terminal.rows);
            if (!size) throw new Error('无效的终端尺寸。');
            const result = await this.presentation.open(size);
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
            this.terminal.options.disableStdin = !this.visible;
            let message = '已连接；原会话状态未确认。';
            if (result.resumed === true)
                message = '已接回原终端；离线输出未保存，可按回车显示提示符。';
            else if (result.resumed === false) message = '已新建终端。';
            if (
                typeof result.retainedForMs === 'number' &&
                Number.isFinite(result.retainedForMs) &&
                result.retainedForMs > 0
            )
                message += ` 离线最多保留${result.retainedForMs / 3_600_000}小时。`;
            this.publish({
                phase: 'running',
                message,
                shell: result.shell,
                path: result.path,
            });
            if (this.visible) this.terminal.focus();
            this.resize(this.terminal.cols, this.terminal.rows);
            void this.read(instance);
        } catch (error) {
            this.fail(
                instance,
                error,
                error instanceof BridgeError &&
                    ['STREAM_OPEN_UNCONFIRMED', 'STREAM_OPEN_PENDING'].includes(
                        error.code,
                    )
                    ? '创建结果未确认；不会重发创建请求。晚到旧句柄只会清理。'
                    : '打开终端失败。',
            );
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
                    '此次输入超过剩余 256 KiB 预算，整批未接受；已有输入继续按序发送。',
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
        } catch {
            // Nothing from this onData batch was admitted. Preserve both the
            // already queued inputs and the current write's receipt/order.
            this.publish({
                ...this.view,
                message:
                    '此次输入超过剩余 256 KiB 预算，整批未接受；已有输入继续按序发送。',
                error: true,
            });
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
            if (
                this.current(instance) &&
                error instanceof BridgeError &&
                error.code === 'STREAM_DRAINING'
            )
                this.waitForExit(instance);
            else
                this.fail(
                    instance,
                    error,
                    '输入结果未确认；不会自动重发，回执不代表命令已执行。',
                );
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
                    instance.outputWarning = '输出可能不完整。';
                    const code = result.error?.code;
                    if (code && ERROR_CODE.test(code))
                        this.view = {
                            ...this.view,
                            code: this.view.code ?? code,
                        };
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
                        result.state === 'exited' &&
                            typeof result.exitCode === 'number' &&
                            Number.isFinite(result.exitCode)
                            ? `进程已退出（${result.exitCode}）；可重连。`
                            : '终端连接已结束；可重新连接，原会话可能仍在运行。',
                    );
                    return;
                }
                // The next read acknowledges the bytes only after xterm rendered them.
                // The adapter keeps raw output byte boundaries, including split UTF-8.
            }
        } catch (error) {
            this.fail(instance, error, '读取中断；输出完整性无法确认。');
        }
    }

    resize(cols: number, rows: number) {
        const instance = this.instance;
        const size = terminalSize(cols, rows);
        if (
            !instance?.terminalId ||
            !this.current(instance) ||
            !this.visible ||
            instance.ending ||
            this.view.phase !== 'running' ||
            !size
        )
            return;
        instance.size = size;
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
            if (
                this.current(instance) &&
                error instanceof BridgeError &&
                error.code === 'STREAM_DRAINING'
            )
                this.waitForExit(instance);
            else
                this.fail(
                    instance,
                    error,
                    '调整窗口结果未确认；不会自动重发。',
                );
        } finally {
            instance.resizing = false;
        }
    }

    async terminate() {
        const instance = this.instance;
        if (
            !instance?.terminalId ||
            !this.current(instance) ||
            !this.visible ||
            instance.ending ||
            this.view.phase !== 'running'
        )
            return;
        // Fence immediately, including repeated clicks, but keep the reader/ACK
        // alive to drain real output. An uncertain termination is never replayed.
        this.waitForExit(
            instance,
            '已请求结束原会话，正在等待尾部输出和退出状态；未提交输入已丢弃，不会重放。',
        );
        try {
            await this.presentation.terminate(instance.terminalId);
        } catch (error) {
            if (
                this.current(instance) &&
                error instanceof BridgeError &&
                error.code === 'STREAM_DRAINING'
            )
                this.waitForExit(instance);
            else
                this.fail(
                    instance,
                    error,
                    '结束结果未确认；不会重发结束请求，运行程序可能仍在继续。',
                );
        }
    }

    close() {
        if (this.instance)
            this.stop(
                '已请求断开终端连接；原会话会暂时保留，未提交输入不会重放，外部操作不会撤销。',
            );
    }

    dispose() {
        this.close();
        this.available = false;
        this.stoppedInstance = undefined;
    }
}
