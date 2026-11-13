import {
    execFile,
    spawn,
    type ChildProcess,
    type ExecFileException,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionFeature } from './extensions/config.js';
import {
    TerminalStartupError,
    terminalStartupError,
    type TerminalStartupReason,
} from './terminal/pty.js';

const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 20_000;
const DEFAULT_CONTAINER_ID_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_CONTAINER_CLEANUP_TIMEOUT_MS = 20_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;
const CONTAINER_ID_POLL_INTERVAL_MS = 50;

interface SignalSource {
    on(event: NodeJS.Signals, listener: () => void): unknown;
    removeListener(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface DockerProxyOptions {
    command?: string;
    commandPrefixArgs?: readonly string[];
    input?: NodeJS.ReadableStream;
    signalSource?: SignalSource;
    gracefulShutdownTimeoutMs?: number;
    containerIdWaitTimeoutMs?: number;
    containerCleanupTimeoutMs?: number;
    forceKillTimeoutMs?: number;
    /** Human-readable hint (workspace, port, ...) embedded in the container name. */
    nameHint?: string;
}

interface ContainerIdentityConfig {
    args: string[];
    cidFilePath: string;
    containerName: string;
    ownedDirectory: string;
}

interface ChildExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}

function exitCodeFromSignal(signal: NodeJS.Signals | null): number {
    switch (signal) {
        case 'SIGHUP':
            return 129;
        case 'SIGINT':
            return 130;
        case 'SIGKILL':
            return 137;
        case 'SIGTERM':
            return 143;
        default:
            return 1;
    }
}

function hasManagedIdentityArg(args: readonly string[]): boolean {
    return args.some(
        (arg) =>
            arg === '--cidfile' ||
            arg.startsWith('--cidfile=') ||
            arg === '--name' ||
            arg.startsWith('--name='),
    );
}

const CONTAINER_NAME_PREFIX = 'staff-mcp';
const CONTAINER_NAME_HINT_MAX_LENGTH = 40;
const NAME_SEGMENT_FALLBACK = 'session';

/**
 * Sanitize an arbitrary string into a Docker-name-safe segment.
 * Docker names only accept [a-zA-Z0-9][a-zA-Z0-9_.-], so everything else is
 * folded to '-'. Returns an empty string when nothing usable remains.
 */
export function sanitizeNameSegment(value: string, maxLength = 24): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-_.]+|[-_.]+$/g, '')
        .slice(0, maxLength)
        .replace(/[-_.]+$/g, '');
}

/**
 * Build a human-meaningful hint for the container name from launch context,
 * so users can tell containers apart in `docker ps`:
 *   stdio:   <workspace>
 *   http:    <workspace>-<port>
 *   reverse: <workspace>[-<reverseName>]  (reverseName omitted when redundant)
 */
export function buildDockerNameHint(parts: {
    workspaceDir: string;
    transport: string;
    port?: number | string;
    reverseName?: string;
}): string {
    const workspace = path.basename(parts.workspaceDir);
    if (parts.transport === 'http' && parts.port) {
        return `${workspace}-${parts.port}`;
    }
    if (parts.transport === 'reverse' && parts.reverseName) {
        const workspaceSlug = sanitizeNameSegment(workspace);
        const reverseSlug = sanitizeNameSegment(parts.reverseName);
        if (workspaceSlug && workspaceSlug === reverseSlug) {
            return workspace;
        }
        return `${workspace}-${parts.reverseName}`;
    }
    return workspace;
}

/**
 * Compose the final container name: a fixed prefix, a human-readable
 * discriminator and a short random suffix. The suffix keeps the name unique
 * enough for the by-name fallback cleanup path; duplicate names are also
 * rejected safely by Docker at container creation time.
 */
function buildContainerName(nameHint?: string): string {
    const randomSuffix = randomBytes(3).toString('hex');
    const hint = sanitizeNameSegment(
        nameHint ?? '',
        CONTAINER_NAME_HINT_MAX_LENGTH,
    );
    const discriminator = hint || NAME_SEGMENT_FALLBACK;
    return `${CONTAINER_NAME_PREFIX}-${discriminator}-${randomSuffix}`;
}

