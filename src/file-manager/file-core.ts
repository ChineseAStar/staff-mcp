import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const TEXT_LIMIT = 2 * 1024 * 1024;
export const FILE_LIMIT = 100 * 1024 * 1024;
export const CHUNK_LIMIT = 512 * 1024;
export class FileError extends Error {
    constructor(
        public code: string,
        message: string,
        public rpcCode = -32000,
    ) {
        super(message);
    }
}
export function fail(code: string, message: string): never {
    throw new FileError(code, message);
}
export function fileError(error: unknown): FileError {
    if (error instanceof FileError) return error;
    const code = (error as NodeJS.ErrnoException)?.code;
    const mapped: Record<string, string> = {
        ENOENT: 'NOT_FOUND',
        ENOTDIR: 'NOT_DIRECTORY',
        EISDIR: 'IS_DIRECTORY',
        EEXIST: 'ALREADY_EXISTS',
        ENOTEMPTY: 'NOT_EMPTY',
        EACCES: 'PERMISSION_DENIED',
        EPERM: 'PERMISSION_DENIED',
        ELOOP: 'SYMLINK_NOT_ALLOWED',
        ENOSPC: 'NO_SPACE',
        EROFS: 'READ_ONLY',
    };
    return new FileError(
        mapped[code ?? ''] ?? 'IO_ERROR',
        mapped[code ?? '']
            ? `File operation failed: ${mapped[code ?? '']}`
            : 'File operation failed',
    );
}
export class Mutex {
    private tail: Promise<unknown> = Promise.resolve();
    async run<T>(fn: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release!: () => void;
        this.tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    }
}
export interface Root {
    rootId: string;
    name: string;
    readOnly: boolean;
    directory: string;
}
export interface Entry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    mtime: string;
}
export function relativePath(value: string): string {
    if (
        typeof value !== 'string' ||
        value.includes('\0') ||
        value.includes('\\') ||
        path.isAbsolute(value) ||
        /^[a-zA-Z]:/.test(value)
    )
        fail('OUTSIDE_ROOT', 'Expected a root-relative path');
    // RPC paths and filesystem names are literal, not URI-encoded. A '%' (even
    // '%2e%2e') is part of the name; only the resource URI boundary decodes it.
    if (value === '') return '';
    const parts = value.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..'))
        fail('OUTSIDE_ROOT', 'Invalid path component');
    if (parts.some((part) => part.startsWith('.staff-write-')))
        fail('OUTSIDE_ROOT', 'Reserved temporary path');
    return value;
}
export function mimeType(file: string): string {
    return (
        (
            {
                '.md': 'text/markdown',
                '.txt': 'text/plain',
                '.json': 'application/json',
                '.html': 'text/html',
                '.svg': 'image/svg+xml',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
            } as Record<string, string>
        )[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    );
}
export function utf8(bytes: Uint8Array): string {
    let text: string;
    try {
        text = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
        }).decode(bytes);
    } catch {
        return fail(
            'BINARY_FILE',
            'Not valid UTF-8; download this file instead',
        );
    }
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text))
        fail('BINARY_FILE', 'Binary content; download this file instead');
    return text;
}
function inside(root: string, candidate: string) {
    const rel = path.relative(root, candidate);
    return (
        rel === '' ||
        (!rel.startsWith(`..${path.sep}`) &&
            rel !== '..' &&
            !path.isAbsolute(rel))
    );
}
export async function secureDirectory(directory: string): Promise<void> {
    const full = path.resolve(directory);
    const parts = full.split(path.sep).filter(Boolean);
    let current = path.parse(full).root;
    for (const part of parts) {
        current = path.join(current, part);
        try {
            await fs.mkdir(current, { mode: 0o700 });
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        const st = await fs.lstat(current);
        if (st.isSymbolicLink() || !st.isDirectory())
            fail(
                'SYMLINK_NOT_ALLOWED',
                'Directory ancestry must not contain links',
            );
    }
}
export class FileCore {
    readonly mutex: Mutex;
    private readonly changes: Set<(full: string) => void>;
    private readonly publications: Set<string>;
    private readonly privateDirectories: string[];
    readonly listeners = new Set<
        (rootId: string, changedPath: string) => void
    >();
    constructor(
        roots: Root[],
        privateDirectory?: string,
        shared?: FileCore,
        privateDirectoryAliases: string[] = [],
    ) {
        // Standard resources/tools and files v1 have independent roots, but serialize
        // writes and observe the same filesystem publications.
        // Aliases only add restrictions. Never replace canonical staging, even
        // when callers supply the internal Docker paths explicitly.
        this.privateDirectories = [
            ...new Set([
                ...(shared?.privateDirectories ?? []),
                ...(privateDirectory ? [path.resolve(privateDirectory)] : []),
                ...privateDirectoryAliases.map((directory) => {
                    if (!path.isAbsolute(directory) || directory.includes('\0'))
                        throw new Error(
                            'Private directory alias must be absolute',
                        );
                    return path.resolve(directory);
                }),
            ]),
        ];
        this.mutex = shared?.mutex ?? new Mutex();
        this.publications = shared?.publications ?? new Set();
        this.changes = shared?.changes ?? new Set();
        this.changes.add((full) => this.notifyChanged(full));
        this.rootMap = new Map(
            roots.map((root) => [
                root.rootId,
                {
                    ...root,
                    directory: path.resolve(root.directory),
                },
            ]),
        );
    }
    private readonly rootMap: Map<string, Root>;
    roots() {
        return {
            roots: [...this.rootMap.values()].map(
                ({ rootId, name, readOnly }) => ({ rootId, name, readOnly }),
            ),
        };
    }
    root(id: string, write = false): Root {
        const root = this.rootMap.get(id);
        if (!root) fail('UNKNOWN_ROOT', 'Unknown rootId');
        if (write && root.readOnly) fail('READ_ONLY', 'This root is read-only');
        return root;
    }
    async resolve(
        rootId: string,
        input: string,
        options: {
            write?: boolean;
            missing?: boolean;
            allowLeafLink?: boolean;
        } = {},
    ) {
        const root = this.root(rootId, options.write);
        const rel = relativePath(input);
        const full = path.resolve(root.directory, rel);
        if (!inside(root.directory, full))
            fail('OUTSIDE_ROOT', 'Path leaves allowed root');
        this.checkPrivate(full);
        // Recheck all ancestry on every operation, including the configured root itself.
        let current = path.parse(root.directory).root;
        const rootParts = root.directory.split(path.sep).filter(Boolean);
        const parts = [...rootParts, ...(rel ? rel.split('/') : [])];
        for (let i = 0; i < parts.length; i++) {
            current = path.join(current, parts[i]);
            let st;
            try {
                st = await fs.lstat(current);
            } catch (e) {
                if (
                    (e as NodeJS.ErrnoException).code === 'ENOENT' &&
                    options.missing &&
                    i === parts.length - 1 &&
                    rel
                )
                    return full;
                throw e;
            }
            if (st.isSymbolicLink()) {
                if (options.allowLeafLink && i === parts.length - 1 && rel)
                    return full;
                fail('SYMLINK_NOT_ALLOWED', 'Symbolic links are not followed');
            }
            if (!st.isDirectory() && !st.isFile())
                fail(
                    'NOT_FILE',
                    'Special filesystem objects are not supported',
                );
            if (i < parts.length - 1 && !st.isDirectory())
                fail('NOT_DIRECTORY', 'A parent is not a directory');
            const real = await fs.realpath(current);
            if (i >= rootParts.length - 1 && !inside(root.directory, real))
                fail('OUTSIDE_ROOT', 'Real path leaves allowed root');
        }
        return full;
    }
    private changed(rootId: string, file: string) {
        const full = path.resolve(this.root(rootId).directory, file);
        for (const notify of this.changes) notify(full);
    }
    private notifyChanged(full: string) {
        for (const root of this.rootMap.values()) {
            if (!inside(root.directory, full)) continue;
            const relative = path
                .relative(root.directory, full)
                .split(path.sep)
                .join('/');
            for (const listener of this.listeners) {
                try {
                    listener(root.rootId, relative);
                } catch {
                    /* observers cannot undo a successful write */
                }
            }
        }
    }
    private checkPrivate(full: string) {
        if (
            this.privateDirectories.some((directory) => inside(directory, full))
        )
            fail(
                'OUTSIDE_ROOT',
                'Private transfer staging is not a workspace file',
            );
    }
    private protectRoots(full: string) {
        this.checkPrivate(full);
        if (
            this.privateDirectories.some((directory) => inside(full, directory))
        )
            fail('ROOT_PROTECTED', 'Cannot remove private staging ancestry');
        for (const root of this.rootMap.values()) {
            if (inside(full, root.directory))
                fail(
                    'ROOT_PROTECTED',
                    'Cannot remove or move a configured root or its ancestor',
                );
        }
        for (const temporary of this.publications) {
            if (inside(full, temporary))
                fail('BUSY', 'An in-flight file publication uses this path');
        }
    }
    /** Standard tools retain their path and result contracts, but share the extension's lock. */
    async validateToolPath(
        full: string,
        missingParents = false,
    ): Promise<string> {
        this.checkPrivate(full);
        const roots = [...this.rootMap.values()]
            .filter((root) => inside(root.directory, full))
            .sort((a, b) => b.directory.length - a.directory.length);
        const root = roots[0];
        if (!root) fail('OUTSIDE_ROOT', 'Path leaves allowed roots');
        const relative = path
            .relative(root.directory, full)
            .split(path.sep)
            .join('/');
        if (
            relative.split('/').some((part) => part.startsWith('.staff-write-'))
        )
            fail('OUTSIDE_ROOT', 'Reserved temporary path');
        // Preserve ordinary tools' literal filenames and recursive parent creation.
        // Unlike extension RPC paths, these have already been resolved by SecurityManager.
        let current = path.parse(full).root;
        for (const part of full.split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try {
                const st = await fs.lstat(current);
                if (st.isSymbolicLink())
                    fail(
                        'SYMLINK_NOT_ALLOWED',
                        'Symbolic links are not followed',
                    );
                if (!st.isDirectory() && !st.isFile())
                    fail('NOT_FILE', 'Unsupported filesystem object');
                if (current !== full && !st.isDirectory())
                    fail('NOT_DIRECTORY', 'Parent is not a directory');
            } catch (e) {
                if (
                    !missingParents ||
                    (e as NodeJS.ErrnoException).code !== 'ENOENT'
                )
                    throw e;
            }
        }
        return full;
    }
    withWriteLock<T>(task: () => Promise<T>): Promise<T> {
        return this.mutex.run(task);
    }
    async toolWrite<T>(
        full: string,
        task: () => Promise<T>,
        missingParents = false,
    ): Promise<T> {
        return this.mutex.run(async () => {
            this.protectRoots(full);
            await this.validateToolPath(full, missingParents);
            const result = await task();
            if (
                !(
                    result &&
                    typeof result === 'object' &&
                    'isError' in result &&
                    result.isError
                )
            ) {
                const root = [...this.rootMap.values()].find((root) =>
                    inside(root.directory, full),
                )!;
                this.changed(
                    root.rootId,
                    path
                        .relative(root.directory, full)
                        .split(path.sep)
                        .join('/'),
                );
            }
            return result;
        });
    }
    private async hashFile(full: string) {
        const handle = await fs.open(
            full,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
            const before = await handle.stat();
            if (!before.isFile()) fail('NOT_FILE', 'Expected a regular file');
            const hash = createHash('sha256');
            const buffer = Buffer.alloc(CHUNK_LIMIT);
            let offset = 0;
            while (true) {
                const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.length,
                    offset,
                );
                if (!bytesRead) break;
                hash.update(buffer.subarray(0, bytesRead));
                offset += bytesRead;
            }
            const after = await handle.stat();
            if (
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs ||
                before.ctimeMs !== after.ctimeMs
            )
                fail('VERSION_CONFLICT', 'File changed while reading');
            return hash.digest('hex');
        } finally {
            await handle.close();
        }
    }
    private async version(full: string): Promise<string> {
        const st = await fs.lstat(full);
        if (st.isSymbolicLink())
            fail('SYMLINK_NOT_ALLOWED', 'Symbolic links are not followed');
        if (st.isFile()) return this.hashFile(full);
        if (!st.isDirectory()) fail('NOT_FILE', 'Unsupported file type');
        const names = (await fs.readdir(full)).sort();
        return createHash('sha256')
            .update(
                `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${JSON.stringify(names)}`,
            )
            .digest('hex');
    }
    async stat(rootId: string, file: string, includeVersion = false) {
        const full = await this.resolve(rootId, file);
        const st = await fs.lstat(full);
        const readOnly = this.root(rootId).readOnly;
        return {
            path: file,
            type: st.isDirectory() ? 'directory' : 'file',
            size: st.size,
            mtime: st.mtime.toISOString(),
            ...(includeVersion ? { version: await this.version(full) } : {}),
            readOnly,
            mimeType: mimeType(file),
            operations: {
                read: st.isFile(),
                write: !readOnly && st.isFile(),
                delete: !readOnly && file !== '',
                move: !readOnly && file !== '',
            },
        };
    }
    async list(rootId: string, file: string, cursor?: string, limit = 100) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 500)
            fail('INVALID_PARAMS', 'limit must be 1..500');
        const full = await this.resolve(rootId, file);
        if (!(await fs.lstat(full)).isDirectory())
            fail('NOT_DIRECTORY', 'Expected a directory');
        const entries: Entry[] = [];
        const names = (await fs.readdir(full, { withFileTypes: true }))
            .filter(
                (entry) =>
                    entry.isFile() ||
                    entry.isDirectory() ||
                    entry.isSymbolicLink(),
            )
            .map((entry) => entry.name)
            .filter(
                (name) =>
                    !name.startsWith('.staff-write-') &&
                    !this.privateDirectories.some((directory) =>
                        inside(directory, path.join(full, name)),
                    ),
            )
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const listingVersion = createHash('sha256')
            .update(JSON.stringify(names))
            .digest('hex');
        let offset = 0;
        if (cursor !== undefined) {
            try {
                const value = JSON.parse(
                    Buffer.from(cursor, 'base64url').toString('utf8'),
                );
                if (
                    value.rootId !== rootId ||
                    value.path !== file ||
                    value.version !== listingVersion ||
                    !Number.isSafeInteger(value.offset) ||
                    value.offset < 0 ||
                    value.offset > names.length
                )
                    fail(
                        'INVALID_CURSOR',
                        'Directory changed or cursor is invalid; refresh',
                    );
                offset = value.offset;
            } catch {
                fail(
                    'INVALID_CURSOR',
                    'Directory changed or cursor is invalid; refresh',
                );
            }
        }
        for (const name of names.slice(offset, offset + limit)) {
            const child = file ? `${file}/${name}` : name;
            // Some Unix names (e.g. a literal backslash) cannot be represented by
            // our relative-path contract. Do not let one such entry hide siblings.
            try {
                relativePath(child);
            } catch (error) {
                if (error instanceof FileError && error.code === 'OUTSIDE_ROOT')
                    continue;
                throw error;
            }
            let st;
            try {
                const target = await this.resolve(rootId, child, {
                    allowLeafLink: true,
                });
                st = await fs.lstat(target);
            } catch (error) {
                // A listed entry may disappear or become a socket/FIFO before resolution.
                if (
                    (error as NodeJS.ErrnoException).code === 'ENOENT' ||
                    (error instanceof FileError && error.code === 'NOT_FILE')
                )
                    continue;
                throw error;
            }
            if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink())
                continue;
            entries.push({
                name,
                path: child,
                type: st.isSymbolicLink()
                    ? 'symlink'
                    : st.isDirectory()
                      ? 'directory'
                      : 'file',
                size: st.size,
                mtime: st.mtime.toISOString(),
            });
        }
        const next = offset + limit;
        return {
            entries,
            ...(next < names.length
                ? {
                      nextCursor: Buffer.from(
                          JSON.stringify({
                              rootId,
                              path: file,
                              offset: next,
                              version: listingVersion,
                          }),
                      ).toString('base64url'),
                  }
                : {}),
        };
    }
    async readBytes(rootId: string, file: string, max = TEXT_LIMIT) {
        const full = await this.resolve(rootId, file);
        const handle = await fs.open(
            full,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
            const before = await handle.stat();
            if (!before.isFile()) fail('NOT_FILE', 'Expected a regular file');
            if (before.size > max)
                fail('TOO_LARGE', `Read limit is ${max} bytes`);
            const data = Buffer.alloc(before.size);
            let offset = 0;
            while (offset < data.length) {
                const { bytesRead } = await handle.read(
                    data,
                    offset,
                    data.length - offset,
                    offset,
                );
                if (!bytesRead)
                    fail('VERSION_CONFLICT', 'File changed while reading');
                offset += bytesRead;
            }
            const after = await handle.stat();
            if (
                after.size !== before.size ||
                after.mtimeMs !== before.mtimeMs ||
                after.ctimeMs !== before.ctimeMs
            )
                fail('VERSION_CONFLICT', 'File changed while reading');
            return data;
        } finally {
            await handle.close();
        }
    }
    async readText(rootId: string, file: string, max = TEXT_LIMIT) {
        const data = await this.readBytes(rootId, file, max);
        return {
            text: utf8(data),
            encoding: 'utf-8',
            version: createHash('sha256').update(data).digest('hex'),
            size: data.length,
        };
    }
    async checkDestination(
        rootId: string,
        file: string,
        overwrite = false,
        expectedVersion?: string,
    ) {
        if (!relativePath(file))
            fail('ROOT_PROTECTED', 'Cannot replace a root');
        const full = await this.resolve(rootId, file, {
            write: true,
            missing: true,
        });
        let st;
        try {
            st = await fs.lstat(full);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (st) {
            if (!st.isFile())
                fail('NOT_FILE', 'Destination is not a regular file');
            if (!overwrite)
                fail('ALREADY_EXISTS', 'Destination already exists');
            if (expectedVersion === undefined)
                fail(
                    'VERSION_REQUIRED',
                    'Overwriting requires expectedVersion',
                );
            if ((await this.version(full)) !== expectedVersion)
                fail('VERSION_CONFLICT', 'File changed; reload before saving');
        } else if (expectedVersion !== undefined)
            fail('VERSION_CONFLICT', 'Expected file no longer exists');
        return { full, exists: !!st, mode: st?.mode };
    }
    private async atomic(
        rootId: string,
        file: string,
        bytesOrSource: Buffer | string,
        overwrite: boolean,
        expectedVersion?: string,
        sourceVersion?: string,
    ) {
        if (!relativePath(file))
            fail('ROOT_PROTECTED', 'Cannot replace a root');
        // Lease the temporary's ancestry before releasing the shared write lock.
        // Controlled move/delete must not relocate it while the large copy is unlocked.
        const { full, temporary } = await this.mutex.run(async () => {
            const full = await this.resolve(rootId, file, {
                write: true,
                missing: true,
            });
            const temporary = path.join(
                path.dirname(full),
                `.staff-write-${randomUUID()}`,
            );
            this.publications.add(temporary);
            return { full, temporary };
        });
        try {
            // Potentially large copy/hash is private staging, not shared publication work.
            if (typeof bytesOrSource === 'string')
                await fs.copyFile(
                    bytesOrSource,
                    temporary,
                    constants.COPYFILE_EXCL,
                );
            else {
                const handle = await fs.open(
                    temporary,
                    constants.O_WRONLY |
                        constants.O_CREAT |
                        constants.O_EXCL |
                        constants.O_NOFOLLOW,
                    0o600,
                );
                try {
                    await handle.writeFile(bytesOrSource);
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            }
            const version =
                typeof bytesOrSource === 'string'
                    ? (sourceVersion ?? (await this.version(temporary)))
                    : createHash('sha256').update(bytesOrSource).digest('hex');
            return await this.mutex.run(async () => {
                const destination = await this.checkDestination(
                    rootId,
                    file,
                    overwrite,
                    expectedVersion,
                );
                if (destination.full !== full)
                    fail('VERSION_CONFLICT', 'Destination changed');
                // Atomic replacement must retain executable and other permission bits.
                if (destination.mode !== undefined)
                    await fs.chmod(temporary, destination.mode & 0o7777);
                if (destination.exists) await fs.rename(temporary, full);
                else {
                    await fs.link(temporary, full);
                    await fs.unlink(temporary);
                }
                this.changed(rootId, file);
                return {
                    path: file,
                    version,
                    size: (await fs.lstat(full)).size,
                };
            });
        } finally {
            await this.mutex.run(async () => {
                try {
                    await fs.unlink(temporary).catch(() => {});
                } finally {
                    this.publications.delete(temporary);
                }
            });
        }
    }
    async saveText(
        rootId: string,
        file: string,
        text: string,
        expectedVersion: string,
    ) {
        const bytes = Buffer.from(text, 'utf8');
        if (bytes.length > TEXT_LIMIT)
            fail('TOO_LARGE', 'Text editing limit is 2 MiB');
        return this.atomic(rootId, file, bytes, true, expectedVersion);
    }
    async createFile(rootId: string, file: string, text = '') {
        const bytes = Buffer.from(text, 'utf8');
        if (bytes.length > TEXT_LIMIT)
            fail('TOO_LARGE', 'Text editing limit is 2 MiB');
        return this.atomic(rootId, file, bytes, false);
    }
    async commitUpload(
        rootId: string,
        file: string,
        source: string,
        overwrite: boolean,
        expectedVersion?: string,
        sourceVersion?: string,
    ) {
        return this.atomic(
            rootId,
            file,
            source,
            overwrite,
            expectedVersion,
            sourceVersion,
        );
    }
    async mkdir(rootId: string, file: string) {
        return this.mutex.run(async () => {
            if (!relativePath(file))
                fail('ROOT_PROTECTED', 'Cannot create root');
            const full = await this.resolve(rootId, file, {
                write: true,
                missing: true,
            });
            await fs.mkdir(full);
            this.changed(rootId, file);
            return { path: file, version: await this.version(full) };
        });
    }
    async move(
        rootId: string,
        from: string,
        to: string,
        expectedVersion?: string,
    ) {
        return this.mutex.run(async () => {
            if (!relativePath(from) || !relativePath(to))
                fail('ROOT_PROTECTED', 'Cannot move a root');
            const source = await this.resolve(rootId, from, { write: true });
            this.protectRoots(source);
            const target = await this.resolve(rootId, to, {
                write: true,
                missing: true,
            });
            if (
                expectedVersion !== undefined &&
                (await this.version(source)) !== expectedVersion
            )
                fail('VERSION_CONFLICT', 'Source changed');
            if (inside(source, target))
                fail('INVALID_PARAMS', 'Cannot move a directory into itself');
            try {
                await fs.lstat(target);
                fail('ALREADY_EXISTS', 'Destination exists');
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            }
            await this.validateTree(source);
            // All controlled writes use this mutex. POSIX rename cannot provide renameat2(NOREPLACE) against hostile external writers.
            await fs.rename(source, target);
            this.changed(rootId, from);
            this.changed(rootId, to);
            return { path: to, version: await this.version(target) };
        });
    }
    private async validateTree(full: string): Promise<void> {
        const st = await fs.lstat(full);
        if (st.isSymbolicLink())
            fail(
                'SYMLINK_NOT_ALLOWED',
                'Operation on a tree containing links is refused',
            );
        if (st.isDirectory())
            for (const child of await fs.readdir(full))
                await this.validateTree(path.join(full, child));
        else if (!st.isFile())
            fail('NOT_FILE', 'Special filesystem objects are not supported');
    }
    async delete(
        rootId: string,
        file: string,
        recursive = false,
        expectedVersion?: string,
    ) {
        return this.mutex.run(async () => {
            if (!relativePath(file))
                fail('ROOT_PROTECTED', 'Cannot delete root');
            const full = await this.resolve(rootId, file, { write: true });
            this.protectRoots(full);
            if (
                expectedVersion !== undefined &&
                (await this.version(full)) !== expectedVersion
            )
                fail('VERSION_CONFLICT', 'File changed');
            const st = await fs.lstat(full);
            await this.validateTree(full);
            if (st.isDirectory()) {
                if (!recursive) await fs.rmdir(full);
                else await fs.rm(full, { recursive: true });
            } else await fs.unlink(full);
            this.changed(rootId, file);
            return { deleted: true, path: file };
        });
    }
    async snapshot(rootId: string, file: string, destination: string) {
        const source = await this.resolve(rootId, file);
        const input = await fs.open(
            source,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let output: fs.FileHandle | undefined;
        try {
            const before = await input.stat();
            if (!before.isFile())
                fail('NOT_FILE', 'Only files can be downloaded');
            if (before.size > FILE_LIMIT)
                fail('TOO_LARGE', 'Download limit is 100 MiB');
            output = await fs.open(
                destination,
                constants.O_WRONLY |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW,
                0o600,
            );
            const hash = createHash('sha256');
            const buffer = Buffer.alloc(CHUNK_LIMIT);
            let size = 0;
            while (true) {
                const { bytesRead } = await input.read(
                    buffer,
                    0,
                    Math.min(buffer.length, FILE_LIMIT + 1 - size),
                    size,
                );
                if (!bytesRead) break;
                size += bytesRead;
                if (size > FILE_LIMIT)
                    fail('TOO_LARGE', 'Download limit is 100 MiB');
                const chunk = buffer.subarray(0, bytesRead);
                hash.update(chunk);
                await output.writeFile(chunk);
            }
            const unchanged = (after: Awaited<ReturnType<typeof input.stat>>) =>
                before.dev === after.dev &&
                before.ino === after.ino &&
                before.size === after.size &&
                before.mtimeMs === after.mtimeMs &&
                before.ctimeMs === after.ctimeMs;
            // A single-pass hash covers the exact snapshot bytes. Metadata and identity checks
            // detect replacement/in-place changes, without hashing the source two more times.
            if (size !== before.size || !unchanged(await input.stat()))
                fail(
                    'VERSION_CONFLICT',
                    'Source changed while creating download snapshot',
                );
            await this.mutex.run(async () => {
                const current = await this.resolve(rootId, file);
                if (current !== source || !unchanged(await fs.lstat(current)))
                    fail(
                        'VERSION_CONFLICT',
                        'Source changed while creating download snapshot',
                    );
            });
            return {
                name: path.basename(file),
                size,
                version: hash.digest('hex'),
            };
        } finally {
            await input.close();
            await output?.close();
        }
    }
}
