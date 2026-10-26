import { createRequire } from 'node:module';
import * as path from 'node:path';
import { accessSync, constants, statSync, write } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { IPty } from 'node-pty';
import { extensionError } from '../extensions/protocol.js';

export type LinuxPty = IPty & { readonly fd: number };
export interface TerminalRuntime {
    shell: string;
    spawn(cwd: string, cols: number, rows: number): LinuxPty;
}

/** Startup diagnostics contain only fixed reasons and controlled native identifiers. */
export function terminalStartupError(
    reason:
        | 'UNSUPPORTED_PLATFORM'
        | 'SHELL_UNAVAILABLE'
        | 'NATIVE_LOAD_FAILED'
        | 'NATIVE_API_UNAVAILABLE'
        | 'DOCKER_UNSUPPORTED_PLATFORM'
        | 'DOCKER_UNSUPPORTED_NETWORK'
        | 'DOCKER_LOCAL_DAEMON_REQUIRED',
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
    return new Error(
        `[staff-mcp] Terminal startup failed: reason=${reason} platform=${process.platform} arch=${process.arch} node=${process.version}${native.length ? ` native=${native.join(',')}` : ''}`,
    );
}

/** Native loading is opt-in; an explicitly requested runtime must be usable. */
export function loadTerminalRuntime(
    enabled: boolean,
): TerminalRuntime | undefined {
    if (!enabled) return undefined;
    if (process.platform !== 'linux')
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
                    'pty.node',
                ),
            );
        } catch (prebuildError) {
            nativeError = prebuildError;
        }
        throw terminalStartupError('NATIVE_LOAD_FAILED', nativeError);
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
                if (value !== undefined && !internal.has(key)) env[key] = value;
            }
            env.TERM ??= 'xterm-256color';
            env.SHELL = selectedShell;
            // Normal interactive startup files are intentionally honored. This is
            // the staff user's shell, not a filesystem or environment sandbox.
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
            return child as LinuxPty;
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
