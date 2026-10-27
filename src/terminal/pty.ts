import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { release } from 'node:os';
import type { Socket } from 'node:net';
import * as path from 'node:path';
import { accessSync, constants, statSync, write } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { IPty } from 'node-pty';
import { extensionError } from '../extensions/protocol.js';

export type LinuxPty = IPty & { readonly fd: number };
/** The platform adapter owns input acceptance and process cleanup, not the wire. */
export interface TerminalPty
    extends Pick<IPty, 'onData' | 'onExit' | 'pause' | 'resume' | 'resize'> {
    writeInput(data: Uint8Array, check: () => void): Promise<void>;
    kill(signal: NodeJS.Signals): void;
}
export interface TerminalRuntime {
    shell: string;
    spawn(cwd: string, cols: number, rows: number): TerminalPty;
}

export type TerminalStartupReason =
    | 'UNSUPPORTED_PLATFORM'
    | 'SHELL_UNAVAILABLE'
    | 'NATIVE_LOAD_FAILED'
    | 'NATIVE_API_UNAVAILABLE'
    | 'NATIVE_SPAWN_FAILED'
    | 'DOCKER_UNSUPPORTED_PLATFORM'
    | 'DOCKER_UNSUPPORTED_NETWORK'
    | 'DOCKER_LOCAL_DAEMON_REQUIRED';

export class TerminalStartupError extends Error {
    constructor(
        readonly reason: TerminalStartupReason,
        message: string,
    ) {
        super(message);
    }
}

/** Startup diagnostics contain only fixed reasons and controlled native identifiers. */
export function terminalStartupError(
    reason: TerminalStartupReason,
    nativeError?: unknown,
): Error {
    const message = nativeError instanceof Error ? nativeError.message : '';
    const code = (nativeError as NodeJS.ErrnoException | undefined)?.code;
    const native = [
        ...(['MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'].includes(code ?? '')
            ? [code]
            : []),
        ...new Set(
            message.match(
                /\bGLIBC(?:XX)?_\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b|\b(?:libc|libstdc\+\+|libgcc_s|libm|libpthread|libdl|libutil)\.so(?:\.\d{1,3})*\b/g,
            ) ?? [],
        ),
    ];
    return new TerminalStartupError(
        reason,
        `[staff-mcp] Terminal startup failed: reason=${reason} platform=${process.platform} arch=${process.arch} node=${process.version}${native.length ? ` native=${native.join(',')}` : ''}`,
    );
}

/** Native loading is opt-in; an explicitly requested runtime must be usable. */
export function loadTerminalRuntime(
    enabled: boolean,
): TerminalRuntime | undefined {
    if (!enabled) return undefined;
    if (process.platform !== 'linux' && process.platform !== 'win32')
        throw terminalStartupError('UNSUPPORTED_PLATFORM');

    const executable = (candidate: string) => {
        if (!path.isAbsolute(candidate))
            throw new Error('Shell must be absolute');
        accessSync(candidate, constants.X_OK);
        if (!statSync(candidate).isFile())
            throw new Error('Shell must be a file');
        return candidate;
    };
    let selectedShell: string;
    if (process.platform === 'win32') {
        // ConPTY requires a supported Windows build; never select legacy winpty.
        if (!(Number(release().split('.')[2]) >= 18309))
            throw terminalStartupError('UNSUPPORTED_PLATFORM');
        selectedShell = windowsShell();
    } else
        try {
            selectedShell = executable(process.env.SHELL ?? '');
        } catch {
            try {
                selectedShell = executable('/bin/bash');
            } catch {
                throw terminalStartupError('SHELL_UNAVAILABLE');
            }
        }

    const require = createRequire(import.meta.url);
    let pty: typeof import('node-pty');
    try {
        pty = require('node-pty');
    } catch (error) {
        // node-pty's search can replace a loader error with a later missing-path
        // error. Probe its shipped prebuild only to recover controlled diagnostics.
        let nativeError = error;
        try {
            const root = path.dirname(require.resolve('node-pty/package.json'));
            require(
                path.join(
                    root,
                    'prebuilds',
                    `${process.platform}-${process.arch}`,
                    process.platform === 'win32' ? 'conpty.node' : 'pty.node',
                ),
            );
        } catch (prebuildError) {
            nativeError = prebuildError;
        }
        throw terminalStartupError('NATIVE_LOAD_FAILED', nativeError);
    }
    if (process.platform === 'win32') {
        // Pipe/cleanup internals below were audited against the lockfile's node-pty.
        try {
            require('node-pty/lib/utils').loadNativeModule('conpty');
        } catch (error) {
            throw terminalStartupError('NATIVE_LOAD_FAILED', error);
        }
    }
    if (typeof pty.spawn !== 'function')
        throw terminalStartupError('NATIVE_API_UNAVAILABLE');
    return {
        shell: selectedShell,
        spawn(cwd, cols, rows) {
            const env: Record<string, string> = {};
            // Exact staff/control variables only: preserve PATH, virtualenvs and user env.
            const internal = new Set([
                'STAFF_GLOBAL_DIR',
                'STAFF_MCP_IS_DOCKER',
                'STAFF_MCP_DATA_BOOTSTRAP',
                'STAFF_MCP_DATA_HOST',
                'STAFF_MCP_DATA_PORT',
                'MCP_REVERSE_URL',
                'MCP_REVERSE_TOKEN',
                'MCP_REVERSE_NAME',
                'MCP_HTTP_TOKEN',
                'STAFF_MCP_HTTP_TOKEN',
                'STAFF_MCP_REVERSE_TOKEN',
            ]);
            for (const [key, value] of Object.entries(process.env)) {
                if (
                    value !== undefined &&
                    !internal.has(
                        process.platform === 'win32' ? key.toUpperCase() : key,
                    )
                )
                    env[key] = value;
            }
            env.TERM ??= 'xterm-256color';
            env.SHELL = selectedShell;
            if (process.platform === 'win32') {
                try {
                    return windowsPty(
                        pty.spawn(
                            selectedShell,
                            path.basename(selectedShell).toLowerCase() ===
                                'cmd.exe'
                                ? ['/d']
                                : ['-NoLogo', '-NoProfile'],
                            {
                                cwd,
                                cols,
                                rows,
                                env,
                                // The bundled official ConPTY closes owned console handles;
                                // the OS variant uses delayed PID enumeration/kill instead.
                                useConptyDll: true,
                                handleFlowControl: false,
                            },
                        ),
                    );
                } catch (error) {
                    if (error instanceof TerminalStartupError) throw error;
                    throw terminalStartupError('NATIVE_SPAWN_FAILED');
                }
            }
            // Linux startup files and raw-byte behavior remain unchanged.
            const child = pty.spawn(selectedShell, ['-i'], {
                cwd,
                cols,
                rows,
                env,
                encoding: null,
                handleFlowControl: false,
            });
            if (
                !('fd' in child) ||
                typeof child.fd !== 'number' ||
                typeof child.pause !== 'function' ||
                typeof child.resume !== 'function'
            ) {
                child.kill('SIGKILL');
                extensionError(
                    'TERMINAL_DISABLED',
                    'PTY implementation lacks bounded Linux I/O',
                );
            }
            return {
                onData: child.onData,
                onExit: child.onExit,
                pause: () => child.pause(),
                resume: () => child.resume(),
                resize: (cols, rows) => child.resize(cols, rows),
                writeInput: (data, check) =>
                    writeInput(child as LinuxPty, data, check),
                kill: (signal) => signalGroup(child as LinuxPty, signal),
            };
        },
    };
}

