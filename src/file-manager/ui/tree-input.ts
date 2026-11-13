// FileList and items are alternate views of the same payload, not two batches.
// Prefer FileList when populated; fall back to items for clipboard implementations
// that expose files only there. Identity deduplication never merges same-name files.
export function transferFiles(data: DataTransfer): File[] {
    const files = Array.from(data.files).filter(
        (file): file is File => file instanceof File,
    );
    const source = files.length
        ? files
        : Array.from(data.items)
              .filter((item) => item.kind === 'file')
              .map((item) => item.getAsFile())
              .filter((file): file is File => file instanceof File);
    return [...new Set(source)];
}

export function hasFilePayload(data: DataTransfer) {
    return data.types.includes('Files');
}

export function hasDirectoryPayload(data: DataTransfer) {
    return (
        Array.from(data.items).some(
            (item) =>
                item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory,
        ) || Array.from(data.files).some((file) => !!file.webkitRelativePath)
    );
}

export function editingTarget(target: EventTarget | null) {
    return (
        target instanceof Element &&
        !!target.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        )
    );
}

const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/x-icon': 'ico',
    'text/plain': 'txt',
    'application/pdf': 'pdf',
};

export function namePastedFiles(files: File[]) {
    return files.map((file) => {
        const defaultImageName =
            /^(image|clipboard|pasted[- ]?image|blob)(\.[a-z0-9]+)?$/i.test(
                file.name,
            ) &&
            (file.type.startsWith('image/') ||
                /\.(png|jpe?g|gif|webp|avif|bmp|svg|tiff?|ico)$/i.test(
                    file.name,
                ));
        if (file.name.trim() && !defaultImageName) return file;
        const extension =
            extensions[file.type.toLowerCase()] ??
            /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ??
            'bin';
        const random = Array.from(
            crypto.getRandomValues(new Uint32Array(2)),
            (value) => value.toString(16).padStart(8, '0'),
        ).join('');
        return new File(
            [file],
            `pasted-${Date.now().toString(36)}-${random}.${extension}`,
            { type: file.type, lastModified: file.lastModified },
        );
    });
}

// Browser folder paths are literal root-relative names, never URL paths. Reject
// every unsafe segment before joining a picker path to its captured destination.
export function validUploadPath(path: string) {
    return (
        !!path &&
        !path.includes('\\') &&
        !path.includes('\0') &&
        path
            .split('/')
            .every(
                (part) =>
                    !!part &&
                    part !== '.' &&
                    part !== '..' &&
                    !/^[a-z]:/i.test(part),
            )
    );
}

// Metadata only: directory tasks never masquerade as browser File objects.
export type UploadEntry =
    | { file: File; relativePath: string; directory?: false }
    | { directory: true; relativePath: string; file?: never };

const folderDropHelp =
    '拖放区域尚未就绪，请重新拖入并在目标高亮后松手，或在目录菜单使用“上传文件夹”（菜单无法保留空目录）。';

// Opaque iframes cannot enumerate directory entries. Only the opted-in host
// bridge does that; direct drops keep the ordinary captured-File fallback.
export function collectDroppedEntries(
    data: DataTransfer,
    signal: AbortSignal,
    assertCurrent: () => void,
): Promise<UploadEntry[]> {
    let files: File[];
    try {
        if (hasDirectoryPayload(data)) throw new Error(folderDropHelp);
        files = transferFiles(data);
    } catch (error) {
        return Promise.reject(new Error(folderDropHelp, { cause: error }));
    }
    return (async () => {
        const entries: UploadEntry[] = [];
        for (const file of files) {
            signal.throwIfAborted();
            assertCurrent();
            if (file.name.includes('/') || !validUploadPath(file.name))
                throw new Error('拖入文件名无效，此批次未开始上传。');
            // An opaque directory may look like a zero-byte File. Probe at most
            // one byte, never infer directory kind from MIME or file size.
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            let abort: () => void = () => {};
            try {
                reader = file.slice(0, 1).stream().getReader();
                const activeReader = reader;
                await new Promise((resolve, reject) => {
                    abort = () => reject(signal.reason);
                    signal.addEventListener('abort', abort, { once: true });
                    void activeReader.read().then(resolve, reject);
                });
            } catch (error) {
                throw new Error(folderDropHelp, { cause: error });
            } finally {
                signal.removeEventListener('abort', abort);
                void reader?.cancel().catch(() => {});
            }
            signal.throwIfAborted();
            assertCurrent();
            entries.push({ file, relativePath: file.name });
        }
        return entries;
    })();
}

// One external boundary for the complete host result, before anything is queued.
export function validateHostDropEntries(result: unknown): UploadEntry[] {
    if (
        !result ||
        typeof result !== 'object' ||
        !('entries' in result) ||
        !Array.isArray(result.entries)
    )
        throw new Error('宿主拖放结果无效，此批次未开始上传。');
    return result.entries.map((entry: unknown): UploadEntry => {
        if (
            !entry ||
            typeof entry !== 'object' ||
            !('relativePath' in entry) ||
            typeof entry.relativePath !== 'string' ||
            !validUploadPath(entry.relativePath)
        )
            throw new Error('宿主拖放路径无效，此批次未开始上传。');
        if (
            'directory' in entry &&
            entry.directory === true &&
            !('file' in entry)
        )
            return { directory: true, relativePath: entry.relativePath };
        if (
            !('directory' in entry) &&
            'file' in entry &&
            entry.file instanceof File &&
            Number.isSafeInteger(entry.file.size) &&
            entry.file.size >= 0
        )
            return { file: entry.file, relativePath: entry.relativePath };
        throw new Error('宿主拖放条目无效，此批次未开始上传。');
    });
}
