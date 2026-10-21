export interface Lifecycle {
    enabled: boolean;
    connected: boolean;
    message?: string;
}

export interface TransferProgress {
    type: 'transfer-progress';
    transferId: string;
    name: string;
    direction: 'upload' | 'download';
    loaded: number;
    total: number;
    status: string;
    error?: string;
}

interface WireError {
    code: number | string;
    message: string;
    data?: { code?: string };
}

export class BridgeError extends Error {
    readonly code: string;

    constructor(error: WireError) {
        super(error.message);
        this.name = 'BridgeError';
        this.code = error.data?.code ?? String(error.code);
    }
}

export function errorMessage(error: unknown): string {
    if (error instanceof BridgeError) {
        const hints: Record<string, string> = {
            READ_ONLY: '此位置为只读，不能修改。',
            VERSION_CONFLICT:
                '文件已被其他操作修改。请重新读取，或先复制当前草稿。',
            NOT_FOUND: '文件或目录不存在，请刷新目录。',
            ALREADY_EXISTS: '目标已存在；不会自动覆盖。',
            TOO_LARGE: '文件超过此操作的大小限制，请使用下载。',
            OUTSIDE_ROOT: '路径不在允许的根目录内。',
            EXTENSION_NOT_NEGOTIATED:
                '连接未启用文件管理扩展，请在宿主重新打开应用。',
            DIRECTORY_NOT_EMPTY:
                '目录非空；如需删除全部内容，请明确勾选递归删除。',
            NOT_EMPTY: '目录非空；如需删除全部内容，请明确勾选递归删除。',
        };
        const hint = hints[error.code];
        return `${hint ? `${hint} ` : ''}${error.message} [${error.code}]`;
    }
    return error instanceof Error ? error.message : String(error);
}

// Theme values are accepted only on the authenticated MessagePort, never from
// window messages. Keep this list aligned with chat-ai's semantic palette.
const themeVariables = new Set([
    '--background',
    '--foreground',
    '--color-primary',
    '--color-primary-hover',
    '--color-primary-light',
    '--color-surface',
    '--color-surface-hover',
    '--color-surface-active',
    '--color-border',
    '--color-border-light',
    '--color-overlay',
    '--text-primary',
    '--text-secondary',
    '--text-tertiary',
    '--text-muted',
    '--text-inverse',
    '--bg-primary',
    '--bg-secondary',
    '--bg-tertiary',
    '--bg-muted',
    '--bg-inverse',
    '--interactive-hover',
    '--interactive-active',
    '--interactive-focus',
    '--input-bg',
    '--input-border',
    '--input-focus-border',
    '--app-panel-solid',
    '--app-panel-border',
]);

function applyTheme(data: Record<string, unknown>) {
    const root = document.documentElement;
    root.classList.toggle('dark', data.dark === true);
    root.style.colorScheme = data.dark === true ? 'dark' : 'light';
    const variables = data.variables;
    // A theme event is a complete snapshot; clear stale overrides on theme switch.
    for (const name of themeVariables) root.style.removeProperty(name);
    if (!variables || typeof variables !== 'object' || Array.isArray(variables))
        return;
    for (const [name, value] of Object.entries(variables)) {
        if (
            themeVariables.has(name) &&
            typeof value === 'string' &&
            value.length <= 256 &&
            CSS.supports('color', value)
        ) {
            root.style.setProperty(name, value);
        }
    }
}

const mutations = new Set([
    'saveText',
    'createFile',
    'mkdir',
    'move',
    'delete',
    'uploadStart',
    'uploadChunk',
    'uploadFinish',
]);

// This channel is exclusively the iframe bridge, not a general MCP client.
class FileManagerBridge {
    private port?: MessagePort;
    private sequence = 0;
    private pending = new Map<
        string,
        {
            resolve: (value: unknown) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
            method: string;
        }
    >();
    private listeners = new Set<() => void>();
    private progressListeners = new Set<(progress: TransferProgress) => void>();
    private state: Lifecycle = {
        enabled: false,
        connected: false,
        message: '等待宿主建立安全连接…',
    };
    private readyTimer: ReturnType<typeof setInterval>;