/** Do not use node-pty.write(): its void API can hide an unbounded internal input queue. */
export async function writeInput(
    pty: LinuxPty,
    data: Uint8Array,
    check: () => void,
) {
    let offset = 0;
    while (offset < data.byteLength) {
        check();
        try {
            const written = await new Promise<number>((resolve, reject) => {
                write(
                    pty.fd,
                    data,
                    offset,
                    data.byteLength - offset,
                    null,
                    (error, count) => (error ? reject(error) : resolve(count)),
                );
            });
            if (!written)
                extensionError('INVALID_STATE', 'PTY accepted no input');
            offset += written;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
            await delay(5);
        }
    }
    check();
}

/** Host uid is inherited. Process-group cleanup cannot contain daemonized descendants. */
export function signalGroup(pty: LinuxPty, signal: NodeJS.Signals) {
    try {
        process.kill(-pty.pid, signal);
    } catch {
        /* detached descendants are best effort */
    }
    try {
        pty.kill(signal);
    } catch {
        /* already exited */
    }
}

/** Resolve only real executables, including rejecting stale WindowsApps aliases. */
function windowsShell(): string {
    const directories = (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((entry) => entry.replace(/^"(.*)"$/, '$1'))
        .filter((entry) => path.isAbsolute(entry));
    const systemRoot = process.env.SystemRoot;
    const candidates = [
        ...directories.map((dir) => path.join(dir, 'pwsh.exe')),
        ...directories.map((dir) => path.join(dir, 'powershell.exe')),
        ...(systemRoot
            ? [
                  path.join(
                      systemRoot,
                      'System32',
                      'WindowsPowerShell',
                      'v1.0',
                      'powershell.exe',
                  ),
              ]
            : []),
        process.env.ComSpec ?? '',
        ...(systemRoot ? [path.join(systemRoot, 'System32', 'cmd.exe')] : []),
    ];
    for (const candidate of new Set(candidates)) {
        if (!path.isAbsolute(candidate)) continue;
        const name = path.basename(candidate).toLowerCase();
        if (!['pwsh.exe', 'powershell.exe', 'cmd.exe'].includes(name)) continue;
        try {
            accessSync(candidate, constants.X_OK);
            if (!statSync(candidate).isFile()) continue;
            const result = spawnSync(
                candidate,
                name === 'cmd.exe'
                    ? ['/d', '/s', '/c', 'exit 0']
                    : [
                          '-NoLogo',
                          '-NoProfile',
                          '-NonInteractive',
                          '-Command',
                          'exit 0',
                      ],
                {
                    stdio: 'ignore',
                    windowsHide: true,
                    timeout: 5000,
                },
            );
            if (!result.error && result.status === 0) return candidate;
        } catch {
            /* Try the next fixed shell candidate without logging host details. */
        }
    }
    throw terminalStartupError('SHELL_UNAVAILABLE');
}

/** Audited node-pty@1.2.0-beta.18 internals, not a second PTY implementation. */
function windowsPty(child: IPty): TerminalPty {
    const agent = (
        child as IPty & {
            _agent?: {
                _useConptyDll: boolean;
                _pendingPtyInfo?: object;
                innerPid: number;
                exitCode?: number;
                inSocket: Socket;
                outSocket: Socket;
                _conoutSocketWorker: { dispose(): void };
                kill(): void;
            };
        }
    )._agent;
    if (
        !agent ||
        !agent._useConptyDll ||
        typeof agent.inSocket?.write !== 'function' ||
        typeof agent._conoutSocketWorker?.dispose !== 'function' ||
        typeof agent.kill !== 'function'
    ) {
        // Never fall back to fd writes, PID scans, or the system ConPTY kill path.
        if (agent?._useConptyDll) {
            try {
                agent.kill();
                agent._conoutSocketWorker.dispose();
                agent.outSocket.destroy();
            } catch {
                /* Controlled failure below. */
            }
        }
        throw terminalStartupError('NATIVE_API_UNAVAILABLE');
    }
    const input = agent.inSocket;
    const output = agent.outSocket;
    let stopped = false;
    let killed = false;
    let writing = false;
    type Exit = { exitCode: number; signal?: number };
    let exit: Exit | undefined;
    const listeners = new Set<(event: Exit) => void>();
    function finish(event: Exit) {
        if (exit) return;
        exit = event;
        stopped = true;
        input.destroy();
        // The ConPTY output worker owns a listening server even after natural
        // shell exit. Dispose it without re-killing the already exited console.
        agent!._conoutSocketWorker.dispose();
        for (const listener of listeners) listener(event);
        listeners.clear();
    }
    child.onExit(finish);
    // Subscribe before ready_datapipe: node-pty only installs its close -> exit
    // forwarding after that event, which never happens for a cancelled connection.
    output.once('close', () => {
        // Let node-pty's normal native exit forwarding run first, if installed.
        queueMicrotask(() => {
            if (exit) return;
            kill();
            finish({ exitCode: agent!.exitCode ?? -1 });
        });
    });
    input.on('error', () => kill());
    output.on('error', () => kill());
    function kill() {
        if (killed || exit) return;
        stopped = true;
        const pending = !!agent!._pendingPtyInfo;
        try {
            // Public child.kill() defers until first output; agent.kill() closes
            // this owned pseudoconsole by handle, without process.kill/PID reuse.
            child.resume();
            agent!.kill();
            // Also dispose when no final data arrives to trigger node-pty's own
            // disposal listener. dispose() permits a bounded final output drain.
            agent!._conoutSocketWorker.dispose();
            killed = true;
            if (pending) {
                // No shell was connected, hence no native process-exit callback.
                // Cancelled resources are not a successful output EOF/exit 0.
                output.destroy();
                finish({ exitCode: -1 });
            }
        } catch {
            // The session's escalation retries cleanup; never expose native text.
        }
    }
    return {
        onData: child.onData,
        onExit(listener) {
            listeners.add(listener);
            if (exit) {
                const event = exit;
                queueMicrotask(() => {
                    if (listeners.delete(listener)) listener(event);
                });
            }
            return {
                dispose: () => {
                    listeners.delete(listener);
                },
            };
        },
        pause: () => child.pause(),
        resume: () => child.resume(),
        resize: (cols, rows) => child.resize(cols, rows),
        kill,
        async writeInput(data, check) {
            check();
            if (stopped || writing || data.byteLength > 32 * 1024)
                extensionError('INVALID_STATE', 'PTY input is unavailable');
            writing = true;
            try {
                if (data.byteLength) {
                    // ConPTY itself parses streaming UTF-8. Pass bytes unchanged:
                    // split Chinese/emoji never become per-frame replacement text,
                    // and there is no JS decoder tail ACKed before pipe acceptance.
                    // child.write is void and queues deferred writes without bounds.
                    await new Promise<void>((resolve, reject) => {
                        const closed = () =>
                            finishWrite(new Error('PTY input closed'));
                        const failed = () =>
                            finishWrite(new Error('PTY input failed'));
                        const finishWrite = (error?: Error | null) => {
                            input.off('close', closed);
                            input.off('error', failed);
                            if (error) reject(error);
                            else resolve();
                        };
                        input.once('close', closed);
                        input.once('error', failed);
                        // One bounded write, awaited until OS pipe acceptance, not
                        // merely socket enqueue and never proof of shell execution.
                        input.write(data, finishWrite);
                    });
                }
                check();
                if (stopped)
                    extensionError('INVALID_STATE', 'PTY input closed');
            } catch {
                kill();
                extensionError('INVALID_STATE', 'PTY input failed');
            } finally {
                writing = false;
            }
        },
    };
}
