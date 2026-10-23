import * as path from 'node:path';
import { realpathSync } from 'node:fs';

export type ExtensionFeature = 'files' | 'terminal';

export interface ExtensionOptions {
    enabled?: ExtensionFeature[];
    fileRoots?: { rootId: string; directory: string }[];
    shell?: string;
}

export function parseExtensions(value: string): ExtensionFeature[] {
    const features = value.split(',');
    if (
        features.some(
            (feature) => feature !== 'files' && feature !== 'terminal',
        )
    )
        throw new Error(
            'Expected --extensions files,terminal (files and/or terminal only)',
        );
    return [...new Set(features)] as ExtensionFeature[];
}

export function parseFileRoot(value: string): {
    rootId: string;
    directory: string;
} {
    const separator = value.indexOf('=');
    const rootId = value.slice(0, separator);
    const directory = value.slice(separator + 1);
    if (
        separator < 1 ||
        !/^[a-z0-9-]+$/.test(rootId) ||
        !directory ||
        directory.includes('\0')
    )
        throw new Error(
            'Expected --file-root <id=path>, with a lowercase root id',
        );
    return { rootId, directory: path.resolve(directory) };
}

export function resolveExtensionOptions(
    options: ExtensionOptions,
    workingDir: string,
) {
    const enabled = options.enabled ?? [];
    if (
        enabled.some((feature) => feature !== 'files' && feature !== 'terminal')
    )
        throw new Error('Unknown extension feature');
    const fileRoots = options.fileRoots ?? [
        { rootId: 'main', directory: workingDir },
    ];
    const ids = new Set<string>();
    if (!fileRoots.length)
        throw new Error('At least one file root is required');
    for (const root of fileRoots) {
        if (!/^[a-z0-9-]+$/.test(root.rootId) || ids.has(root.rootId))
            throw new Error('File root ids must be unique lowercase ids');
        if (!root.directory || root.directory.includes('\0'))
            throw new Error('File root directory must not be empty');
        ids.add(root.rootId);
    }
    if (
        options.shell !== undefined &&
        (!path.isAbsolute(options.shell) || options.shell.includes('\0'))
    )
        throw new Error('Shell must be an absolute executable path');
    return {
        enabled: [...new Set(enabled)],
        fileRoots: fileRoots.map((root) => ({
            ...root,
            directory: path.resolve(root.directory),
        })),
        shell: options.shell,
    };
}

/** Internal Docker protection only. Does not expand any file/tool root. */
export function dockerPrivatePaths(
    workingDir: string,
    binds: { source: string; target: string }[],
): string[] {
    // Docker resolves host bind sources through symlinks. Staging (or a child
    // bind source) need not exist yet, so resolve the nearest existing ancestor.
    const hostPath = (input: string): string => {
        try {
            return realpathSync(input);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const parent = path.dirname(input);
            if (parent === input) throw error;
            return path.join(hostPath(parent), path.basename(input));
        }
    };
    const staging = hostPath(
        path.resolve(workingDir, '.staff', 'file-manager'),
    );
    const inside = (parent: string, child: string) => {
        const rel = path.relative(parent, child);
        return (
            rel === '' ||
            (rel !== '..' &&
                !rel.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(rel))
        );
    };
    const protectedPaths = new Set<string>();
    const add = (source?: string, target?: string) => {
        if (!source || !path.isAbsolute(source) || !target?.startsWith('/'))
            return;
        const host = hostPath(path.resolve(source));
        if (inside(host, staging)) {
            protectedPaths.add(
                path.posix.join(
                    target,
                    ...path.relative(host, staging).split(path.sep),
                ),
            );
        } else if (inside(staging, host)) {
            // A bind of any staging descendant exposes private data at its root.
            protectedPaths.add(path.posix.normalize(target));
        }
    };
    for (const { source, target } of binds) add(source, target);
    return [...protectedPaths];
}