    constructor() {
        // Install the listener before announcing readiness. Re-announcing also
        // tolerates the host installing its own load listener a little later.
        window.addEventListener('message', this.connect);
        this.readyTimer = setInterval(() => this.ready(), 700);
        this.ready();
    }

    private ready() {
        if (!this.port && window.parent !== window) {
            window.parent.postMessage({ type: 'file-manager-ready' }, '*');
        }
    }

    private connect = (event: MessageEvent) => {
        const data = event.data;
        if (
            this.port ||
            event.source !== window.parent ||
            window.parent === window ||
            data?.type !== 'file-manager-connect' ||
            data.version !== 1 ||
            typeof data.nonce !== 'string' ||
            !data.nonce ||
            typeof data.instanceId !== 'string' ||
            !data.instanceId ||
            event.ports.length !== 1
        ) {
            return;
        }
        clearInterval(this.readyTimer);
        window.removeEventListener('message', this.connect);
        this.port = event.ports[0];
        this.port.onmessage = this.receive;
        this.port.onmessageerror = () => {
            this.setLifecycle({
                connected: false,
                enabled: false,
                message: '安全通道异常；草稿仍保留，请在宿主重新打开应用。',
            });
        };
        this.port.start();
        this.setLifecycle({ connected: true, enabled: true });
    };

    private receive = (event: MessageEvent) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'theme') {
            applyTheme(data);
            return;
        }
        if (data.type === 'lifecycle') {
            this.setLifecycle({
                connected: data.connected === true,
                enabled: data.enabled === true,
                message:
                    typeof data.message === 'string' ? data.message : undefined,
            });
            return;
        }
        if (
            data.type === 'transfer-progress' &&
            typeof data.transferId === 'string'
        ) {
            for (const listener of this.progressListeners) listener(data);
            return;
        }
        if (data.version !== 1 || typeof data.id !== 'string') return;
        const pending = this.pending.get(data.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(data.id);
        if (data.error) pending.reject(new BridgeError(data.error));
        else pending.resolve(data.result);
    };

    private setLifecycle(state: Lifecycle) {
        this.state = state;
        if (!state.connected || !state.enabled) {
            for (const [id, pending] of this.pending) {
                if (pending.method === 'transferCancel' && state.connected)
                    continue;
                clearTimeout(pending.timer);
                pending.reject(
                    new Error(
                        mutations.has(pending.method)
                            ? '连接已暂停或断开，写入结果待核实。请重新读取目标后再决定是否重试。'
                            : '连接已暂停或断开；当前操作未能取得结果。',
                    ),
                );
                this.pending.delete(id);
            }
        }
        for (const listener of this.listeners) listener();
    }

    snapshot = () => this.state;

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    onProgress(listener: (progress: TransferProgress) => void) {
        this.progressListeners.add(listener);
        return () => {
            this.progressListeners.delete(listener);
        };
    }

    post(message: { type: 'app-state'; dirty: boolean }) {
        this.port?.postMessage(message);
    }

    request<T>(
        method: string,
        params: Record<string, unknown> = {},
        transfer: Transferable[] = [],
    ): Promise<T> {
        const localHostMethod =
            method === 'copy' || method === 'transferCancel';
        if (
            !this.port ||
            (!localHostMethod && (!this.state.connected || !this.state.enabled))
        ) {
            return Promise.reject(
                new Error('应用当前不可操作；草稿仍保留在此页面。'),
            );
        }
        const id = `file-ui-${++this.sequence}`;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new Error(
                        mutations.has(method)
                            ? '请求超时，写入结果待核实。不要直接重放，请刷新或重新读取目标。'
                            : '请求超时，请检查宿主连接后重试。',
                    ),
                );
            }, 90_000);
            this.pending.set(id, {
                resolve: (value) => resolve(value as T),
                reject,
                timer,
                method,
            });
            try {
                this.port!.postMessage(
                    { version: 1, id, method, params },
                    transfer,
                );
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }
}

export const bridge = new FileManagerBridge();
