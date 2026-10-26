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
