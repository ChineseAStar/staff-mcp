import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ReadResourceRequestSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
    FileCore,
    FileError,
    fileError,
    fail,
    mimeType,
    utf8,
    relativePath,
} from './file-core.js';
import { TransferManager, FTE_PREFIX } from './transfers.js';

export const FILE_MANAGER = 'cc.qqxing/file-manager';
export const UI_URI = 'ui://staff-file-manager/v1/index.html';
const RESOURCE_LIMIT = 256 * 1024;
export const FILE_MANAGER_CAPABILITY = {
    version: 1,
    apps: [
        {
            id: 'files',
            title: '文件管理器',
            resourceUri: UI_URI,
            mimeType: 'text/html',
            bridgeVersion: 1,
        },
    ],
};
const pathField = z.string();
const rootPath = { rootId: z.string().default('main'), path: pathField };
const expected = z.string().min(1).optional();
const params = {
    roots: z.object({}).strict(),
    list: z
        .object({
            ...rootPath,
            path: pathField.default(''),
            cursor: z.string().optional(),
            limit: z.number().int().min(1).max(500).default(100),
        })
        .strict(),
    stat: z.object(rootPath).strict(),
    readText: z.object(rootPath).strict(),
    saveText: z
        .object({
            ...rootPath,
            text: z.string(),
            expectedVersion: z.string().min(1),
        })
        .strict(),
    createFile: z
        .object({ ...rootPath, text: z.string().default('') })
        .strict(),
    mkdir: z.object(rootPath).strict(),
    move: z
        .object({
            rootId: z.string(),
            from: pathField,
            to: pathField,
            expectedVersion: expected,
        })
        .strict(),
    delete: z
        .object({
            ...rootPath,
            recursive: z.boolean().default(false),
            expectedVersion: expected,
        })
        .strict(),
    'upload/prepare': z
        .object({
            ...rootPath,
            size: z
                .number()
                .int()
                .min(0)
                .max(100 * 1024 * 1024),
            overwrite: z.boolean().default(false),
            expectedVersion: expected,
        })
        .strict(),
    'upload/commit': z
        .object({ uploadHandle: z.string().min(1), sha256: z.string() })
        .strict(),
    'upload/discard': z.object({ uploadHandle: z.string().min(1) }).strict(),
    'download/prepare': z.object(rootPath).strict(),
    'download/release': z
        .object({ downloadHandle: z.string().min(1) })
        .strict(),
};
function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
    const parsed = schema.safeParse(data ?? {});
    if (!parsed.success)
        throw new FileError(
            'INVALID_PARAMS',
            parsed.error.issues
                .map(
                    (issue) =>
                        `${issue.path.join('.') || 'params'}: ${issue.message}`,
                )
                .join('; '),
            -32602,
        );
    return parsed.data;
}
function rpc(error: unknown) {
    if (error instanceof McpError) return error;
    const e = fileError(error);
    return new McpError(e.rpcCode, e.message, { code: e.code });
}

