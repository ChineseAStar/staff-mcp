import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extensionError } from './extensions/protocol.js';

export const DOCKER_DATA_PORT = 39173;
export const DOCKER_DATA_BOOTSTRAP = '/run/staff-mcp-data.json';
export const DOCKER_DATA_STARTUP_TIMEOUT_MS = 15_000;

/** Docker output/argv can contain credentials. Never include either in errors. */
async function dockerOutput(
    command: string,
    prefix: readonly string[],
    args: string[],
    signal?: AbortSignal,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const fail = () =>
            reject(
                new Error(
                    'Docker data bootstrap command failed (details suppressed).',
                ),
            );
        if (signal?.aborted) {
            fail();
            return;
        }
        const child = execFile(
            command,
            [...prefix, ...args],
            {
                timeout: 2_000,
                killSignal: 'SIGKILL',
                maxBuffer: 1024 * 1024,
                encoding: 'utf8',
            },
            (error, stdout) => {
                signal?.removeEventListener('abort', abort);
                if (error) fail();
                else resolve(stdout.trim());
            },
        );
        // Node's execFile AbortSignal path uses SIGTERM even with killSignal set.
        // Kill explicitly and await its callback so no helper survives proxy exit.
        const abort = () => {
            child.kill('SIGKILL');
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
    });
}

export async function assertLocalDockerDaemon(
    command: string,
    prefix: readonly string[],
    signal?: AbortSignal,
): Promise<void> {
    const endpoint =
        !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
            ? process.env.DOCKER_HOST
            : await dockerOutput(
                  command,
                  prefix,
                  [
                      'context',
                      'inspect',
                      '--format',
                      '{{.Endpoints.docker.Host}}',
                  ],
                  signal,
              );
    if (!endpoint.startsWith('unix://') && !endpoint.startsWith('npipe://')) {
        throw new Error(
            'Docker data auto requires a local Docker daemon; remote/TCP/SSH contexts are not supported.',
        );
    }
}

/** File mount keeps the inode stable: the container may already have it open. */
export function prepareDockerDataArgs(
    args: string[],
    ownedDirectory: string,
): string {
    const metadataPath = path.join(ownedDirectory, 'data-bootstrap.json');
    fs.writeFileSync(metadataPath, '{}', { flag: 'wx', mode: 0o600 });
    const source =
        process.platform === 'win32'
            ? metadataPath
                  .replace(
                      /^([a-zA-Z]):/,
                      (_, drive: string) => `/${drive.toLowerCase()}`,
                  )
                  .replace(/\\/g, '/')
            : metadataPath;
    args.splice(
        args.indexOf('run') + 1,
        0,
        '--publish',
        `127.0.0.1::${DOCKER_DATA_PORT}/tcp`,
        '--mount',
        `type=bind,src=${source},dst=${DOCKER_DATA_BOOTSTRAP},readonly`,
        '--env',
        `STAFF_MCP_DATA_BOOTSTRAP=${DOCKER_DATA_BOOTSTRAP}`,
        '--env',
        'STAFF_MCP_DATA_HOST=0.0.0.0',
        '--env',
        `STAFF_MCP_DATA_PORT=${DOCKER_DATA_PORT}`,
    );
    return metadataPath;
}

/** Never rename the metadata: Docker bind-mounts this exact inode. */
function writeDockerDataMetadata(metadataPath: string, metadata: object): void {
    const fd = fs.openSync(metadataPath, 'r+');
    try {
        fs.ftruncateSync(fd, 0);
        fs.writeFileSync(fd, JSON.stringify(metadata));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

export function failDockerDataBootstrap(metadataPath: string): void {
    writeDockerDataMetadata(metadataPath, { error: 'CAPABILITY_UNAVAILABLE' });
}

export async function publishDockerDataBaseUrl(
    command: string,
    prefix: readonly string[],
    containerId: string,
    metadataPath: string,
    cancelled: () => boolean,
    signal?: AbortSignal,
): Promise<boolean> {
    const result = await dockerOutput(
        command,
        prefix,
        ['inspect', '--format', '{{json .}}', containerId],
        signal,
    );
    if (cancelled()) return false;
    let info;
    try {
        info = JSON.parse(result);
    } catch {
        throw new Error('Invalid Docker data bootstrap inspect response.');
    }
    if (info.Id !== containerId)
        throw new Error('Docker data bootstrap container identity mismatch.');
    const bindings = info.NetworkSettings?.Ports?.[`${DOCKER_DATA_PORT}/tcp`];
    if (!info.State?.Running || !bindings?.length) return false;
    const port = Number(bindings[0].HostPort);
    if (
        info.HostConfig?.NetworkMode === 'host' ||
        bindings.length !== 1 ||
        bindings[0].HostIp !== '127.0.0.1' ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    )
        throw new Error(
            'Docker data auto requires exactly one private loopback port binding, without host networking.',
        );
    writeDockerDataMetadata(metadataPath, {
        baseUrl: `http://127.0.0.1:${port}`,
    });
    return true;
}

/** Used by the stdio listener owner before advertising its reachable endpoint. */
export async function readDockerDataBaseUrl(): Promise<string | undefined> {
    const metadataPath = process.env.STAFF_MCP_DATA_BOOTSTRAP;
    if (!metadataPath) return undefined;
    const deadline = Date.now() + DOCKER_DATA_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        let metadata;
        try {
            metadata = JSON.parse(
                await fs.promises.readFile(metadataPath, 'utf8'),
            );
        } catch (error) {
            if (
                !(error instanceof SyntaxError) &&
                (error as NodeJS.ErrnoException).code !== 'ENOENT'
            ) {
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Cannot read Docker data bootstrap metadata.',
                );
            }
        }
        if (metadata?.error !== undefined)
            extensionError(
                'CAPABILITY_UNAVAILABLE',
                'Docker data bootstrap is unavailable.',
            );
        if (metadata?.baseUrl !== undefined) {
            if (
                typeof metadata.baseUrl !== 'string' ||
                !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(metadata.baseUrl)
            ) {
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Invalid Docker data bootstrap baseUrl.',
                );
            }
            const port = Number(
                metadata.baseUrl.slice(metadata.baseUrl.lastIndexOf(':') + 1),
            );
            if (port < 1 || port > 65535)
                extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Invalid Docker data bootstrap port.',
                );
            return metadata.baseUrl;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return extensionError(
        'CAPABILITY_UNAVAILABLE',
        'Docker data bootstrap timed out waiting for private port mapping.',
    );
}
