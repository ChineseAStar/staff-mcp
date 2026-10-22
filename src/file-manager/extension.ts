import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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
import { TransferManager } from './transfers.js';
import {
    APPS,
    FILES,
    TERMINAL,
    parse as parseExtension,
    operationId,
    supports,
} from '../extensions/protocol.js';
import { FILE_MANAGER, readAppResource } from '../extensions/apps.js';
import { takeHttpTransfers } from './http-transfer.js';

const RESOURCE_LIMIT = 256 * 1024;
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
    stat: z
        .object({ ...rootPath, includeVersion: z.boolean().default(false) })
        .strict(),
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
    private readonly negotiated = new Set<string>();
    readonly subscriptions = new Set<string>();
    constructor(
        private readonly core: FileCore,
        private readonly server: McpServer,
        runtimeDirectory: string,
        wireAvailable: boolean,
    ) {
        this.transfers = new TransferManager(
            core,
            runtimeDirectory,
            takeHttpTransfers(server),
            () => this.requireExtension(),
            wireAvailable,
        );
        core.listeners.add(this.notify);
    }
    initialize() {
        if (this.closed || this.initialized) return;
        for (const extension of [APPS, FILES, TERMINAL]) {
            if (supports(this.server, extension))
                this.negotiated.add(extension);
        }
        this.initialized = true;
    }
    supports(extension: string) {
        return (
            !this.closed && this.initialized && this.negotiated.has(extension)
        );
    }
    requireExtension(extension = FILES) {
        if (!this.supports(extension))
            fail(
                'CAPABILITY_UNAVAILABLE',
                'Extension version 1 is unavailable on this initialized session',
            );
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
    terminalAvailable: () => boolean = () => false,
) {
    let session: FileManagerSession | undefined;
    const protocol = server.server;
    const previousInitialized = protocol.oninitialized;
    protocol.oninitialized = () => {
        session?.initialize();
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
    function requireExtension(extension = FILES) {
        current().requireExtension(extension);
    }
    const guarded =
        <T, R>(handler: (request: T) => Promise<R>) =>
        async (request: T, extra?: { signal?: AbortSignal }) => {
            try {
                if (extra?.signal?.aborted)
                    fail('STALE_CONNECTION', 'Request connection closed');
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
            const app = await readAppResource(
                uri,
                requireExtension,
                terminalAvailable(),
            );
            if (app) return app;
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
            const active = current();
            await core.resolve(entry.rootId, entry.file);
            if (active.closed)
                fail(
                    'STALE_CONNECTION',
                    'Resource subscription connection closed',
                );
            active.subscriptions.add(request.params.uri);
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
                return core.stat(p.rootId, p.path, p.includeVersion);
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
    const digest = z.string().regex(/^[a-f0-9]{64}$/);
    const transferParams = {
        roots: z.object({}).strict(),
        resolve: z.object({ uri: z.string().min(1).max(8192) }).strict(),
        prepare: z
            .object({
                operationId,
                mode: z.enum(['read', 'write']),
                rootId: z.string().min(1),
                path: z.string().min(1),
                size: z
                    .number()
                    .int()
                    .nonnegative()
                    .safe()
                    .max(100 * 1024 * 1024)
                    .optional(),
                sha256: digest.optional(),
                overwrite: z.boolean().optional(),
                expectedVersion: expected,
            })
            .strict(),
        status: z.object({ operationId }).strict(),
        commit: z
            .object({
                operationId,
                transferId: z.string().min(1),
                sha256: digest,
            })
            .strict(),
        cancel: z.object({ operationId }).strict(),
        release: z.object({ operationId }).strict(),
        renew: z.object({ operationId }).strict(),
    };
    async function resolveUri(uri: string) {
        let url: URL;
        let full: string;
        try {
            url = new URL(uri);
            if (
                url.protocol !== 'file:' ||
                (url.hostname && url.hostname !== 'localhost') ||
                url.search ||
                url.hash ||
                url.username ||
                url.password ||
                url.port
            )
                fail('INVALID_PARAMS', 'Expected a local file URI');
            full = fileURLToPath(url);
        } catch {
            return fail('INVALID_PARAMS', 'Expected a local file URI');
        }
        // Longest matching root is deterministic for overlapping allowed directories.
        const roots = core
            .roots()
            .roots.map((root) => core.root(root.rootId))
            .sort((a, b) => b.directory.length - a.directory.length);
        for (const root of roots) {
            const relative = path.relative(root.directory, full);
            if (
                path.isAbsolute(relative) ||
                relative === '..' ||
                relative.startsWith(`..${path.sep}`)
            )
                continue;
            const file = relative.split(path.sep).join('/');
            // Resolve again through FileCore: no relaxation of symlink/private-area checks.
            await core.resolve(root.rootId, file, { missing: true });
            return { rootId: root.rootId, path: file };
        }
        return fail('OUTSIDE_ROOT', 'File URI is outside allowed roots');
    }
    for (const method of Object.keys(
        transferParams,
    ) as (keyof typeof transferParams)[]) {
        protocol.setRequestHandler(
            z.object({
                method: z.literal(`${FILES}/v1/${method}`),
                params: z.unknown().optional(),
            }),
            guarded(async (request) => {
                requireExtension();
                const transfers = current().transfers;
                switch (method) {
                    case 'roots':
                        parseExtension(transferParams.roots, request.params);
                        return core.roots();
                    case 'resolve':
                        return resolveUri(
                            parseExtension(
                                transferParams.resolve,
                                request.params,
                            ).uri,
                        );
                    case 'prepare':
                        return transfers.prepare(
                            parseExtension(
                                transferParams.prepare,
                                request.params,
                            ),
                        );
                    case 'status':
                        return transfers.status(
                            parseExtension(
                                transferParams.status,
                                request.params,
                            ).operationId,
                        );
                    case 'commit': {
                        const p = parseExtension(
                            transferParams.commit,
                            request.params,
                        );
                        return transfers.commit(
                            p.operationId,
                            p.transferId,
                            p.sha256,
                        );
                    }
                    case 'renew':
                        return transfers.renew(
                            parseExtension(transferParams.renew, request.params)
                                .operationId,
                        );
                    case 'cancel':
                        return transfers.release(
                            parseExtension(
                                transferParams.cancel,
                                request.params,
                            ).operationId,
                        );
                    case 'release':
                        return transfers.release(
                            parseExtension(
                                transferParams.release,
                                request.params,
                            ).operationId,
                        );
                }
            }),
        );
    }
    return (wireAvailable: boolean) => {
        if (session && !session.closed)
            throw new Error(
                'Previous file-manager transport is still connected',
            );
        session = new FileManagerSession(
            core,
            server,
            runtimeDirectory,
            wireAvailable,
        );
        return session;
    };
}
