import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { formatDate, formatSize, Icon } from './ui';
import type { IconName } from './ui';
import { parentPath, withinPath } from './tree-types';
import type { Entry } from './tree-types';
import type { DirectoryTree as TreeState } from './useDirectoryTree';

interface Props {
    tree: TreeState;
    available: boolean;
    directory: string;
    selectedPath?: string;
    activePath?: string;
    menuPath?: string;
    directoryMenuOpen?: boolean;
    onSelect: (entry: Entry) => void;
    onOpen: (entry: Entry) => void;
    onMenu: (entry: Entry, trigger: HTMLElement, x: number, y: number) => void;
    onBlankMenu: (trigger: HTMLElement, x: number, y: number) => void;
    creation?: {
        kind: 'create' | 'mkdir';
        directory: string;
        name: string;
        busy: boolean;
        error?: string;
    };
    onCreationName: (name: string) => void;
    onCreationSubmit: () => void;
    onCreationCancel: () => void;
    entryIcon: (entry: Entry) => IconName;
}

export function DirectoryTree({
    tree,
    available,
    directory,
    selectedPath,
    activePath,
    menuPath,
    directoryMenuOpen,
    onSelect,
    onOpen,
    onMenu,
    onBlankMenu,
    creation,
    onCreationName,
    onCreationSubmit,
    onCreationCancel,
    entryIcon,
}: Props) {
    const [focusedPath, setFocusedPath] = useState<string>();
    const nodes = useRef(new Map<string, HTMLDivElement>());
    const creationInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (!creation) return;
        creationInput.current?.focus();
        creationInput.current?.scrollIntoView({ block: 'nearest' });
    }, [creation?.directory, creation?.kind]);
    // Cache entries are already sorted after merging pages, so rendering and
    // keyboard navigation share the same order. Collapsed descendants are
    // neither rendered nor keyboard targets.
    // The directory cache remains the sole data source.
    const visible: Entry[] = [];
    const collect = (path: string) => {
        for (const entry of tree.directories.get(path)?.entries ?? []) {
            visible.push(entry);
            if (entry.type === 'directory' && tree.expanded.has(entry.path))
                collect(entry.path);
        }
    };
    collect('');
    const tabPath = visible.some((entry) => entry.path === focusedPath)
        ? focusedPath
        : (visible.find((entry) => entry.path === selectedPath)?.path ??
          visible[0]?.path);
    const focus = (entry: Entry | undefined) => {
        if (!entry) return;
        nodes.current.get(entry.path)?.focus();
    };
    const toggle = (entry: Entry) => {
        onSelect(entry);
        if (tree.expanded.has(entry.path)) tree.collapse(entry.path);
        else tree.expand(entry.path);
    };
    const keyboard = (event: KeyboardEvent<HTMLDivElement>, entry: Entry) => {
        if (
            event.key === 'ContextMenu' ||
            (event.shiftKey && event.key === 'F10')
        ) {
            event.preventDefault();
            event.stopPropagation();
            const trigger = event.target as HTMLElement;
            const bounds = trigger.getBoundingClientRect();
            onMenu(entry, trigger, bounds.left, bounds.bottom);
            return;
        }
        if (event.target !== event.currentTarget) return;
        const index = visible.findIndex((item) => item.path === entry.path);
        if (
            ![
                'ArrowUp',
                'ArrowDown',
                'ArrowLeft',
                'ArrowRight',
                'Home',
                'End',
                'Enter',
                ' ',
            ].includes(event.key)
        )
            return;
        event.preventDefault();
        event.stopPropagation();
        if (!available) return;
        switch (event.key) {
            case 'Home':
                focus(visible[0]);
                break;
            case 'End':
                focus(visible.at(-1));
                break;
            case 'ArrowUp':
                focus(visible[Math.max(0, index - 1)]);
                break;
            case 'ArrowDown':
                focus(visible[Math.min(visible.length - 1, index + 1)]);
                break;
            case 'ArrowLeft':
                if (
                    entry.type === 'directory' &&
                    tree.expanded.has(entry.path)
                ) {
                    if (withinPath(directory, entry.path)) onSelect(entry);
                    tree.collapse(entry.path);
                } else
                    focus(
                        visible.find(
                            (item) => item.path === parentPath(entry.path),
                        ),
                    );
                break;
            case 'ArrowRight':
                if (entry.type !== 'directory') break;
                if (!tree.expanded.has(entry.path)) tree.expand(entry.path);
                else if (
                    parentPath(visible[index + 1]?.path ?? '') === entry.path
                )
                    focus(visible[index + 1]);
                break;
            default:
                if (entry.type === 'directory') toggle(entry);
                else {
                    onSelect(entry);
                    onOpen(entry);
                }
        }
    };
    const contents = (path: string, level: number) => {
        const page = tree.directories.get(path);
        // An explicitly chosen destination can be beyond a cached first page.
        // Render only its known ancestor chain, without forging server entries
        // or fetching further pages/descendants to locate the naming input.
        const target = creation?.directory;
        const suffix =
            target !== undefined &&
            target !== path &&
            (!path || withinPath(target, path))
                ? target.slice(path ? path.length + 1 : 0).split('/')[0]
                : undefined;
        const missingChild = suffix
            ? path
                ? `${path}/${suffix}`
                : suffix
            : undefined;
        const showMissingChild =
            missingChild !== undefined &&
            !page?.entries.some((entry) => entry.path === missingChild);
        return (
            <>
                {creation?.directory === path && (
                    <div
                        className="tree-name-row"
                        style={{ paddingLeft: (level - 1) * 16 + 10 }}
                    >
                        <form
                            aria-label={
                                creation.kind === 'create'
                                    ? '新建文件'
                                    : '新建文件夹'
                            }
                            onSubmit={(event) => event.preventDefault()}
                            onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === 'Escape') {
                                    event.preventDefault();
                                    if (!creation.busy) onCreationCancel();
                                }
                            }}
                        >
                            <Icon
                                name={
                                    creation.kind === 'create'
                                        ? 'file'
                                        : 'folder'
                                }
                                size={17}
                            />
                            <input
                                aria-label={
                                    creation.kind === 'create'
                                        ? '文件名'
                                        : '文件夹名'
                                }
                                autoComplete="off"
                                autoFocus
                                ref={creationInput}
                                placeholder={
                                    creation.kind === 'create'
                                        ? '文件名'
                                        : '文件夹名'
                                }
                                onKeyDown={(event) => {
                                    if (event.key !== 'Enter') return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    if (
                                        !event.nativeEvent.isComposing &&
                                        event.keyCode !== 229
                                    )
                                        onCreationSubmit();
                                }}
                                value={creation.name}
                                disabled={creation.busy || !available}
                                onChange={(event) =>
                                    onCreationName(event.target.value)
                                }
                            />
                            <button
                                type="button"
                                onClick={onCreationSubmit}
                                disabled={creation.busy || !available}
                            >
                                {creation.busy ? '创建中…' : '创建'}
                            </button>
                            <button
                                type="button"
                                disabled={creation.busy}
                                onClick={onCreationCancel}
                            >
                                取消
                            </button>
                        </form>
                        {creation.error && (
                            <div className="inline-error" role="alert">
                                {creation.error}
                            </div>
                        )}
                    </div>
                )}
                {showMissingChild && (
                    <div
                        role="treeitem"
                        aria-label={`${suffix}（新建位置）`}
                        aria-level={level}
                        aria-expanded="true"
                    >
                        <div
                            className="tree-destination"
                            style={{ paddingLeft: (level - 1) * 16 + 10 }}
                            title={missingChild}
                        >
                            <Icon name="folder" size={17} />
                            {suffix}
                        </div>
                        <div role="group">
                            {contents(missingChild!, level + 1)}
                        </div>
                    </div>
                )}
                {(page?.entries ?? []).map((entry) => {
                    const isDirectory = entry.type === 'directory';
                    const expanded =
                        isDirectory && tree.expanded.has(entry.path);
                    return (
                        <div
                            key={entry.path}
                            role="treeitem"
                            aria-label={entry.name}
                            title={entry.path}
                            aria-level={level}
                            aria-expanded={isDirectory ? expanded : undefined}
                            aria-selected={selectedPath === entry.path}
                            aria-disabled={!available}
                            tabIndex={tabPath === entry.path ? 0 : -1}
                            ref={(node) => {
                                if (node) nodes.current.set(entry.path, node);
                                else nodes.current.delete(entry.path);
                            }}
                            onFocus={(event) => {
                                if (event.target === event.currentTarget)
                                    setFocusedPath(entry.path);
                            }}
                            onKeyDown={(event) => keyboard(event, entry)}
                        >
                            <div
                                className={`file-row ${selectedPath === entry.path ? 'selected' : ''} ${isDirectory && directory === entry.path ? 'target-directory' : ''} ${activePath === entry.path ? 'current-file' : ''}`}
                                style={{ paddingLeft: (level - 1) * 16 }}
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const trigger =
                                        event.currentTarget.querySelector<HTMLElement>(
                                            '.entry-select',
                                        )!;
                                    onMenu(
                                        entry,
                                        trigger,
                                        event.clientX,
                                        event.clientY,
                                    );
                                }}
                            >
                                <button
                                    className="entry-open"
                                    tabIndex={-1}
                                    disabled={!available}
                                    aria-label={
                                        isDirectory
                                            ? `${expanded ? '收起' : '展开'} ${entry.name}`
                                            : `打开 ${entry.name}`
                                    }
                                    title={`${entry.path}\n${entry.type === 'directory' ? '文件夹' : entry.type === 'symlink' ? '符号链接' : formatSize(entry.size)} · ${formatDate(entry.mtime)}`}
                                    onClick={() => {
                                        nodes.current.get(entry.path)?.focus();
                                        if (isDirectory) toggle(entry);
                                        else {
                                            onSelect(entry);
                                            onOpen(entry);
                                        }
                                    }}
                                >
                                    <span
                                        className={`tree-chevron ${expanded ? 'expanded' : ''}`}
                                    >
                                        {isDirectory && (
                                            <Icon name="chevron" size={12} />
                                        )}
                                    </span>
                                    <span
                                        className={`entry-icon ${entry.type}`}
                                    >
                                        <Icon
                                            name={entryIcon(entry)}
                                            size={17}
                                        />
                                    </span>
                                    <span className="entry-name">
                                        {entry.name}
                                    </span>
                                </button>
                                <button
                                    className="entry-select icon-button"
                                    title={`${entry.name} 的操作`}
                                    aria-label={`${entry.name} 的操作`}
                                    aria-haspopup="menu"
                                    aria-expanded={menuPath === entry.path}
                                    disabled={!available}
                                    onClick={(event) => {
                                        const trigger = event.currentTarget;
                                        const bounds =
                                            trigger.getBoundingClientRect();
                                        onMenu(
                                            entry,
                                            trigger,
                                            bounds.left,
                                            bounds.bottom,
                                        );
                                    }}
                                >
                                    <Icon name="more" size={16} />
                                </button>
                            </div>
                            {expanded && (
                                <div role="group">
                                    {contents(entry.path, level + 1)}
                                </div>
                            )}
                        </div>
                    );
                })}
                <div
                    className="tree-status"
                    style={{ paddingLeft: (level - 1) * 16 + 10 }}
                >
                    {page?.loading && <span role="status">读取中…</span>}
                    {page?.error && (
                        <div role="alert">
                            <span>{page.error}</span>
                            <button
                                disabled={!available || page.loading}
                                onClick={() => tree.retry(path)}
                            >
                                {page.invalidCursor ? '刷新此目录' : '重试'}
                            </button>
                        </div>
                    )}
                    {page?.loaded &&
                        !page.entries.length &&
                        !page.error &&
                        !page.loading && <span>空文件夹</span>}
                    {page?.nextCursor && !page.error && (
                        <button
                            disabled={!available || page.loading}
                            onClick={() => tree.loadMore(path)}
                        >
                            加载更多
                        </button>
                    )}
                </div>
            </>
        );
    };
    return (
        <div
            className="file-list directory-tree"
            role="tree"
            aria-label="文件目录树"
            tabIndex={0}
            onContextMenu={(event) => {
                if ((event.target as HTMLElement).closest('input')) return;
                event.preventDefault();
                onBlankMenu(event.currentTarget, event.clientX, event.clientY);
            }}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (
                    event.key === 'ContextMenu' ||
                    (event.shiftKey && event.key === 'F10')
                ) {
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    onBlankMenu(
                        event.currentTarget,
                        bounds.left + 12,
                        bounds.top + 12,
                    );
                }
            }}
        >
            <div className="tree-actions">
                <button
                    type="button"
                    className="icon-button"
                    title="当前目录操作"
                    aria-label="当前目录操作"
                    aria-haspopup="menu"
                    aria-expanded={!!directoryMenuOpen}
                    disabled={!available}
                    onClick={(event) => {
                        const trigger = event.currentTarget;
                        const bounds = trigger.getBoundingClientRect();
                        onBlankMenu(trigger, bounds.left, bounds.bottom);
                    }}
                >
                    <Icon name="more" size={16} />
                </button>
            </div>
            {contents('', 1)}
        </div>
    );
}
