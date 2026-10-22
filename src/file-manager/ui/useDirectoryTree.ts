import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { bridge, BridgeError, errorMessage } from './bridge';
import { withinPath } from './tree-types';
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
            if (!available || !rootId || current.current !== scope) return;
            const pending = scope.pending.get(path);
            if (pending) {
                if (mode === 'refresh' || pending.invalidated) {
                    pending.invalidated = true;
                    pending.refresh = true;
                }
                return;
            }
            const previous = scope.directories.get(path);
            if (mode === 'initial' && previous) return;
            if (
                mode === 'more' &&
                (!previous?.nextCursor || previous.invalidCursor)
            )
                return;
            const cursor = mode === 'more' ? previous?.nextCursor : undefined;
            const request: PendingList = { invalidated: false, refresh: false };
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
                    entries: [...entries.values()],
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
                if (current.current === scope) {
                    if (request.refresh) void loadDirectory(path, 'refresh');
                    else render();
                }
            }
        },
        [available, rootId, scope],
    );

    useEffect(() => {
        void load('');
    }, [load]);

    const expand = (path: string) => {
        scope.expanded.add(path);
        render();
        void load(path);
    };
    const collapse = (path: string) => {
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
        if (targetRoot === rootId && scope.directories.has(path))
            void load(path, 'refresh');
    };
    const removeSubtree = (targetRoot: string, path: string) => {
        if (targetRoot !== rootId) return;
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
        loadMore: (path: string) => void load(path, 'more'),
        retry: (path: string) => {
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