function prepareContainerIdentity(
    dockerArgs: readonly string[],
    nameHint?: string,
): ContainerIdentityConfig {
    const args = [...dockerArgs];
    if (hasManagedIdentityArg(args)) {
        throw new Error(
            '--cidfile and --name are managed internally by staff-mcp.',
        );
    }

    const runIndex = args.indexOf('run');
    if (runIndex < 0) {
        throw new Error(
            "Docker proxy arguments must contain the 'run' subcommand.",
        );
    }

    const ownedDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'staff-mcp-container-'),
    );
    const cidFilePath = path.join(ownedDirectory, 'container.cid');
    const containerName = buildContainerName(nameHint);
    args.splice(
        runIndex + 1,
        0,
        '--cidfile',
        cidFilePath,
        '--name',
        containerName,
    );
    return { args, cidFilePath, containerName, ownedDirectory };
}

function readContainerId(cidFilePath: string): string | undefined {
    try {
        const containerId = fs.readFileSync(cidFilePath, 'utf8').trim();
        return /^[a-f0-9]{64}$/i.test(containerId) ? containerId : undefined;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return undefined;
        }
        console.error(
            `[staff-mcp] Failed to read Docker cidfile '${cidFilePath}':`,
            error,
        );
        return undefined;
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissingContainerError(stderr: string): boolean {
    return /no such container|no container with (?:name or id|id|name).*found|container .* does not exist/i.test(
        stderr,
    );
}

/**
 * Reject Docker options that would detach the CLI or disable the lifecycle
 * guarantees managed by staff-mcp. This validator is intentionally applied to
 * user-supplied Docker options only, because the command executed inside the
 * container can legitimately contain similarly named flags.
 */
export function validateAdditionalDockerArgs(args: readonly string[]): void {
    for (const arg of args) {
        const normalized = arg.toLowerCase();
        const isShortDetachOption =
            (/^-[^-][a-z]*$/i.test(arg) && arg.slice(1).includes('d')) ||
            normalized.startsWith('-d=');

        if (
            isShortDetachOption ||
            normalized === '--detach' ||
            (normalized.startsWith('--detach=') &&
                normalized !== '--detach=false')
        ) {
            throw new Error(
                'detached containers are not supported by the staff-mcp Docker proxy',
            );
        }

        if (
            normalized.startsWith('--rm=') &&
            !['--rm=true', '--rm=t', '--rm=1'].includes(normalized)
        ) {
            throw new Error(
                '--rm cannot be disabled by the staff-mcp Docker proxy',
            );
        }

        if (
            normalized.startsWith('--interactive=') &&
            ![
                '--interactive=true',
                '--interactive=t',
                '--interactive=1',
            ].includes(normalized)
        ) {
            throw new Error(
                'interactive stdin cannot be disabled by the staff-mcp Docker proxy',
            );
        }

        if (/^-[^-]*i[^=]*=/.test(arg)) {
            throw new Error(
                'assigned -i values are not supported; use -i or --interactive=true',
            );
        }

        if (
            normalized === '--cidfile' ||
            normalized.startsWith('--cidfile=') ||
            normalized === '--name' ||
            normalized.startsWith('--name=')
        ) {
            throw new Error(
                '--cidfile and --name are managed internally by staff-mcp',
            );
        }
    }
}

class DockerPreflightError extends Error {
    constructor(
        readonly reason: TerminalStartupReason,
        message: string,
    ) {
        super(message);
    }
}

/** Docker output/argv can contain credentials. Never include either in errors. */
async function dockerOutput(
    command: string,
    prefix: readonly string[],
    args: string[],
): Promise<string> {
    return new Promise((resolve, reject) => {
        const processErrorCodes = [
            'ENOENT',
            'EACCES',
            'EPERM',
            'ENOEXEC',
            'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        ];
        const fail = (error: ExecFileException) => {
            if (
                error.killed &&
                error.signal === 'SIGKILL' &&
                error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ) {
                reject(
                    new DockerPreflightError(
                        'DOCKER_CHECK_TIMEOUT',
                        'Docker-compatible CLI check timed out after 2000ms.',
                    ),
                );
                return;
            }
            // Only controlled identifiers are safe: child errors may embed
            // the command, endpoint credentials or arbitrary stderr.
            const code =
                typeof error.code === 'number'
                    ? ` exitCode=${error.code}`
                    : processErrorCodes.includes(error.code ?? '')
                      ? ` code=${error.code}`
                      : '';
            reject(
                new DockerPreflightError(
                    'DOCKER_CHECK_FAILED',
                    `Docker-compatible CLI check failed.${code} Output suppressed; check the container CLI in the same launch environment.`,
                ),
            );
        };
        try {
            execFile(
                command,
                [...prefix, ...args],
                {
                    timeout: 2_000,
                    killSignal: 'SIGKILL',
                    maxBuffer: 1024 * 1024,
                    encoding: 'utf8',
                },
                (error, stdout) => {
                    if (error) fail(error);
                    else resolve(stdout.trim());
                },
            );
        } catch (error) {
            // Some OS spawn failures throw synchronously (for example EPERM).
            // Classify only known process failures, not programming errors.
            if (
                error instanceof Error &&
                'code' in error &&
                typeof error.code === 'string' &&
                processErrorCodes.includes(error.code)
            )
                fail(error as ExecFileException);
            else reject(error);
        }
    });
}

/** Docker Desktop's local named pipes are valid; remote named pipes are not. */
async function assertLocalDockerDaemon(
    command: string,
    prefix: readonly string[],
): Promise<void> {
    // Match Docker CLI precedence: an explicit context overrides DOCKER_HOST.
    const endpoint =
        !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
            ? process.env.DOCKER_HOST
            : await dockerOutput(command, prefix, [
                  'context',
                  'inspect',
                  '--format',
                  '{{.Endpoints.docker.Host}}',
              ]);
    const normalizedEndpoint = endpoint.replace(/\\/g, '/');
    const localUnix =
        endpoint.startsWith('unix:///') && endpoint === normalizedEndpoint;
    const localPipe =
        normalizedEndpoint.startsWith('npipe:////./pipe/') &&
        !normalizedEndpoint.slice('npipe:////./pipe/'.length).includes('/') &&
        normalizedEndpoint.length > 'npipe:////./pipe/'.length;
    if (!localUnix && !localPipe) {
        throw new DockerPreflightError(
            'DOCKER_LOCAL_DAEMON_REQUIRED',
            'Docker extensions require a verified local daemon; remote/TCP/SSH endpoints are unsupported.',
        );
    }
}

async function assertLinuxDockerDaemon(
    command: string,
    prefix: readonly string[],
): Promise<void> {
    // Both Docker and Podman's Docker-compatible CLI support JSON templates.
    // Query the same selected CLI/connection once; never switch engines after
    // a permission, connection or command failure.
    const output = await dockerOutput(command, prefix, [
        'info',
        '--format',
        '{{json .}}',
    ]);
    let info: unknown;
    try {
        info = JSON.parse(output);
    } catch {
        throw new DockerPreflightError(
            'DOCKER_INFO_INVALID',
            'Docker-compatible CLI returned invalid info JSON.',
        );
    }
    let osType: unknown;
    if (info && typeof info === 'object' && !Array.isArray(info)) {
        if ('OSType' in info) {
            osType = info.OSType;
        } else if (
            'host' in info &&
            info.host &&
            typeof info.host === 'object' &&
            !Array.isArray(info.host) &&
            'os' in info.host
        ) {
            osType = info.host.os;
        }
    }
    if (typeof osType !== 'string' || !osType) {
        throw new DockerPreflightError(
            'DOCKER_INFO_INVALID',
            'Docker-compatible CLI info must contain Docker OSType or Podman host.os.',
        );
    }
    if (osType !== 'linux') {
        throw new DockerPreflightError(
            'DOCKER_UNSUPPORTED_PLATFORM',
            'Docker extensions require Linux containers.',
        );
    }
}

/** Validate requested permissions before reducing optional capabilities. */
export async function preflightDockerExtensions(
    requested: readonly ExtensionFeature[],
    transport: string,
    additionalArgs: readonly string[],
): Promise<ExtensionFeature[]> {
    validateAdditionalDockerArgs(additionalArgs);
    if (!requested.length) return [];

    try {
        // Keep daemon/mount prerequisites. Stdio data uses the control pipe and
        // needs no loopback publication or particular container network mode.
        if (transport === 'stdio' || transport === 'http') {
            await assertLocalDockerDaemon('docker', []);
        }
        await assertLinuxDockerDaemon('docker', []);
    } catch (error) {
        if (!(error instanceof DockerPreflightError)) throw error;
        if (requested.includes('terminal')) {
            throw new TerminalStartupError(
                error.reason,
                `${terminalStartupError(error.reason).message} ${error.message}`,
            );
        }
        console.error(
            `[staff-mcp] Disabling requested Docker extensions (${requested.join(',')}): reason=${error.reason} ${error.message} Basic MCP tools/control remain enabled.`,
        );
        return [];
    }
    return [...requested];
}

/**
 * Run the Docker-compatible CLI and keep its lifecycle tied to this process.
 *
 * For stdio transport, the caller's stdin remains the MCP data channel. For
 * HTTP/reverse transports, child.stdin is intentionally kept open as a private
 * lifecycle pipe instead of being connected to process.stdin. This allows the
 * service to run under PM2/systemd/Supervisor even when fd 0 is /dev/null, while
 * still making the container exit if the host proxy disappears unexpectedly.
 */
export async function runDockerProxy(
    dockerArgs: readonly string[],
    transport: string,
    options: DockerProxyOptions = {},
): Promise<number> {
    const command = options.command ?? 'docker';
    const commandPrefixArgs = [...(options.commandPrefixArgs ?? [])];
    const input = options.input ?? process.stdin;
    const signalSource = options.signalSource ?? process;
    const gracefulShutdownTimeoutMs =
        options.gracefulShutdownTimeoutMs ??
        DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    const containerIdWaitTimeoutMs =
        options.containerIdWaitTimeoutMs ??
        DEFAULT_CONTAINER_ID_WAIT_TIMEOUT_MS;
    const containerCleanupTimeoutMs =
        options.containerCleanupTimeoutMs ??
        DEFAULT_CONTAINER_CLEANUP_TIMEOUT_MS;
    const forceKillTimeoutMs =
        options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;

    let containerIdentity: ContainerIdentityConfig;
    try {
        containerIdentity = prepareContainerIdentity(
            dockerArgs,
            options.nameHint,
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[staff-mcp] Failed to prepare Docker proxy: ${message}`);
        return 1;
    }

    return new Promise<number>((resolve) => {
        let child: ChildProcess | undefined;
        let cleanupChild: ChildProcess | undefined;
        let runExit: ChildExit | undefined;
        let trackedContainerId: string | undefined;
        let settled = false;
        let shutdownStarted = false;
        let shutdownActivated = false;
        let cleanupInProgress = false;
        let cleanupAttempted = false;
        let containerCleanupConfirmed = false;
        let cleanupFailed = false;
        let escalationPromise: Promise<void> | undefined;
        let gracefulTimer: NodeJS.Timeout | undefined;
        let postCleanupTimer: NodeJS.Timeout | undefined;
        let postCleanupFinalTimer: NodeJS.Timeout | undefined;
        let cidPollTimer: NodeJS.Timeout | undefined;
        let parentWatch: NodeJS.Timeout | undefined;

        const signalHandlers = new Map<NodeJS.Signals, () => void>();

        const captureContainerId = (): string | undefined => {
            if (!trackedContainerId) {
                trackedContainerId = readContainerId(
                    containerIdentity.cidFilePath,
                );
            }
            return trackedContainerId;
        };

        const isChildRunning = () =>
            child !== undefined &&
            child.exitCode === null &&
            child.signalCode === null;

        const removeListeners = () => {
            for (const [signal, handler] of signalHandlers) {
                signalSource.removeListener(signal, handler);
            }
            signalHandlers.clear();

            if (transport === 'stdio') {
                if (child?.stdin) input.unpipe(child.stdin);
                input.removeListener('end', handleInputEnd);
                input.removeListener('error', handleInputError);
            }
            if (transport === 'stdio') {
                process.stdout.removeListener('error', handleOutputError);
                process.stderr.removeListener('error', handleOutputError);
            }
        };

        const finish = (exitCode: number) => {
            if (settled) {
                return;
            }
            settled = true;

            if (gracefulTimer) {
                clearTimeout(gracefulTimer);
            }
            if (postCleanupTimer) {
                clearTimeout(postCleanupTimer);
            }
            if (postCleanupFinalTimer) {
                clearTimeout(postCleanupFinalTimer);
            }
            if (cidPollTimer) {
                clearInterval(cidPollTimer);
            }

            if (parentWatch) clearInterval(parentWatch);
            removeListeners();

            try {
                fs.rmSync(containerIdentity.ownedDirectory, {
                    recursive: true,
                    force: true,
                });
            } catch (error) {
                console.error(
                    `[staff-mcp] Failed to remove temporary cidfile directory '${containerIdentity.ownedDirectory}':`,
                    error,
                );
            }

            resolve(exitCode);
        };

        const maybeFinish = () => {
            if (!runExit || cleanupInProgress) {
                return;
            }
            finish(
                cleanupFailed
                    ? 1
                    : (runExit.code ?? exitCodeFromSignal(runExit.signal)),
            );
        };

        const closeLifecyclePipe = () => {
            if (!child?.stdin) {
                return;
            }

            if (transport === 'stdio') {
                input.unpipe(child.stdin);
            }

            if (!child.stdin.destroyed && !child.stdin.writableEnded) {
                child.stdin.end();
            }
        };

        const waitForContainerId = async (): Promise<string | undefined> => {
            const deadline = Date.now() + containerIdWaitTimeoutMs;
            let containerId = captureContainerId();
            while (!containerId && isChildRunning() && Date.now() < deadline) {
                await delay(
                    Math.min(
                        CONTAINER_ID_POLL_INTERVAL_MS,
                        Math.max(1, deadline - Date.now()),
                    ),
                );
                containerId = captureContainerId();
            }
            return containerId;
        };

        const forceRemoveContainer = (containerId: string): Promise<boolean> =>
            new Promise<boolean>((resolveCleanup) => {
                let completed = false;
                let cleanupSpawned = false;
                let cleanupTimer: NodeJS.Timeout | undefined;
                let cleanupForceTimer: NodeJS.Timeout | undefined;
                let cleanupFinalTimer: NodeJS.Timeout | undefined;
                let stderr = '';

                const complete = (success: boolean) => {
                    if (completed) {
                        return;
                    }
                    completed = true;
                    if (cleanupTimer) {
                        clearTimeout(cleanupTimer);
                    }
                    if (cleanupForceTimer) {
                        clearTimeout(cleanupForceTimer);
                    }
                    if (cleanupFinalTimer) {
                        clearTimeout(cleanupFinalTimer);
                    }
                    cleanupChild = undefined;
                    resolveCleanup(success);
                };

                try {
                    cleanupChild = spawn(
                        command,
                        [...commandPrefixArgs, 'rm', '-f', containerId],
                        {
                            stdio: ['ignore', 'ignore', 'pipe'],
                        },
                    );
                } catch (error) {
                    console.error(
                        `[staff-mcp] Failed to start fallback container cleanup for ${containerId}:`,
                        error,
                    );
                    complete(false);
                    return;
                }

                cleanupChild.once('spawn', () => {
                    cleanupSpawned = true;
                });

                cleanupChild.stderr?.on('data', (chunk: Buffer) => {
                    if (stderr.length < 8_192) {
                        stderr += chunk.toString();
                    }
                });

                cleanupChild.once('error', (error) => {
                    console.error(
                        `[staff-mcp] Failed to run fallback container cleanup for ${containerId}: ${error.message}`,
                    );
                    if (!cleanupSpawned && cleanupChild?.pid === undefined) {
                        complete(false);
                    }
                });

                cleanupChild.once('close', (code, signal) => {
                    if (completed) {
                        return;
                    }

                    const detail = stderr.trim();
                    if (code === 0 || isMissingContainerError(detail)) {
                        console.error(
                            `[staff-mcp] Fallback container cleanup completed for ${containerId}.`,
                        );
                        complete(true);
                        return;
                    }

                    console.error(
                        `[staff-mcp] Fallback container cleanup failed for ${containerId}: code ${code ?? 'null'}` +
                            `${signal ? `, signal ${signal}` : ''}${detail ? `, ${detail}` : ''}`,
                    );
                    complete(false);
                });

                cleanupTimer = setTimeout(() => {
                    console.error(
                        `[staff-mcp] Fallback container cleanup for ${containerId} exceeded ${containerCleanupTimeoutMs}ms; sending SIGTERM.`,
                    );
                    cleanupChild?.kill('SIGTERM');
                    cleanupForceTimer = setTimeout(() => {
                        if (!completed) {
                            console.error(
                                `[staff-mcp] Fallback container cleanup for ${containerId} did not stop within an additional ${forceKillTimeoutMs}ms; sending SIGKILL.`,
                            );
                            cleanupChild?.kill('SIGKILL');
                            cleanupFinalTimer = setTimeout(() => {
                                if (!completed) {
                                    console.error(
                                        `[staff-mcp] Fallback container cleanup for ${containerId} did not report completion after SIGKILL.`,
                                    );
                                    complete(false);
                                }
                            }, forceKillTimeoutMs);
                        }
                    }, forceKillTimeoutMs);
                }, containerCleanupTimeoutMs);
            });

        const scheduleRunCliTermination = () => {
            if (!isChildRunning() || postCleanupTimer) {
                return;
            }

            child!.kill('SIGTERM');
            postCleanupTimer = setTimeout(() => {
                if (!isChildRunning()) {
                    return;
                }
                console.error(
                    `[staff-mcp] Docker CLI did not exit within ${forceKillTimeoutMs}ms; sending SIGKILL.`,
                );
                child!.kill('SIGKILL');
                postCleanupFinalTimer = setTimeout(() => {
                    if (!runExit && isChildRunning()) {
                        console.error(
                            '[staff-mcp] Docker CLI did not report completion after SIGKILL.',
                        );
                        cleanupFailed = true;
                        runExit = { code: 1, signal: null };
                        maybeFinish();
                    }
                }, forceKillTimeoutMs);
            }, forceKillTimeoutMs);
        };

        const escalateShutdown = (): Promise<void> => {
            if (escalationPromise) {
                return escalationPromise;
            }

            escalationPromise = (async () => {
                if (gracefulTimer) {
                    clearTimeout(gracefulTimer);
                    gracefulTimer = undefined;
                }

                if (!isChildRunning()) {
                    return;
                }

                if (containerCleanupConfirmed || cleanupAttempted) {
                    scheduleRunCliTermination();
                    return;
                }

                const containerId = await waitForContainerId();
                if (!isChildRunning()) {
                    return;
                }

                if (!containerId) {
                    // Do not treat "no such container" as successful cleanup while the
                    // Docker CLI may still be pulling an image or creating the container.
                    // Stop the CLI first; its close handler will then remove the unique
                    // generated name after no further create request can be issued.
                    console.error(
                        `[staff-mcp] Docker cidfile was unavailable; terminating the CLI before cleaning up '${containerIdentity.containerName}'.`,
                    );
                    scheduleRunCliTermination();
                    return;
                }

                cleanupInProgress = true;
                cleanupAttempted = true;
                const removed = await forceRemoveContainer(containerId);
                cleanupInProgress = false;

                if (removed) {
                    containerCleanupConfirmed = true;
                    cleanupFailed = false;
                    // Once the exact tracked container has been removed, it is safe to
                    // terminate a stuck CLI.
                } else {
                    cleanupFailed = true;
                    console.error(
                        `[staff-mcp] Container ${containerId} could not be confirmed removed; terminating the stuck Docker CLI with an error status.`,
                    );
                }

                scheduleRunCliTermination();
                maybeFinish();
            })().finally(() => {
                escalationPromise = undefined;
            });

            return escalationPromise;
        };

        const activateShutdown = () => {
            if (!shutdownStarted || shutdownActivated || !child) {
                return;
            }
            shutdownActivated = true;
            closeLifecyclePipe();

            gracefulTimer = setTimeout(() => {
                if (!isChildRunning()) {
                    return;
                }
                console.error(
                    `[staff-mcp] Docker proxy did not exit within ${gracefulShutdownTimeoutMs}ms; removing its tracked container.`,
                );
                void escalateShutdown();
            }, gracefulShutdownTimeoutMs);
        };

        const requestShutdown = (reason: string, repeatedSignal = false) => {
            if (settled) {
                return;
            }

            if (!shutdownStarted) {
                shutdownStarted = true;
                console.error(
                    `[staff-mcp] Docker proxy shutdown requested: ${reason}`,
                );
                activateShutdown();
                return;
            }

            if (repeatedSignal) {
                console.error(
                    `[staff-mcp] Repeated shutdown signal received: ${reason}`,
                );
                void escalateShutdown();
            }
        };

        function handleInputEnd() {
            requestShutdown('stdio input closed');
        }

        function handleInputError(error: Error) {
            console.error(
                `[staff-mcp] Docker proxy input error: ${error.message}`,
            );
            requestShutdown('stdio input error');
        }

        function handleOutputError() {
            requestShutdown('parent output pipe closed');
        }

        if (transport === 'stdio') {
            input.once('end', handleInputEnd);
            input.once('error', handleInputError);
            if ('readableEnded' in input && input.readableEnded)
                handleInputEnd();
        }

        for (const signal of HANDLED_SIGNALS) {
            const handler = () => requestShutdown(`received ${signal}`, true);
            signalHandlers.set(signal, handler);
            signalSource.on(signal, handler);
        }

        const start = () => {
            if (settled || shutdownStarted) {
                finish(0);
                return;
            }

            try {
                child = spawn(
                    command,
                    [...commandPrefixArgs, ...containerIdentity.args],
                    {
                        stdio: ['pipe', 'inherit', 'inherit'],
                    },
                );
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                console.error(
                    `[staff-mcp] Failed to start docker proxy: ${message}`,
                );
                finish(1);
                return;
            }

            if (!child.stdin) {
                console.error(
                    '[staff-mcp] Failed to start docker proxy: child stdin is unavailable.',
                );
                child.kill('SIGKILL');
                finish(1);
                return;
            }

            child.stdin.on('error', (error: NodeJS.ErrnoException) => {
                if (!settled && error.code !== 'EPIPE') {
                    console.error(
                        `[staff-mcp] Docker proxy stdin error: ${error.message}`,
                    );
                }
            });

            child.once('error', (error) => {
                if (settled) {
                    return;
                }

                if (child?.pid === undefined) {
                    console.error(
                        `[staff-mcp] Failed to start docker proxy: ${error.message}`,
                    );
                    finish(1);
                    return;
                }

                console.error(
                    `[staff-mcp] Docker proxy process error: ${error.message}`,
                );
                cleanupFailed = true;
                requestShutdown('Docker proxy process error', true);
            });

            child.once('close', (code, signal) => {
                if (settled) {
                    return;
                }

                captureContainerId();
                runExit = { code, signal };
                if (gracefulTimer) {
                    clearTimeout(gracefulTimer);
                }
                if (postCleanupTimer) {
                    clearTimeout(postCleanupTimer);
                }
                if (postCleanupFinalTimer) {
                    clearTimeout(postCleanupFinalTimer);
                }

                console.error(
                    `[staff-mcp] Docker proxy exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}.`,
                );

                // If a supervisor killed the Docker CLI directly, --rm may not have
                // completed. Clean up by exact ID when available, otherwise use the
                // unique generated name that was part of the container-create request.
                if (
                    !cleanupInProgress &&
                    !cleanupAttempted &&
                    !containerCleanupConfirmed &&
                    (signal !== null || code !== 0)
                ) {
                    const cleanupReference =
                        trackedContainerId ?? containerIdentity.containerName;
                    cleanupInProgress = true;
                    cleanupAttempted = true;
                    void forceRemoveContainer(cleanupReference)
                        .then((removed) => {
                            containerCleanupConfirmed = removed;
                            cleanupFailed = !removed;
                        })
                        .finally(() => {
                            cleanupInProgress = false;
                            maybeFinish();
                        });
                    return;
                }

                maybeFinish();
            });

            cidPollTimer = setInterval(
                captureContainerId,
                CONTAINER_ID_POLL_INTERVAL_MS,
            );
            cidPollTimer.unref();

            if (transport === 'stdio') {
                input.pipe(child.stdin);
            }

            // A signal source can synchronously request shutdown while handlers are
            // being installed (and a real OS signal can arrive during startup).
            activateShutdown();
        };

        if (transport === 'stdio') {
            process.stdout.on('error', handleOutputError);
            process.stderr.on('error', handleOutputError);
            const parentPid = process.ppid;
            parentWatch = setInterval(() => {
                let parentAlive = process.ppid === parentPid;
                try {
                    process.kill(parentPid, 0);
                } catch {
                    parentAlive = false;
                }
                if (!parentAlive) requestShutdown('parent exited');
            }, 200);
            parentWatch.unref();
        }

        start();
    });
}
