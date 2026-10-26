import * as path from 'node:path';
import { realpathSync } from 'node:fs';

export type ExtensionFeature = 'files' | 'terminal';

export interface ExtensionOptions {
    enabled?: ExtensionFeature[];
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

export function resolveExtensionOptions(options: ExtensionOptions) {
    const enabled = options.enabled ?? [];
    if (
        enabled.some((feature) => feature !== 'files' && feature !== 'terminal')
    )
        throw new Error('Unknown extension feature');
    return { enabled: [...new Set(enabled)] };
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
