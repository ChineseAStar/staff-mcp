// Root-relative listing entries shared by the tree and existing file actions.
export interface Entry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    mtime: string | number;
}

export function parentPath(path: string) {
    return path.split('/').slice(0, -1).join('/');
}

export function withinPath(path: string, parent: string) {
    return path === parent || path.startsWith(`${parent}/`);
}
