// Root-relative listing entries shared by the tree and existing file actions.
export interface Entry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    mtime: string | number;
}

// Sort the merged loaded entries, not individual server pages. Symlinks stay
// with files; only actual directory entries receive directory priority.
export function compareEntries(a: Entry, b: Entry) {
    const directoryOrder =
        Number(b.type === 'directory') - Number(a.type === 'directory');
    if (directoryOrder) return directoryOrder;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function parentPath(path: string) {
    return path.split('/').slice(0, -1).join('/');
}

export function withinPath(path: string, parent: string) {
    return path === parent || path.startsWith(`${parent}/`);
}
