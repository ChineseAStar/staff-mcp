#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import * as path from 'path';
import * as os from 'os';
import { mkdirSync } from 'node:fs';
import { createServerFactory } from './server.js';
import {
    buildDockerNameHint,
    runDockerProxy,
    preflightDockerExtensions,
} from './docker-proxy.js';
import { STAFF_MCP_PACKAGE_ROOT, STAFF_MCP_VERSION } from './package-info.js';
import {
    redirectStdioLogsToStderr,
    startStdioServer,
} from './transports/stdio.js';
import { getHttpAuthToken, startHttpServer } from './transports/http.js';
import { startReverseServer } from './transports/reverse.js';
import {
    ensureStaffDirs,
    STAFF_TOOLS_DIR,
    STAFF_SKILLS_DIR,
    STAFF_PROFILES_DIR,
} from './utils/paths.js';
import { ensureRipgrep } from './utils/tool-utils.js';
import { configureGlobalProxy } from './utils/proxy.js';
import {
    dockerPrivatePaths,
    parseExtensions,
    resolveExtensionOptions,
} from './extensions/config.js';

// Global error handlers to prevent the MCP server from crashing due to unhandled child process errors
process.on('uncaughtException', (err: any) => {
    if (
        err.code === 'ENOENT' &&
        err.syscall &&
        err.syscall.startsWith('spawn')
    ) {
        console.error(
            `[staff-mcp] Captured unhandled spawn error: ${err.message}. A background tool failed to start.`,
        );
    } else {
        console.error('[staff-mcp] Uncaught Exception:', err);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(
        '[staff-mcp] Unhandled Rejection at:',
        promise,
        'reason:',
        reason,
    );
});

function milliseconds(value: string, minimum = 1): number {
    const parsed = Number(value);
    if (
        !Number.isInteger(parsed) ||
        parsed < minimum ||
        parsed > 2_147_483_647
    ) {
        throw new InvalidArgumentError(
            `Expected milliseconds between ${minimum} and 2147483647.`,
        );
    }
    return parsed;
}

/** CLI owns process exit; transports own and await their session resources. */
async function runHostService(
    start: () => Promise<{ stop(): Promise<void>; closed?: Promise<void> }>,
    watchHostPipe: boolean,
) {
    const starting = start();
    let stopping = false;
    const shutdown = async (code: number) => {
        if (stopping) return;
        stopping = true;
        try {
            const service = await starting;
            await service.stop();
        } catch {
            console.error('[staff-mcp] Startup or shutdown cleanup failed.');
            code = 1;
        }
        process.exit(code);
    };
    const stop = () => void shutdown(0);
    const failed = () => void shutdown(1);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    if (watchHostPipe) {
        process.stdin.once('end', stop);
        process.stdin.once('close', stop);
        process.stdin.once('error', failed);
        process.stdin.resume();
    }
    try {
        const service = await starting;
        void service.closed?.then(stop, failed);
        if (
            watchHostPipe &&
            (process.stdin.readableEnded || process.stdin.destroyed)
        )
            stop();
    } catch (error) {
        console.error('[staff-mcp] Transport startup failed:', error);
        await shutdown(1);
    }
}

const program = new Command();

program
    .name('staff-mcp')
    .description('MCP Server with file, shell, and LSP capabilities.')
    .version(STAFF_MCP_VERSION)
    .option(
        '-t, --transport <type>',
        'Transport type (stdio, http, reverse)',
        'stdio',
    )
    .option('-p, --port <number>', 'Port for HTTP server', '3000')
    .option('-h, --host <address>', 'Host for HTTP server', '127.0.0.1')
    .option(
        '--ht, --http-token <token>',
        'Optional bearer token for HTTP transport',
    )
    .option(
        '--ru, --reverse-url <url>',
        'HTTP(S) Web reverse endpoint (e.g. https://web.example/api/mcp/reverse)',
    )
    .option('--rt, --reverse-token <token>', 'Security token for Reverse MCP')
    .option('--rn, --reverse-name <name>', 'Server name for Reverse MCP')
    .option(
        '--reverse-connect-timeout <ms>',
        'SSE connection timeout (0 disables it)',
        (value) => milliseconds(value, 0),
        15000,
    )
    .option(
        '--reverse-initialization-timeout <ms>',
        'MCP initialization timeout after reverse pairing',
        (value) => milliseconds(value),
        15000,
    )
    .option(
        '--reverse-read-timeout <ms>',
        'SSE heartbeat read timeout, independent of tool duration',
        (value) => milliseconds(value),
        45000,
    )
    .option(
        '--reverse-stable-time <ms>',
        'Connection lifetime required to reset reconnect backoff',
        (value) => milliseconds(value, 0),
        30000,
    )
    .option(
        '-w, --working-dir <path>',
        'Working directory for the server (defaults to current execution path)',
        process.cwd(),
    )
    .option(
        '-d, --allowed-dir <paths...>',
        'Additional directories allowed for sandbox',
        [],
    )
    .option(
        '-r, --profile <name>',
        'The active profile for skills and instructions (e.g., android-reverse, default)',
        'default',
    )
    .option(
        '-m, --max-mcp-sessions <number>',
        'Maximum number of concurrent MCP sessions allowed',
        '5',
    )
    .option(
        '--enable-lsp',
        'Enable LSP capabilities (disabled by default)',
        false,
    )
    .option(
        '--extensions <features>',
        'Enable files and/or terminal (comma-separated; all disabled by default)',
        (value: string) => {
            try {
                return parseExtensions(value);
            } catch (error) {
                throw new InvalidArgumentError((error as Error).message);
            }
        },
    )
    .addOption(
        new Option('--internal-file-private-path <path>')
            .hideHelp()
            .argParser((value: string, previous: string[] = []) => {
                if (!path.posix.isAbsolute(value) || value.includes('\0'))
                    throw new InvalidArgumentError(
                        'Private path must be absolute',
                    );
                return [...previous, value];
            }),
    )
    .option(
        '--docker <image>',
        'Run the MCP server inside a Docker container using the specified image',
    )
    .option(
        '-D, --docker-args <args...>',
        'Additional arguments to pass to the docker run command (e.g., -e ADB_SERVER_SOCKET=...)',
    )
    .option(
        '--proxy <url>',
        'HTTP(S) proxy for outbound requests (e.g. http://127.0.0.1:8080); defaults to honoring HTTP_PROXY/HTTPS_PROXY/NO_PROXY env vars',
    )
    .action(async (options, command) => {
        if (options.transport === 'stdio') {
            redirectStdioLogsToStderr();
        }
        let extensions: ReturnType<typeof resolveExtensionOptions>;
        try {
            extensions = resolveExtensionOptions({
                enabled: options.extensions,
            });
        } catch (error) {
            command.error((error as Error).message);
            return;
        }
        if (options.transport === 'http') {
            try {
                getHttpAuthToken(options.httpToken);
            } catch (error) {
                console.error(
                    `[staff-mcp] ${error instanceof Error ? error.message : String(error)}`,
                );
                process.exit(1);
            }
        }

        // Install a proxy-aware global fetch dispatcher before anything can
        // issue an outbound request. In --docker mode this also runs inside the
        // container, where the same entry point is re-executed.
        configureGlobalProxy(options.proxy);
        // -------------------------------------------------------------
        // Docker Transparent Proxy Mode
        // -------------------------------------------------------------
        if (options.docker) {
            const additionalDockerArgs: string[] = [];
            for (const arg of options.dockerArgs ?? []) {
                // Preserve backslashes in Windows bind paths; only unwrap quotes.
                const parts = (arg as string).match(
                    /(?:[^\s"']+|"[^"]*"|'[^']*')+/g,
                ) || [arg];
                for (const part of parts) {
                    additionalDockerArgs.push(part.replace(/^['"]|['"]$/g, ''));
                }
            }
            try {
                extensions = {
                    ...extensions,
                    enabled: await preflightDockerExtensions(
                        extensions.enabled,
                        options.transport,
                        additionalDockerArgs,
                    ),
                };
            } catch (error) {
                command.error((error as Error).message);
                return;
            }
            const dataAuto =
                options.transport === 'stdio' && extensions.enabled.length > 0;

            // 1. Locate the package root (where package.json is)
            const pkgRoot = STAFF_MCP_PACKAGE_ROOT;

            // 2. Cross-platform path normalizer for Volume Mounts
            const toDockerVolumePath = (p: string) => {
                if (os.platform() === 'win32') {
                    return p
                        .replace(
                            /^([a-zA-Z]):/,
                            (_, drive) => `/${drive.toLowerCase()}`,
                        )
                        .replace(/\\/g, '/');
                }
                return p;
            };

            const hostCwd = path.resolve(options.workingDir);
            const dockerArgs = ['run', '-i', '--rm'];
            const binds: { source: string; target: string }[] = [];
            const bind = (source: string, target: string, readOnly = false) => {
                binds.push({ source, target });
                dockerArgs.push(
                    '-v',
                    `${toDockerVolumePath(source)}:${target}${readOnly ? ':ro' : ''}`,
                );
            };

            // 3. Mount working directory and package source
            bind(hostCwd, '/workspace');
            dockerArgs.push('-w', '/workspace');
            bind(pkgRoot, '/opt/staff-mcp', true);

            // 3.5 Check if we are nested inside a node_modules folder (npx/pnpm global scenario)
            // If yes, map the parent node_modules into the container as well so dependencies can be resolved
            const isNestedInNodeModules = pkgRoot.includes('node_modules');
            if (isNestedInNodeModules) {
                // By mapping the parent directory of staff-mcp's pkgRoot to /opt/node_modules,
                // Node.js inside the container can look up and find shared dependencies.
                const outerNodeModules = path.resolve(pkgRoot, '..');
                bind(outerNodeModules, '/opt/node_modules', true);
            }

            // 3.8 Keep Docker-installed tools separate from host-native binaries.
            // Keep the existing container identity and host permissions unchanged.
            const dockerToolsDir = path.join(STAFF_TOOLS_DIR, 'docker');
            try {
                // Create as the host caller, never let Docker create root-owned dirs.
                ensureStaffDirs();
                mkdirSync(dockerToolsDir, { recursive: true });
            } catch {
                command.error(
                    'Cannot prepare Docker user directories/tools cache.',
                );
                return;
            }

            // Fixed paths do not assume the image's user or HOME directory.
            const containerStaffDir = '/opt/.staff';
            dockerArgs.push('-e', `STAFF_GLOBAL_DIR=${containerStaffDir}`);
            bind(dockerToolsDir, `${containerStaffDir}/tools`);
            bind(STAFF_SKILLS_DIR, `${containerStaffDir}/skills`);
            bind(STAFF_PROFILES_DIR, `${containerStaffDir}/profiles`);

            // 4. Reuse allowed-directory mounts for both tools and files. Docker
            // forbids mounting onto container /, so a host filesystem root gets
            // a dedicated target; ordinary directories keep their existing paths.
            const allowedMounts = options.allowedDir.map(
                (dir: string, index: number) => {
                    const source = path.resolve(dir);
                    const target =
                        source === path.parse(source).root
                            ? `/opt/staff-allowed/root-${index}`
                            : source;
                    return { source, target };
                },
            );
            for (const mount of allowedMounts) bind(mount.source, mount.target);

            // 5. Handle HTTP port forwarding
            if (options.transport === 'http') {
                dockerArgs.push('-p', `${options.port}:${options.port}`);
            }

            // 6. Inject the already validated custom Docker options.
            dockerArgs.push(...additionalDockerArgs);

            // Only wrapper-owned mounts are known here, not arbitrary -D mounts.
            // A bind of a staging descendant is protected in its entirety.
            const privateAliases = dockerPrivatePaths(hostCwd, binds);

            // 7. Inject environment variable to detect docker proxy mode
            dockerArgs.push('-e', 'STAFF_MCP_IS_DOCKER=1');

            // 8. Specify the target image
            dockerArgs.push(options.docker);

            // 9. Reconstruct the command inside the container
            dockerArgs.push('node', '/opt/staff-mcp/dist/src/index.js');
            dockerArgs.push('-t', options.transport);

            if (options.transport === 'reverse') {
                if (options.reverseUrl)
                    dockerArgs.push('--ru', options.reverseUrl);
                if (options.reverseToken)
                    dockerArgs.push('--rt', options.reverseToken);
                if (options.reverseName)
                    dockerArgs.push('--rn', options.reverseName);
                dockerArgs.push(
                    '--reverse-connect-timeout',
                    String(options.reverseConnectTimeout),
                );
                dockerArgs.push(
                    '--reverse-initialization-timeout',
                    String(options.reverseInitializationTimeout),
                );
                dockerArgs.push(
                    '--reverse-read-timeout',
                    String(options.reverseReadTimeout),
                );
                dockerArgs.push(
                    '--reverse-stable-time',
                    String(options.reverseStableTime),
                );
            } else {
                dockerArgs.push('-p', String(options.port));
                // Inside container, we must listen on all interfaces for HTTP to be exposed
                if (options.transport === 'http') {
                    dockerArgs.push('-h', '0.0.0.0');
                    if (options.httpToken !== undefined) {
                        dockerArgs.push('--http-token', options.httpToken);
                    }
                } else {
                    dockerArgs.push('-h', options.host);
                }
            }

            dockerArgs.push('-w', '/workspace');
            for (const privatePath of new Set([
                ...(options.internalFilePrivatePath ?? []),
                ...privateAliases,
            ])) {
                dockerArgs.push('--internal-file-private-path', privatePath);
            }

            for (const mount of allowedMounts) {
                dockerArgs.push('-d', mount.target);
            }
            dockerArgs.push('-r', options.profile);
            dockerArgs.push('-m', String(options.maxMcpSessions));
            if (options.enableLsp) {
                dockerArgs.push('--enable-lsp');
            }
            if (extensions.enabled.length) {
                dockerArgs.push('--extensions', extensions.enabled.join(','));
            }
            // Forward an explicit --proxy so the containerized process uses it too.
            // (Env-var proxies reach the container through docker's own env injection
            // or user-supplied -D "-e HTTP_PROXY=..." args.)
            if (options.proxy) {
                dockerArgs.push('--proxy', options.proxy);
            }

            // 10. Run Docker with transport-aware stdin and a controlled shutdown lifecycle.
            // Reverse/HTTP keep a private lifecycle pipe open instead of depending on
            // the supervisor's stdin, which may be /dev/null or already closed.
            // The name hint makes containers distinguishable in `docker ps`
            // (e.g. staff-mcp-chat-poc-18000-a1b2c3).
            const exitCode = await runDockerProxy(
                dockerArgs,
                options.transport,
                {
                    dataAuto,
                    nameHint: buildDockerNameHint({
                        workspaceDir: hostCwd,
                        transport: options.transport,
                        port: options.port,
                        reverseName: options.reverseName,
                    }),
                },
            );
            // Supervisors such as PM2 keep an IPC channel open, so setting exitCode is
            // not sufficient to terminate after the Docker child has been reaped.
            // At this point cleanup has completed, making an explicit exit safe.
            process.exit(exitCode);
        }

        // -------------------------------------------------------------
        // Standard Host Mode
        // -------------------------------------------------------------

        ensureStaffDirs();

        // Pre-warm ripgrep: trigger background install if not present, so it's
        // likely ready by the time the first search_workspace call happens.
        ensureRipgrep().catch((err) => {
            console.error(
                '[staff-mcp] Background ripgrep install failed:',
                err.message,
            );
        });

        const workingDir = path.resolve(options.workingDir);
        const allowedDirs = options.allowedDir.map((d: string) =>
            path.resolve(d),
        );
        const profile = options.profile;
        const maxMcpSessions = parseInt(options.maxMcpSessions, 10) || 5;
        const enableLsp = !!options.enableLsp;
        let serverFactory: ReturnType<typeof createServerFactory>;
        try {
            serverFactory = createServerFactory(
                'staff-mcp',
                STAFF_MCP_VERSION,
                workingDir,
                allowedDirs,
                profile,
                maxMcpSessions,
                enableLsp,
                extensions,
                options.internalFilePrivatePath,
            );
        } catch (error) {
            command.error((error as Error).message);
            return;
        }

        if (options.transport === 'http') {
            await runHostService(
                () =>
                    startHttpServer(
                        serverFactory,
                        parseInt(options.port, 10),
                        options.host,
                        options.httpToken,
                    ),
                process.env.STAFF_MCP_IS_DOCKER === '1',
            );
        } else if (options.transport === 'reverse') {
            if (
                !options.reverseUrl ||
                !options.reverseToken ||
                !options.reverseName
            ) {
                console.error(
                    '[staff-mcp] Error: --ru (reverse-url), --rt (reverse-token), and --rn (reverse-name) are required for reverse transport.',
                );
                process.exit(1);
            }
            await runHostService(
                () =>
                    startReverseServer(
                        serverFactory,
                        options.reverseUrl,
                        options.reverseToken,
                        options.reverseName,
                        {
                            proxy: options.proxy,
                            connectTimeout: options.reverseConnectTimeout,
                            initializationTimeout:
                                options.reverseInitializationTimeout,
                            heartbeat: {
                                readTimeout: options.reverseReadTimeout,
                            },
                            reconnect: {
                                stableConnectionMs: options.reverseStableTime,
                            },
                        },
                    ),
                process.env.STAFF_MCP_IS_DOCKER === '1',
            );
        } else {
            await runHostService(
                () => startStdioServer(serverFactory()),
                false,
            );
        }
    });

await program.parseAsync(process.argv);
