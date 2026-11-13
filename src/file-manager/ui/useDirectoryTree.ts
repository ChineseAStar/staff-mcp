import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { bridge, BridgeError, errorMessage } from './bridge';
import { compareEntries, withinPath } from './tree-types';
import type { Entry } from './tree-types';

export interface DirectoryPage {
    entries: Entry[];
    loaded: boolean;
    loading: boolean;
    error?: string;
    invalidCursor?: boolean;
    failedMode?: LoadMode;
    nextCursor?: string;
}

interface PendingList {
    invalidated: boolean;
    refresh: boolean;
    promise: Promise<void>;
}

type LoadMode = 'initial' | 'more' | 'refresh';

export function useDirectoryTree(rootId: string, available: boolean) {
    // This root/availability lifetime owns the only directory cache. A new
    // lifetime immediately fences old callbacks, even before effects run.
    const scope = useMemo(
        () => ({
            directories: new Map<string, DirectoryPage>(),
            expanded: new Set<string>(),
            pending: new Map<string, PendingList>(),
            active: true,
            locator: 0,
        }),
        [rootId, available],
    );
    const current = useRef(scope);
    current.current = scope;
    const [, render] = useReducer((value: number) => value + 1, 0);

    const load = useCallback(
        async function loadDirectory(
            path: string,
            mode: LoadMode = 'initial',
        ): Promise<void> {
            if (
                !available ||
                !rootId ||
                !scope.active ||
                current.current !== scope
            )
                return;
            const pending = scope.pending.get(path);
            if (pending) {
                if (mode === 'refresh' || pending.invalidated) {
                    pending.invalidated = true;
                    pending.refresh = true;
                }
                return pending.promise;
            }
            const previous = scope.directories.get(path);
            if (mode === 'initial' && previous) return;
            if (
                mode === 'more' &&
                (!previous?.nextCursor || previous.invalidCursor)
            )
                return;
            const cursor = mode === 'more' ? previous?.nextCursor : undefined;
            let finish!: () => void;
            const request: PendingList = {
                invalidated: false,
                refresh: false,
                promise: new Promise<void>((resolve) => {
                    finish = resolve;
                }),
            };
            scope.pending.set(path, request);
            scope.directories.set(path, {
                entries: previous?.entries ?? [],
                loaded: previous?.loaded ?? false,
                nextCursor: previous?.nextCursor,
                loading: true,
            });
            render();
            const valid = () =>
                current.current === scope &&
                scope.active &&
                scope.pending.get(path) === request &&
                !request.invalidated;
            try {
                const result = await bridge.request<{
                    entries: Entry[];
                    nextCursor?: string;
                }>('list', {
                    rootId,
                    path,
                    limit: 100,
                    ...(cursor ? { cursor } : {}),
                });
                if (!valid()) return;
                const entries = new Map<string, Entry>();
                if (mode === 'more') {
                    for (const entry of previous?.entries ?? [])
                        entries.set(entry.path, entry);
                }
                for (const entry of result.entries)
                    entries.set(entry.path, entry);
                scope.directories.set(path, {
                    entries: [...entries.values()].sort(compareEntries),
                    loaded: true,
                    loading: false,
                    nextCursor: result.nextCursor,
                });
            } catch (error) {
                if (!valid()) return;
                const invalidCursor =
                    error instanceof BridgeError &&
                    error.code === 'INVALID_CURSOR';
                scope.directories.set(path, {
                    entries: previous?.entries ?? [],
                    loaded: previous?.loaded ?? false,
                    nextCursor: previous?.nextCursor,
                    loading: false,
                    error: errorMessage(error),
                    invalidCursor,
                    failedMode: mode,
                });
            } finally {
                if (scope.pending.get(path) === request)
                    scope.pending.delete(path);
                if (current.current === scope && scope.active) {
                    // Joiners wait for the queued refresh as well, never read
                    // the invalidated page or start a concurrent next page.
                    if (request.refresh) await loadDirectory(path, 'refresh');
                    else render();
                }
                finish();
            }
        },
        [available, rootId, scope],
    );

    useEffect(() => {
        scope.active = true;
        void load('');
        return () => {
            scope.active = false;
            scope.locator++;
        };
    }, [load, scope]);

    const locate = useCallback(
        async (
            path: string,
            isCurrent: () => boolean,
        ): Promise<Entry | undefined> => {
            const request = ++scope.locator;
            const valid = () =>
                scope.active &&
                current.current === scope &&
                scope.locator === request &&
                isCurrent();
            const parts = path.split('/').filter(Boolean);
            let directory = '';
            for (let index = 0; index < parts.length; index++) {
                if (!valid()) return;
                const target = parts.slice(0, index + 1).join('/');
                await load(directory);
                while (valid()) {
                    const page = scope.directories.get(directory);
                    if (page?.error)
                        throw new Error(
                            page.invalidCursor
                                ? '目录分页已失效，请刷新此目录后重试。'
                                : page.error,
                        );
                    const entry = page?.entries.find(
                        (item) => item.path === target,
                    );
                    if (entry) {
                        if (index === parts.length - 1) return entry;
                        if (entry.type !== 'directory')
                            throw new Error(
                                '目标的祖先已不是文件夹，请刷新目录。',
                            );
                        scope.expanded.add(entry.path);
                        render();
                        directory = entry.path;
                        break;
                    }
                    if (!page?.nextCursor)
                        throw new Error('文件或目录不存在，请刷新目录。');
                    const cursor = page.nextCursor;
                    await load(directory, 'more');
                    if (!valid()) return;
                    if (
                        scope.directories.get(directory)?.nextCursor ===
                            cursor &&
                        !scope.directories.get(directory)?.error
                    )
                        throw new Error('目录分页未前进，请刷新此目录后重试。');
                }
            }
        },
        [load, scope],
    );

    const expand = (path: string) => {
        scope.locator++;
        scope.expanded.add(path);
        render();
        void load(path);
    };
    const collapse = (path: string) => {
        scope.locator++;
        scope.expanded.delete(path);
        render();
    };
    const reveal = (path: string, includeDirectory = false) => {
        const parts = path.split('/').filter(Boolean);
        const count = includeDirectory ? parts.length : parts.length - 1;
        // Only ancestors' first pages; never chase a cursor to find a file.
        for (let i = 1; i <= count; i++) expand(parts.slice(0, i).join('/'));
    };
    const refreshDirectory = (targetRoot: string, path: string) => {
        if (targetRoot === rootId && scope.directories.has(path)) {
            scope.locator++;
            void load(path, 'refresh');
        }
    };
    const removeSubtree = (targetRoot: string, path: string) => {
        if (targetRoot !== rootId) return;
        scope.locator++;
        for (const [key, request] of scope.pending) {
            if (!withinPath(key, path)) continue;
            request.invalidated = true;
            request.refresh = false;
        }
        for (const key of scope.directories.keys()) {
            if (withinPath(key, path)) scope.directories.delete(key);
        }
        for (const key of scope.expanded) {
            if (withinPath(key, path)) scope.expanded.delete(key);
        }
        render();
    };

    return {
        directories: scope.directories,
        expanded: scope.expanded,
        expand,
        collapse,
        reveal,
        locate,
        loadMore: (path: string) => {
            scope.locator++;
            void load(path, 'more');
        },
        retry: (path: string) => {
            scope.locator++;
            const page = scope.directories.get(path);
            void load(
                path,
                page?.failedMode === 'more' && !page.invalidCursor
                    ? 'more'
                    : 'refresh',
            );
        },
        refreshDirectory,
        removeSubtree,
    };
}

export type DirectoryTree = ReturnType<typeof useDirectoryTree>;
