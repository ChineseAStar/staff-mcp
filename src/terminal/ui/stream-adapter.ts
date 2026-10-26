/** Terminal-only presentation of the host's generic leased byte streams. */
export interface StreamBridge {
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

interface StreamOpenResult {
    streamId: string;
    leaseMs: number;
    metadata?: Record<string, unknown>;
}

interface StreamReadResult {
    cursor: number;
    data: string;
    state: 'open' | 'ended';
    metadata?: Record<string, unknown>;
    incomplete?: boolean;
    error?: { code: string; message: string };
}

export interface TerminalOpenResult {
    terminalId: string;
    rootId?: string;
    path?: string;
    shell?: string;
    leaseMs: number;
}

export interface TerminalReadResult {
    cursor: number;
    output: Uint8Array;
    state: 'running' | 'exited';
    exitCode?: number;
    outputIncomplete?: boolean;
    error?: { code: string; message: string };
}

export interface TerminalPresentation {
    open(params: { cols: number; rows: number }): Promise<TerminalOpenResult>;
    input(terminalId: string, data: string): Promise<unknown>;
    resize(terminalId: string, cols: number, rows: number): Promise<unknown>;
    read(terminalId: string, cursor: number): Promise<TerminalReadResult>;
    close(terminalId: string): Promise<unknown>;
}

const encoder = new TextEncoder();

function decode(data: unknown): Uint8Array {
    if (
        typeof data !== 'string' ||
        data.length > 4 * Math.ceil((64 * 1024) / 3) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            data,
        )
    )
        throw new Error('宿主输出超限或格式无效。');
    const binary = atob(data);
    if (binary.length > 64 * 1024 || btoa(binary) !== data)
        throw new Error('宿主输出超限或格式无效。');
    return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}

export function terminalPresentation(
    bridge: StreamBridge,
): TerminalPresentation {
    return {
        async open(params) {
            const result = await bridge.request<StreamOpenResult>(
                'streamOpen',
                params,
            );
            const metadata = result.metadata;
            return {
                terminalId: result.streamId,
                leaseMs: result.leaseMs,
                rootId:
                    typeof metadata?.rootId === 'string'
                        ? metadata.rootId
                        : undefined,
                path:
                    typeof metadata?.path === 'string'
                        ? metadata.path
                        : undefined,
                shell:
                    typeof metadata?.shell === 'string'
                        ? metadata.shell
                        : undefined,
            };
        },
        input(terminalId, data) {
            const bytes = encoder.encode(data);
            if (bytes.byteLength > 32 * 1024)
                throw new Error('终端输入超过 32 KiB。');
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 8192)
                binary += String.fromCharCode(
                    ...bytes.subarray(offset, offset + 8192),
                );
            return bridge.request('streamWrite', {
                streamId: terminalId,
                data: btoa(binary),
            });
        },
        resize(terminalId, cols, rows) {
            return bridge.request('streamCommand', {
                streamId: terminalId,
                command: 'resize',
                params: { cols, rows },
            });
        },
        async read(terminalId, cursor) {
            const result = await bridge.request<StreamReadResult>(
                'streamRead',
                {
                    streamId: terminalId,
                    cursor,
                },
            );
            if (
                !['open', 'ended'].includes(result.state) ||
                (result.metadata !== undefined &&
                    (!result.metadata ||
                        typeof result.metadata !== 'object' ||
                        Array.isArray(result.metadata)))
            )
                throw new Error('宿主输出格式无效。');
            const exitCode = result.metadata?.exitCode ?? undefined;
            if (exitCode !== undefined && !Number.isSafeInteger(exitCode))
                throw new Error('宿主退出状态无效。');
            return {
                cursor: result.cursor,
                output: decode(result.data),
                state: result.state === 'open' ? 'running' : 'exited',
                exitCode: exitCode as number | undefined,
                outputIncomplete: result.incomplete,
                error: result.error,
            };
        },
        close(terminalId) {
            return bridge.request('streamClose', { streamId: terminalId });
        },
    };
}