export function resourceUri(rootId: string, file: string): string {
    relativePath(file);
    return `staff-file://${rootId}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
function resource(uri: string) {
    const match = /^staff-file:\/\/([a-z0-9-]+)\/(.*)$/.exec(uri);
    if (!match)
        throw new FileError(
            'INVALID_URI',
            'Invalid staff file resource URI',
            -32602,
        );
    let components: string[];
    try {
        components = match[2]
            .split('/')
            .map((component) => decodeURIComponent(component));
    } catch {
        throw new FileError('INVALID_URI', 'Invalid URI encoding', -32602);
    }
    // Decode exactly once, per component: encoded separators cannot create new
    // components. Double-encoded '%' names remain literal filesystem names.
    if (components.some((component) => component.includes('/')))
        throw new FileError(
            'INVALID_URI',
            'Encoded separators are not accepted',
            -32602,
        );
    const file = relativePath(components.join('/'));
    if (resourceUri(match[1], file) !== uri)
        throw new FileError(
            'INVALID_URI',
            'Resource URI must use canonical component encoding',
            -32602,
        );
    return { rootId: match[1], file };
}

/** One instance per physical transport generation; no negotiation or handles survive reconnect. */
export class FileManagerSession {
    readonly transfers: TransferManager;
    initialized = false;
    closed = false;
    readonly subscriptions = new Set<string>();
    constructor(
        private readonly core: FileCore,
        private readonly server: McpServer,
        runtimeDirectory: string,
    ) {
        this.transfers = new TransferManager(core, runtimeDirectory);
        core.listeners.add(this.notify);
    }
    requireExtension() {
        const capability = this.server.server.getClientCapabilities()
            ?.experimental?.[FILE_MANAGER] as
            | { versions?: unknown; bridgeVersions?: unknown }
            | undefined;
        if (
            this.closed ||
            !this.initialized ||
            !Array.isArray(capability?.versions) ||
            !capability.versions.includes(1) ||
            !Array.isArray(capability.bridgeVersions) ||
            !capability.bridgeVersions.includes(1)
        )
            fail(
                'EXTENSION_NOT_NEGOTIATED',
                'File-manager version 1 and bridge version 1 must be negotiated on this initialized session',
            );
    }
    dispatchLegacyWrite(dispatch: () => Promise<void>): Promise<void> {
        return this.core.withWriteLock(dispatch);
    }
    async validateLegacyUri(uri: string) {
        // Preserve file:// FTE dispatch/results, while closing lexical-sandbox bypasses.
        // Missing targets remain the existing wrapper's responsibility (including mkdir semantics).
        let full: string;
        try {
            full = fileURLToPath(uri);
        } catch {
            throw new FileError('URI_NOT_ALLOWED', 'Invalid file URI', -32001);
        }
        await this.core.validateToolPath(full, true);
    }
    private notify = (rootId: string, changedPath: string) => {
        if (this.closed || !this.initialized) return;
        for (const uri of this.subscriptions) {
            const entry = resource(uri);
            if (entry.rootId !== rootId) continue;
            if (
                entry.file === changedPath ||
                entry.file.startsWith(`${changedPath}/`) ||
                entry.file === '' ||
                changedPath.startsWith(`${entry.file}/`)
            )
                void this.server.server
                    .sendResourceUpdated({ uri })
                    .catch(() => {});
        }
    };
    async close() {
        if (this.closed) return;
        this.closed = true;
        this.initialized = false;
        this.subscriptions.clear();
        this.core.listeners.delete(this.notify);
        await this.transfers.close();
    }
}

export function registerFileManager(
    server: McpServer,
    core: FileCore,
    runtimeDirectory: string,
) {
    let session: FileManagerSession | undefined;
    const protocol = server.server;
    const previousInitialized = protocol.oninitialized;
    protocol.oninitialized = () => {
        if (session && !session.closed) session.initialized = true;
        previousInitialized?.();
    };
    function current() {
        if (!session || session.closed)
            fail(
                'EXTENSION_NOT_NEGOTIATED',
                'No initialized file-manager session',
            );
        return session;
    }
    function requireExtension() {
        current().requireExtension();
    }
    const guarded =
        <T, R>(handler: (request: T) => Promise<R>) =>
        async (request: T) => {
            try {
                return await handler(request);
            } catch (e) {
                throw rpc(e);
            }
        };
    protocol.setRequestHandler(
        ListResourcesRequestSchema,
        guarded(async (request) => {
            const entries: { uri: string; name: string; mimeType: string }[] =
                [];
            for (const root of core.roots().roots) {
                entries.push({
                    uri: resourceUri(root.rootId, ''),
                    name: root.name,
                    mimeType: 'application/json',
                });
                let cursor: string | undefined;
                do {
                    const listing = await core.list(
                        root.rootId,
                        '',
                        cursor,
                        500,
                    );
                    for (const child of listing.entries) {
                        if (child.type === 'file')
                            entries.push({
                                uri: resourceUri(root.rootId, child.path),
                                name: `${root.name}/${child.name}`,
                                mimeType: mimeType(child.path),
                            });
                    }
                    cursor = listing.nextCursor;
                } while (cursor);
            }
            const version = createHash('sha256')
                .update(JSON.stringify(entries))
                .digest('hex');
            let offset = 0;
            if (request.params?.cursor) {
                try {
                    const cursor = JSON.parse(
                        Buffer.from(
                            request.params.cursor,
                            'base64url',
                        ).toString('utf8'),
                    );
                    if (
                        cursor.version !== version ||
                        !Number.isSafeInteger(cursor.offset) ||
                        cursor.offset < 0 ||
                        cursor.offset >= entries.length
                    )
                        fail(
                            'INVALID_CURSOR',
                            'Resource list changed; refresh',
                        );
                    offset = cursor.offset;
                } catch {
                    fail('INVALID_CURSOR', 'Invalid resource cursor; refresh');
                }
            }
            return {
                resources: entries.slice(offset, offset + 100),
                ...(offset + 100 < entries.length
                    ? {
                          nextCursor: Buffer.from(
                              JSON.stringify({ version, offset: offset + 100 }),
                          ).toString('base64url'),
                      }
                    : {}),
            };
        }),
    );
    protocol.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        guarded(async (request) => {
            if (request.params?.cursor)
                fail(
                    'INVALID_CURSOR',
                    'Resource templates have no further pages',
                );
            return {
                resourceTemplates: core.roots().roots.map((root) => ({
                    uriTemplate: `staff-file://${root.rootId}/{+path}`,
                    name: `${root.name} files`,
                    description:
                        'Actual root-relative files (256 KiB maximum) or directory manifests. Encode each path component once.',
                })),
            };
        }),
    );
    protocol.setRequestHandler(
        ReadResourceRequestSchema,
        guarded(async (request) => {
            const uri = request.params.uri;
            if (uri === UI_URI) {
                requireExtension();
                // Relative to the compiled module, including npm packages and Docker read-only mounts.
                const text = await fs.readFile(
                    new URL('./ui/index.html', import.meta.url),
                    'utf8',
                );
                return { contents: [{ uri, mimeType: 'text/html', text }] };
            }
            const entry = resource(uri);
            const full = await core.resolve(entry.rootId, entry.file);
            if ((await fs.lstat(full)).isDirectory()) {
                const listing = await core.list(entry.rootId, entry.file);
                const text = JSON.stringify({
                    rootId: entry.rootId,
                    path: entry.file,
                    ...listing,
                });
                if (Buffer.byteLength(text) > RESOURCE_LIMIT)
                    fail('TOO_LARGE', 'Resource limit is 256 KiB');
                return {
                    contents: [{ uri, mimeType: 'application/json', text }],
                };
            }
            const bytes = await core.readBytes(
                entry.rootId,
                entry.file,
                RESOURCE_LIMIT,
            );
            const type = mimeType(entry.file);
            let text: string | undefined;
            try {
                text = utf8(bytes);
            } catch (e) {
                if (!(e instanceof FileError && e.code === 'BINARY_FILE'))
                    throw e;
            }
            const textual =
                type.startsWith('text/') ||
                ['application/json', 'image/svg+xml'].includes(type);
            if (textual && text === undefined)
                fail('BINARY_FILE', 'Text resource is not valid UTF-8');
            const binary =
                type.startsWith('image/') && type !== 'image/svg+xml';
            return {
                contents: [
                    text !== undefined && !binary
                        ? {
                              uri,
                              mimeType:
                                  type === 'application/octet-stream'
                                      ? 'text/plain'
                                      : type,
                              text,
                          }
                        : {
                              uri,
                              mimeType: type,
                              blob: bytes.toString('base64'),
                          },
                ],
            };
        }),
    );
    protocol.setRequestHandler(
        SubscribeRequestSchema,
        guarded(async (request) => {
            const entry = resource(request.params.uri);
            await core.resolve(entry.rootId, entry.file);
            current().subscriptions.add(request.params.uri);
            return {};
        }),
    );
    protocol.setRequestHandler(
        UnsubscribeRequestSchema,
        guarded(async (request) => {
            resource(request.params.uri);
            current().subscriptions.delete(request.params.uri);
            return {};
        }),
    );
    async function extensionCall(method: keyof typeof params, input: unknown) {
        requireExtension();
        // Separate parse calls preserve the exact shape/types for every public method.
        switch (method) {
            case 'roots':
                parse(params.roots, input);
                return core.roots();
            case 'list': {
                const p = parse(params.list, input);
                return core.list(p.rootId, p.path, p.cursor, p.limit);
            }
            case 'stat': {
                const p = parse(params.stat, input);
                return core.stat(p.rootId, p.path);
            }
            case 'readText': {
                const p = parse(params.readText, input);
                return core.readText(p.rootId, p.path);
            }
            case 'saveText': {
                const p = parse(params.saveText, input);
                return core.saveText(
                    p.rootId,
                    p.path,
                    p.text,
                    p.expectedVersion,
                );
            }
            case 'createFile': {
                const p = parse(params.createFile, input);
                return core.createFile(p.rootId, p.path, p.text);
            }
            case 'mkdir': {
                const p = parse(params.mkdir, input);
                return core.mkdir(p.rootId, p.path);
            }
            case 'move': {
                const p = parse(params.move, input);
                return core.move(p.rootId, p.from, p.to, p.expectedVersion);
            }
            case 'delete': {
                const p = parse(params.delete, input);
                return core.delete(
                    p.rootId,
                    p.path,
                    p.recursive,
                    p.expectedVersion,
                );
            }
            case 'upload/prepare': {
                const p = parse(params['upload/prepare'], input);
                return current().transfers.prepareUpload(
                    p.rootId,
                    p.path,
                    p.size,
                    p.overwrite,
                    p.expectedVersion,
                );
            }
            case 'upload/commit': {
                const p = parse(params['upload/commit'], input);
                return current().transfers.commit(p.uploadHandle, p.sha256);
            }
            case 'upload/discard': {
                const p = parse(params['upload/discard'], input);
                return current().transfers.discard(p.uploadHandle);
            }
            case 'download/prepare': {
                const p = parse(params['download/prepare'], input);
                return current().transfers.prepareDownload(p.rootId, p.path);
            }
            case 'download/release': {
                const p = parse(params['download/release'], input);
                return current().transfers.release(p.downloadHandle);
            }
        }
    }
    for (const method of Object.keys(params) as (keyof typeof params)[]) {
        protocol.setRequestHandler(
            z.object({
                method: z.literal(`${FILE_MANAGER}/${method}`),
                params: z.unknown().optional(),
            }),
            guarded(async (request) => extensionCall(method, request.params)),
        );
    }
    for (const method of [
        'read/init',
        'read/chunk',
        'read/close',
        'write/init',
        'write/chunk',
        'write/close',
        'abort',
    ]) {
        protocol.setRequestHandler(
            z.object({
                method: z.literal(`${FTE_PREFIX}${method}`),
                params: z.unknown().optional(),
            }),
            guarded(async (request) => {
                requireExtension();
                return current().transfers.fte(
                    method,
                    parse(z.record(z.string(), z.unknown()), request.params),
                );
            }),
        );
    }
    return () => {
        if (session && !session.closed)
            throw new Error(
                'Previous file-manager transport is still connected',
            );
        session = new FileManagerSession(core, server, runtimeDirectory);
        return session;
    };
}
