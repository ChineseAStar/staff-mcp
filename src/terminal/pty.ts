import { createRequire } from 'node:module';
import * as path from 'node:path';
import { accessSync, constants, write } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { IPty } from 'node-pty';
import { extensionError } from '../extensions/protocol.js';

export type LinuxPty = IPty & { readonly fd: number };
export interface TerminalRuntime {
    shell: string;
    spawn(cwd: string, cols: number, rows: number): LinuxPty;
}

/** Loading native code is opt-in; ABI/libc or dependency failures never disable ordinary MCP. */
export function loadTerminalRuntime(
    enabled: boolean,
    shell = '/bin/bash',
): TerminalRuntime | undefined {
    if (!enabled) return undefined;
    if (process.platform !== 'linux') {
        console.error('[staff-mcp] Terminal unavailable: Linux is required.');
        return undefined;
    }
    try {
        if (!path.isAbsolute(shell)) throw new Error('Shell must be absolute');
        accessSync(shell, constants.X_OK);
        const pty: typeof import('node-pty') = createRequire(import.meta.url)(
            'node-pty',
        );
        if (typeof pty.spawn !== 'function')
            throw new Error('Missing PTY implementation');
        return {
            shell,
            spawn(cwd, cols, rows) {
                const env: Record<string, string> = {
                    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
                    TERM: 'xterm-256color',
                    LANG: process.env.LANG ?? 'C.UTF-8',
                    HISTFILE: '/dev/null',
                    HISTSIZE: '0',
                    HISTFILESIZE: '0',
                };
                // Do not pass connection tokens, proxy credentials, startup injection or arbitrary env.
                for (const key of [
                    'HOME',
                    'USER',
                    'LOGNAME',
                    'LC_ALL',
                    'LC_CTYPE',
                    'TZ',
                ]) {
                    if (process.env[key]) env[key] = process.env[key]!;
                }
                const args =
                    path.basename(shell) === 'bash'
                        ? ['--noprofile', '--norc', '-i']
                        : ['-i'];
                const child = pty.spawn(shell, args, {
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
    } catch {
        console.error(
            '[staff-mcp] Terminal unavailable: shell or node-pty native module could not be loaded.',
        );
        return undefined;
    }
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
