import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import type { CSSProperties } from 'react';
import type { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { bridge, BridgeError, errorMessage } from './bridge';
import { TextEditor } from './Editor';
import { isMarkdown, MarkdownPreview } from './MarkdownPreview';
import { FileContextMenu } from './FileContextMenu';
import { DirectoryTree } from './DirectoryTree';
import { hasFilePayload } from './tree-input';
import { useDirectoryTree } from './useDirectoryTree';
import { parentPath, withinPath } from './tree-types';
import type { Entry } from './tree-types';
import {
    MAX_FILE_SIZE,
    transferActive,
    transferLabels,
    useTransfers,
} from './transfers';
import { formatSize, Icon, IconButton, Menu, Modal } from './ui';
import type { IconName } from './ui';
import {
    TEXT_LIMIT,
    TEXT_AUTO_LIMIT,
    TEXT_PREVIEW_LIMIT,
} from '../text-limits';

interface Root {
    rootId: string;
    name: string;
    readOnly: boolean;
}

interface FileStat extends Omit<Entry, 'name'> {
    version?: string;
    isText: boolean;
    readOnly: boolean;
}

interface TextResult {
    text: string;
    encoding: string;
    version: string;
    size: number;
}

interface FileTab {
    path: string;
    id: string;
    rootId: string;
    name: string;
    kind: 'pending' | 'text' | 'image' | 'binary';
    text: string;
    savedText: string;
    version: string;
    encoding: string;
    size: number;
    readOnly: boolean;
    revision: number;
    busy?: boolean;
    conflict?: boolean;
    error?: string;
    image?: string;
    preview?: boolean;
}

interface Creation {
    kind: 'create' | 'mkdir';
    rootId: string;
    directory: string;
    name: string;
    busy: boolean;
    error?: string;
    trigger?: HTMLElement;
    epoch: number;
}

type MenuTarget =
    | { kind: 'entry'; entry: Entry }
    | { kind: 'folder'; directory: string };

type Dialog =
    | {
          kind: 'rename' | 'move' | 'delete';
          rootId: string;
          target: FileStat & { name: string; version: string };
      }
    | { kind: 'close'; tabIds: string[] }
    | { kind: 'reread'; tabId: string }
    | { kind: 'copy'; text: string };

const dialogTitles: Record<Dialog['kind'], string> = {
    rename: '重命名',
    move: '移动到同一根目录',
    delete: '确认删除',
    close: '关闭文件：有未保存的修改',
    reread: '重新读取服务器文件',
    copy: '手动复制',
};

function joinPath(directory: string, name: string) {
    return directory ? `${directory}/${name}` : name;
}

function fileName(path: string) {
    return path.split('/').pop() ?? path;
}

function isDirty(tab: FileTab) {
    return tab.kind === 'text' && tab.text !== tab.savedText;
}

function hasMarkdownPreview(tab: FileTab) {
    return isMarkdown(tab.name) && tab.size <= TEXT_LIMIT;
}

function affected(tab: FileTab, rootId: string, path: string) {
    return tab.rootId === rootId && withinPath(tab.path, path);
}

// Only inert raster formats become img data URLs. SVG/HTML remain text or binary.
const rasterMimeTypes = new Map([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['avif', 'image/avif'],
    ['bmp', 'image/bmp'],
    ['ico', 'image/x-icon'],
]);

function entryIcon(entry: Pick<Entry, 'type' | 'name'>): IconName {
    if (entry.type === 'directory') return 'folder';
    if (entry.type === 'symlink') return 'link';
    if (
        rasterMimeTypes.has(
            /\.([a-z0-9]+)$/i.exec(entry.name)?.[1].toLowerCase() ?? '',
        )
    )
        return 'image';
    if (/\.(json|md|html?|svg|[jt]sx?|css|xml)$/i.test(entry.name))
        return 'code';
    return 'file';
}

const DEFAULT_TREE_WIDTH = 270;
const MIN_TREE_WIDTH = 180;
const MIN_EDITOR_WIDTH = 240;

export function App() {
    const lifecycle = useSyncExternalStore(bridge.subscribe, bridge.snapshot);
    const available = lifecycle.enabled && lifecycle.connected;
    const [roots, setRoots] = useState<Root[]>([]);
    const [rootsLoading, setRootsLoading] = useState(false);
    const [rootsError, setRootsError] = useState('');
    const [rootId, setRootId] = useState('');
    const [directory, setDirectory] = useState('');
    const [selected, setSelected] = useState<Entry>();
    const [statLoading, setStatLoading] = useState(false);
    const [tabs, setTabs] = useState<FileTab[]>([]);
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;
    const [activeTabId, setActiveTabId] = useState('');
    const pendingTabReveal = useRef<
        { rootId: string; path: string } | undefined
    >(undefined);
    const [mobileView, setMobileView] = useState<'files' | 'editor'>('files');
    // Keep the requested width when the host temporarily shrinks or hides the App.
    const [requestedTreeWidth, setRequestedTreeWidth] =
        useState(DEFAULT_TREE_WIDTH);
    const [workspaceWidth, setWorkspaceWidth] = useState(0);
    const [resizing, setResizing] = useState(false);
    const workspace = useRef<HTMLDivElement>(null);
    const resizeGesture = useRef<{
        element: HTMLDivElement;
        pointerId: number;
        startX: number;
        startWidth: number;
    } | null>(null);
    const maxTreeWidth = Math.max(
        MIN_TREE_WIDTH,
        workspaceWidth ? workspaceWidth - MIN_EDITOR_WIDTH : DEFAULT_TREE_WIDTH,
    );
    const treeWidth = Math.min(
        maxTreeWidth,
        Math.max(MIN_TREE_WIDTH, requestedTreeWidth),
    );
    const finishResize = useCallback(() => {
        const gesture = resizeGesture.current;
        resizeGesture.current = null;
        if (gesture?.element.hasPointerCapture(gesture.pointerId))
            gesture.element.releasePointerCapture(gesture.pointerId);
        setResizing(false);
    }, []);

    useEffect(() => {
        const element = workspace.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            const width = Math.floor(entry.contentRect.width);
            setWorkspaceWidth(width);
            if (width < 900) finishResize();
        });
        observer.observe(element);
        return () => {
            observer.disconnect();
            const gesture = resizeGesture.current;
            resizeGesture.current = null;
            if (gesture?.element.hasPointerCapture(gesture.pointerId))
                gesture.element.releasePointerCapture(gesture.pointerId);
        };
    }, [finishResize]);

    const [opening, setOpening] = useState(false);
    const openingPaths = useRef(new Set<string>());
    const savingTabs = useRef(new Set<string>());
    const loadingTabs = useRef(new Set<string>());
    const tabSequence = useRef(0);
    const views = useRef(new Map<string, EditorView>());
    const [attaching, setAttaching] = useState<{
        rootId: string;
        path: string;
        name: string;
    }>();
    const attachmentPending = useRef(false);
    const [contextMenu, setContextMenu] = useState<{
        rootId: string;
        target: MenuTarget;
        x: number;
        y: number;
        trigger: HTMLElement;
    }>();
    const [tabMenu, setTabMenu] = useState<{
        tabId: string;
        x: number;
        y: number;
        trigger: HTMLElement;
    }>();
    const [notice, setNotice] = useState<{
        kind: 'error' | 'success' | 'info';
        text: string;
    }>();
    const [creation, setCreationState] = useState<Creation>();
    const creationRef = useRef(creation);
    const setCreation = (next: Creation | undefined) => {
        creationRef.current = next;
        setCreationState(next);
    };
    const cancelCreation = (restoreFocus = false) => {
        const trigger = creationRef.current?.trigger;
        setCreation(undefined);
        if (restoreFocus) {
            const target = trigger?.isConnected
                ? trigger
                : document.querySelector<HTMLElement>('.directory-tree');
            target?.focus();
        }
    };
    const [dialog, setDialogState] = useState<Dialog>();
    const actionIntent = useRef(0);
    const actionContext = useRef({ rootId, directory, available, epoch: 0 });
    if (
        actionContext.current.rootId !== rootId ||
        actionContext.current.available !== available
    ) {
        actionContext.current.epoch++;
        actionIntent.current++;
    }
    Object.assign(actionContext.current, { rootId, directory, available });
    const dialogEpoch = useRef(0);
    const setDialog = (next: Dialog | undefined) => {
        actionIntent.current++;
        setStatLoading(false);
        dialogEpoch.current = actionContext.current.epoch;
        setDialogState(next);
    };
    const [dialogBusy, setDialogBusy] = useState(false);
    const [dialogError, setDialogError] = useState('');
    const [showTransfers, setShowTransfers] = useState(false);
    const [menu, setMenu] = useState<'editor' | null>(null);
    const uploadTarget = useRef<
        | {
              rootId: string;
              directory: string;
              epoch: number;
              folder: boolean;
          }
        | undefined
    >(undefined);
    const uploadInput = useRef<HTMLInputElement>(null);

    const root = roots.find((item) => item.rootId === rootId);
    const readOnly = !root || root.readOnly;
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const canWrite = (targetRoot: string) =>
        available &&
        roots.some((item) => item.rootId === targetRoot && !item.readOnly);
    const dirty = tabs.some(isDirty);
    const mobilePane = tabs.length ? mobileView : 'files';
    const tree = useDirectoryTree(rootId, available);
    const treeRef = useRef(tree);
    treeRef.current = tree;
    const refresh = () => {
        cancelCreation();
        actionIntent.current++;
        setStatLoading(false);
        setContextMenu(undefined);
        tree.refreshDirectory(rootId, directory);
    };
    const transfers = useTransfers(available, (targetRoot, path) => {
        tree.refreshDirectory(targetRoot, parentPath(path));
    });
    const activeTransfers = transfers.jobs.filter(transferActive).length;

    const rootsRequest = useRef(0);
    const loadRoots = useCallback(async () => {
        const request = ++rootsRequest.current;
        const valid = () =>
            request === rootsRequest.current && actionContext.current.available;
        setRootsLoading(true);
        setRootsError('');
        try {
            const result = await bridge.request<{ roots: Root[] }>('roots');
            if (!valid()) return;
            setRoots(result.roots);
            if (
                !result.roots.some(
                    (item) => item.rootId === actionContext.current.rootId,
                )
            ) {
                setRootId(result.roots[0]?.rootId ?? '');
                setDirectory('');
                setSelected(undefined);
            }
        } catch (error) {
            if (valid()) setRootsError(errorMessage(error));
        } finally {
            if (request === rootsRequest.current) setRootsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (available) void loadRoots();
        return () => {
            rootsRequest.current++;
        };
    }, [available, loadRoots]);

    useEffect(() => {
        bridge.post({ type: 'app-state', dirty });
    }, [dirty, lifecycle.connected, lifecycle.enabled]);

    useEffect(() => {
        if (!dirty) return;
        const beforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', beforeUnload);
        return () => window.removeEventListener('beforeunload', beforeUnload);
    }, [dirty]);

    useEffect(() => {
        if (!notice || notice.kind === 'error') return;
        const timer = setTimeout(() => setNotice(undefined), 2500);
        return () => clearTimeout(timer);
    }, [notice]);

    useEffect(() => {
        setContextMenu(undefined);
        setTabMenu(undefined);
        if (mobilePane === 'editor') cancelCreation();
        actionIntent.current++;
        setStatLoading(false);
    }, [rootId, available, mobilePane]);

    useEffect(() => {
        cancelCreation();
    }, [rootId, available]);

    useEffect(() => {
        if (creation && !canWrite(creation.rootId)) cancelCreation();
    }, [roots]);

    // Visibility changes must not recreate editors or discard selection/undo history.
    useEffect(() => {
        if (mobilePane === 'editor') {
            views.current.get(activeTabId)?.requestMeasure();
        }
    }, [mobilePane, activeTabId]);

    useEffect(() => {
        document
            .getElementById(`${activeTabId}-label`)
            ?.parentElement?.scrollIntoView({
                block: 'nearest',
                inline: 'nearest',
            });
    }, [activeTabId]);

    const selectEntry = (entry: Entry) => {
        cancelCreation();
        actionIntent.current++;
        setStatLoading(false);
        setContextMenu(undefined);
        setSelected(entry);
        setDirectory(
            entry.type === 'directory' ? entry.path : parentPath(entry.path),
        );
    };

    // Navigation reveals a location; actions capture their own explicit target.
    const navigate = (path: string, nextRoot = rootId) => {
        cancelCreation();
        actionIntent.current++;
        setStatLoading(false);
        setContextMenu(undefined);
        setMobileView('files');
        pendingTabReveal.current = undefined;
        setRootId(nextRoot);
        setDirectory(path);
        setSelected(undefined);
        if (nextRoot === rootId) tree.reveal(path, true);
    };

    const revealTab = (tab: FileTab) => {
        cancelCreation();
        actionIntent.current++;
        setStatLoading(false);
        setContextMenu(undefined);
        setTabMenu(undefined);
        setActiveTabId(tab.id);
        setMobileView('editor');
        const parent = parentPath(tab.path);
        setDirectory(parent);
        if (tab.rootId !== rootId) {
            pendingTabReveal.current = {
                rootId: tab.rootId,
                path: tab.path,
            };
            setRootId(tab.rootId);
        } else tree.reveal(tab.path);
        setSelected({
            name: tab.name,
            path: tab.path,
            type: 'file',
            size: tab.size,
            mtime: '',
        });
    };

    // A tab explicitly activated across roots may reveal ancestors after the
    // new cache exists. A root-selector change itself loads only the root.
    useEffect(() => {
        const pending = pendingTabReveal.current;
        if (pending?.rootId === rootId) {
            tree.reveal(pending.path);
            pendingTabReveal.current = undefined;
        }
    }, [rootId]);

    const updateTab = useCallback((id: string, patch: Partial<FileTab>) => {
        setTabs((current) =>
            current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
        );
    }, []);

    const onView = useCallback((id: string, view: EditorView | null) => {
        if (view) views.current.set(id, view);
        else views.current.delete(id);
    }, []);

    const copy = async (text: string) => {
        try {
            await bridge.request('copy', { text });
            setNotice({ kind: 'success', text: '已复制到剪贴板。' });
        } catch {
            setDialog({ kind: 'copy', text });
            setDialogError('');
        }
    };

    // Metadata first: pending tabs never prepare a snapshot or read the body.
    const loadText = async (tab: FileTab, confirmed = false) => {
        if (!available || loadingTabs.current.has(tab.id)) return;
        const replacingText = tab.kind === 'text';
        const epoch = actionContext.current.epoch;
        const isCurrent = () =>
            epoch === actionContext.current.epoch &&
            actionContext.current.available &&
            tabsRef.current.some(
                (item) =>
                    item.id === tab.id &&
                    item.path === tab.path &&
                    item.rootId === tab.rootId,
            );
        loadingTabs.current.add(tab.id);
        updateTab(tab.id, { busy: true, error: undefined });
        try {
            const stat = await bridge.request<FileStat>('stat', {
                rootId: tab.rootId,
                path: tab.path,
            });
            if (!isCurrent()) return;
            // Keep an existing document intact until its replacement is ready.
            if (!replacingText)
                updateTab(tab.id, {
                    size: stat.size,
                    readOnly: stat.readOnly || stat.size > TEXT_LIMIT,
                });
            if (
                stat.size > TEXT_PREVIEW_LIMIT ||
                (!confirmed && stat.size > TEXT_AUTO_LIMIT)
            ) {
                if (replacingText)
                    throw new Error(
                        stat.size > TEXT_PREVIEW_LIMIT
                            ? '文件达到 5 MiB，不支持在线文本预览，请下载查看。'
                            : '文件超过自动读取上限，请确认后重新读取。',
                    );
                updateTab(tab.id, {
                    kind: 'pending',
                    preview: false,
                    conflict: false,
                });
                return;
            }
            const result = await bridge.request<TextResult>('readText', {
                rootId: tab.rootId,
                path: tab.path,
                // Recheck the actual opened file in core, not just the stat above.
                maxBytes: confirmed ? TEXT_PREVIEW_LIMIT : TEXT_AUTO_LIMIT,
            });
            if (!isCurrent()) return;
            updateTab(tab.id, {
                kind: 'text',
                text: result.text,
                savedText: result.text,
                version: result.version,
                encoding: result.encoding,
                size: result.size,
                readOnly: stat.readOnly || result.size > TEXT_LIMIT,
                conflict: false,
                preview: replacingText
                    ? tab.preview
                    : isMarkdown(tab.name) && result.size <= TEXT_LIMIT,
                revision: tab.revision + 1,
            });
        } catch (error) {
            if (!isCurrent()) return;
            if (replacingText) {
                updateTab(tab.id, {
                    error: `重新读取失败，草稿已保留。${errorMessage(error)}`,
                });
            } else if (
                error instanceof BridgeError &&
                error.code === 'BINARY_FILE'
            ) {
                updateTab(tab.id, {
                    kind: 'binary',
                    error: undefined,
                    preview: false,
                    conflict: false,
                });
            } else if (
                error instanceof BridgeError &&
                error.code === 'TOO_LARGE'
            ) {
                // A small file may grow after stat. Require a click, never auto-retry.
                // An explicitly authorized read refused by the wire budget falls back to download.
                updateTab(tab.id, {
                    kind: confirmed ? 'binary' : 'pending',
                    preview: false,
                    conflict: false,
                    error: confirmed ? errorMessage(error) : undefined,
                });
                try {
                    const stat = await bridge.request<FileStat>('stat', {
                        rootId: tab.rootId,
                        path: tab.path,
                    });
                    if (isCurrent())
                        updateTab(tab.id, {
                            size: stat.size,
                            readOnly: stat.readOnly || stat.size > TEXT_LIMIT,
                        });
                } catch (statError) {
                    if (isCurrent())
                        updateTab(tab.id, { error: errorMessage(statError) });
                }
            } else {
                updateTab(tab.id, { error: errorMessage(error) });
            }
        } finally {
            loadingTabs.current.delete(tab.id);
            updateTab(tab.id, { busy: false });
        }
    };

    const openPath = async (
        targetRoot: string,
        path: string,
        entry?: Entry,
    ) => {
        const existing = tabsRef.current.find(
            (tab) => tab.rootId === targetRoot && tab.path === path,
        );
        if (existing) {
            revealTab(existing);
            return;
        }
        const key = `${targetRoot}\0${path}`;
        if (openingPaths.current.has(key)) return;
        const epoch = actionContext.current.epoch;
        openingPaths.current.add(key);
        setOpening(true);
        try {
            if (entry?.type === 'directory') {
                navigate(path, targetRoot);
                return;
            }
            if (entry?.type === 'symlink') {
                throw new Error('符号链接仅供识别；不允许跟随链接。');
            }
            const imageMimeType = rasterMimeTypes.get(
                /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? '',
            );
            const tab: FileTab = {
                id: `tab-${++tabSequence.current}`,
                rootId: targetRoot,
                path,
                name: fileName(path),
                kind: imageMimeType ? 'image' : 'pending',
                text: '',
                savedText: '',
                version: '',
                encoding: '',
                size: entry?.size ?? 0,
                readOnly: !!roots.find((item) => item.rootId === targetRoot)
                    ?.readOnly,
                revision: 0,
            };
            if (imageMimeType) {
                try {
                    const result = await bridge.request<{ data: string }>(
                        'readBytes',
                        {
                            rootId: targetRoot,
                            path,
                            maxBytes: 2 * 1024 * 1024,
                        },
                    );
                    tab.image = `data:${imageMimeType};base64,${result.data}`;
                } catch (error) {
                    tab.error = errorMessage(error);
                }
            }
            if (
                epoch !== actionContext.current.epoch ||
                !actionContext.current.available
            )
                return;
            setTabs((current) => [...current, tab]);
            setActiveTabId(tab.id);
            setMobileView('editor');
            if (!imageMimeType) await loadText(tab);
        } catch (error) {
            if (epoch === actionContext.current.epoch)
                setNotice({ kind: 'error', text: errorMessage(error) });
        } finally {
            openingPaths.current.delete(key);
            setOpening(openingPaths.current.size > 0);
        }
    };

    const openEntry = (entry: Entry) => {
        actionIntent.current++;
        setStatLoading(false);
        setContextMenu(undefined);
        if (entry.type === 'directory') {
            selectEntry(entry);
            tree.expand(entry.path);
        } else void openPath(rootId, entry.path, entry);
    };

    const saveTab = async (id: string) => {
        const tab = tabsRef.current.find((item) => item.id === id);
        if (
            !tab ||
            tab.kind !== 'text' ||
            tab.busy ||
            savingTabs.current.has(id) ||
            tab.readOnly ||
            tab.size > TEXT_LIMIT ||
            !canWrite(tab.rootId) ||
            !isDirty(tab)
        )
            return;
        if (
            dialogBusy &&
            dialog &&
            'target' in dialog &&
            affected(tab, dialog.rootId, dialog.target.path)
        ) {
            setNotice({
                kind: 'info',
                text: '此项目或父目录正在变更，请等待操作完成后再保存。',
            });
            return;
        }
        if (tab.conflict) {
            setNotice({
                kind: 'error',
                text: '文件存在版本冲突，请先复制草稿或重新读取。不会强制覆盖服务器文件。',
            });
            return;
        }
        const { text, name, path } = tab;
        if (new TextEncoder().encode(text).byteLength > TEXT_LIMIT) {
            updateTab(id, { error: '文本编辑上限为 2 MiB，正文已保留。' });
            return;
        }
        savingTabs.current.add(id);
        updateTab(id, { busy: true, error: undefined });
        try {
            const result = await bridge.request<{
                version: string;
                size?: number;
            }>('saveText', {
                rootId: tab.rootId,
                path,
                text,
                expectedVersion: tab.version,
            });
            // Keep the stable editor identity and current text/undo. The server
            // saved this request's snapshot, not edits made while it was in flight.
            setTabs((current) =>
                current.map((item): FileTab => {
                    if (item.id !== id) return item;
                    return {
                        ...item,
                        savedText: text,
                        version: result.version,
                        size:
                            result.size ??
                            new TextEncoder().encode(text).byteLength,
                        conflict: false,
                        error: undefined,
                    };
                }),
            );
            setNotice({ kind: 'success', text: `已保存 ${name}` });
            treeRef.current.refreshDirectory(tab.rootId, parentPath(path));
        } catch (error) {
            updateTab(id, {
                error: errorMessage(error),
                conflict:
                    error instanceof BridgeError &&
                    error.code === 'VERSION_CONFLICT',
            });
        } finally {
            savingTabs.current.delete(id);
            updateTab(id, { busy: false });
        }
    };

    // Also consume the shortcut outside CodeMirror so the browser never opens
    // its "save web page" dialog inside this isolated application.
    const saveRef = useRef<() => void>(() => {});
    saveRef.current = () => {
        if (activeTabId) void saveTab(activeTabId);
    };
    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (event.isComposing || event.keyCode === 229) return;
            if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === 's'
            ) {
                event.preventDefault();
                event.stopPropagation();
                if (!document.querySelector('[role="dialog"]'))
                    saveRef.current();
            }
        };
        window.addEventListener('keydown', keydown, true);
        return () => window.removeEventListener('keydown', keydown, true);
    }, []);

    const removeTabs = (ids: string[]) => {
        const closing = new Set(ids);
        const current = tabsRef.current;
        const remaining = current.filter((tab) => !closing.has(tab.id));
        setTabs(remaining);
        setActiveTabId((active) => {
            if (!closing.has(active)) return active;
            const index = current.findIndex((tab) => tab.id === active);
            return remaining[Math.min(index, remaining.length - 1)]?.id ?? '';
        });
    };

    const tabBusy = (tab: FileTab) =>
        (tab.busy && tab.kind !== 'pending') || savingTabs.current.has(tab.id);

    const closeTabs = (targets: FileTab[]) => {
        setTabMenu(undefined);
        if (!targets.length || targets.some(tabBusy)) return;
        const tabIds = targets.map((tab) => tab.id);
        if (targets.some(isDirty)) {
            // Capture the requested set; cancellation closes none of its files.
            setDialog({ kind: 'close', tabIds });
            setDialogError('');
        } else removeTabs(tabIds);
    };

    const showTabMenu = (
        tabId: string,
        trigger: HTMLElement,
        x: number,
        y: number,
    ) => {
        setContextMenu(undefined);
        setMenu(null);
        setTabMenu({ tabId, trigger, x, y });
    };

    const beginAction = async (
        kind: 'rename' | 'move' | 'delete',
        targetRoot: string,
        target: Entry,
    ) => {
        if (
            !available ||
            target.type === 'symlink' ||
            !roots.some((item) => item.rootId === targetRoot && !item.readOnly)
        )
            return;
        if (
            tabsRef.current.some(
                (tab) =>
                    (tab.busy || savingTabs.current.has(tab.id)) &&
                    affected(tab, targetRoot, target.path),
            )
        ) {
            setNotice({
                kind: 'error',
                text: '此项目或目录中的文件正在保存，请等待完成后再移动、重命名或删除。',
            });
            return;
        }
        // The target is explicit: selecting a row is not an action dependency.
        const context = { ...actionContext.current };
        const intent = ++actionIntent.current;
        const currentIntent = () =>
            actionIntent.current === intent &&
            actionContext.current.rootId === targetRoot &&
            actionContext.current.directory === context.directory &&
            actionContext.current.epoch === context.epoch &&
            actionContext.current.available;
        setStatLoading(true);
        try {
            const current = await bridge.request<
                FileStat & { version: string }
            >('stat', {
                rootId: targetRoot,
                path: target.path,
                includeVersion: true,
            });
            if (!currentIntent()) return;
            if (current.readOnly || current.type === 'symlink') {
                throw new Error('此项目为只读或符号链接，不能执行此操作。');
            }
            setDialog({
                kind,
                rootId: targetRoot,
                target: { ...current, path: target.path, name: target.name },
            });
            setDialogError('');
        } catch (error) {
            if (currentIntent())
                setNotice({ kind: 'error', text: errorMessage(error) });
        } finally {
            if (currentIntent()) setStatLoading(false);
        }
    };

    const showContextMenu = (
        target: MenuTarget,
        trigger: HTMLElement,
        x: number,
        y: number,
    ) => {
        if (!available) return;
        cancelCreation();
        actionIntent.current++;
        setStatLoading(false);
        setMenu(null);
        setTabMenu(undefined);
        if (target.kind === 'entry') selectEntry(target.entry);
        else {
            setSelected(undefined);
            setDirectory(target.directory);
        }
        setContextMenu({ rootId, target, trigger, x, y });
    };

    const attachFile = async (
        targetRoot: string,
        path: string,
        name: string,
        size: number,
        mode: 'reference' | 'content' = 'reference',
    ) => {
        if (!available || attachmentPending.current) return;
        if (
            tabsRef.current.some(
                (tab) =>
                    tab.rootId === targetRoot &&
                    tab.path === path &&
                    isDirty(tab),
            )
        ) {
            setNotice({
                kind: 'error',
                text: `${name} 有未保存的编辑，请先保存后再${mode === 'reference' ? '引用文件' : '附加内容'}。不会自动保存或使用旧的磁盘内容。`,
            });
            return;
        }
        if (mode === 'content' && size > 256 * 1024) {
            setNotice({
                kind: 'error',
                text: `${name} 超过附件 256 KiB 限制，不能添加到对话。`,
            });
            return;
        }
        attachmentPending.current = true;
        setAttaching({ rootId: targetRoot, path, name });
        setNotice(undefined);
        try {
            const result = await bridge.request<{
                attached: true;
                name: string;
            }>('attachResource', {
                uri: `staff-file://${targetRoot}/${path.split('/').map(encodeURIComponent).join('/')}`,
                title: name,
                mode,
            });
            if (result.attached !== true)
                throw new Error('宿主未确认添加文件。');
            if (mode === 'reference')
                setNotice({
                    kind: 'success',
                    text: '已引用文件；只引用，未附加正文，不会自动发送。',
                });
        } catch (error) {
            const message =
                mode === 'content' &&
                error instanceof BridgeError &&
                error.code === 'TOO_LARGE'
                    ? '附件上限为 256 KiB，文件未添加；下载不能绕过附件限制。'
                    : errorMessage(error);
            setNotice({ kind: 'error', text: `${name}：${message}` });
        } finally {
            attachmentPending.current = false;
            setAttaching(undefined);
        }
    };

    const beginCreate = (
        kind: 'create' | 'mkdir',
        targetRoot: string,
        parent: string,
        trigger?: HTMLElement,
    ) => {
        if (!canWrite(targetRoot)) return;
        cancelCreation();
        actionIntent.current++;
        setStatLoading(false);
        setContextMenu(undefined);
        setMenu(null);
        setMobileView('files');
        tree.reveal(parent, true);
        setCreation({
            kind,
            rootId: targetRoot,
            directory: parent,
            name: '',
            busy: false,
            trigger,
            epoch: actionContext.current.epoch,
        });
    };

    const submitCreation = async () => {
        const creation = creationRef.current;
        if (
            !creation ||
            creation.busy ||
            !canWrite(creation.rootId) ||
            creation.epoch !== actionContext.current.epoch
        )
            return;
        const name = creation.name;
        if (
            !name.trim() ||
            /[\/\\]/.test(name) ||
            name === '.' ||
            name === '..'
        ) {
            setCreation({
                ...creation,
                error: `请输入${creation.kind === 'create' ? '文件名' : '文件夹名'}，不含目录分隔符。`,
            });
            return;
        }
        // Update the ref synchronously so Enter and clicks cannot submit twice.
        const pending = { ...creation, busy: true, error: undefined };
        setCreation(pending);
        try {
            await bridge.request(
                creation.kind === 'create' ? 'createFile' : 'mkdir',
                {
                    rootId: creation.rootId,
                    path: joinPath(creation.directory, name),
                    ...(creation.kind === 'create' ? { text: '' } : {}),
                },
            );
            if (creation.epoch !== actionContext.current.epoch) return;
            treeRef.current.refreshDirectory(
                creation.rootId,
                creation.directory,
            );
            if (creationRef.current !== pending) return;
            cancelCreation(true);
        } catch (error) {
            if (
                creationRef.current === pending &&
                creation.epoch === actionContext.current.epoch
            )
                setCreation({ ...creation, error: errorMessage(error) });
        }
    };

    const beginReread = (tab: FileTab) => {
        if (
            !available ||
            tab.kind !== 'text' ||
            tab.busy ||
            loadingTabs.current.has(tab.id)
        )
            return;
        setDialog({ kind: 'reread', tabId: tab.id });
        setDialogError('');
    };

    const submitDialog = async (form: HTMLFormElement) => {
        if (!dialog || dialogBusy || dialog.kind === 'copy') return;
        const fields = new FormData(form);
        setDialogError('');
        if (dialog.kind === 'close') {
            const closing = tabsRef.current.filter((tab) =>
                dialog.tabIds.includes(tab.id),
            );
            if (closing.some(tabBusy)) {
                setDialogError('文件正在读写，请等待完成后再关闭。');
                return;
            }
            removeTabs(dialog.tabIds);
            setDialog(undefined);
            return;
        }
        if (!available || dialogEpoch.current !== actionContext.current.epoch) {
            setDialogError(
                '连接或根目录已变化，未执行操作。草稿保留，请关闭后重新发起。',
            );
            return;
        }
        setDialogBusy(true);
        try {
            if (
                dialog.kind === 'rename' ||
                dialog.kind === 'move' ||
                dialog.kind === 'delete'
            ) {
                if (!canWrite(dialog.rootId))
                    throw new Error('此根目录不可写，未执行操作。');
                if (
                    tabsRef.current.some(
                        (tab) =>
                            (tab.busy || savingTabs.current.has(tab.id)) &&
                            affected(tab, dialog.rootId, dialog.target.path),
                    )
                )
                    throw new Error(
                        '此项目或目录中的文件正在保存，请等待完成后再移动、重命名或删除。',
                    );
            }
            if (dialog.kind === 'rename' || dialog.kind === 'move') {
                const value = String(fields.get('name') ?? '');
                if (!value.trim()) throw new Error('请输入目标名称或路径。');
                if (dialog.kind === 'rename' && /[\/\\]/.test(value))
                    throw new Error(
                        '重命名只填写名称。需要更换目录时请使用“移动”。',
                    );
                const parent = dialog.target.path
                    .split('/')
                    .slice(0, -1)
                    .join('/');
                const to =
                    dialog.kind === 'rename' ? joinPath(parent, value) : value;
                if (to === dialog.target.path)
                    throw new Error('目标与当前路径相同。');
                if (
                    tabsRef.current.some(
                        (tab) =>
                            tab.rootId === dialog.rootId &&
                            (tab.path === to ||
                                tab.path.startsWith(`${to}/`)) &&
                            !affected(tab, dialog.rootId, dialog.target.path),
                    )
                ) {
                    throw new Error(
                        '目标路径有已打开的标签。请先关闭目标标签，避免混淆编辑缓冲区。',
                    );
                }
                const result = await bridge.request<{ version?: string }>(
                    'move',
                    {
                        rootId: dialog.rootId,
                        from: dialog.target.path,
                        to,
                        expectedVersion: dialog.target.version,
                    },
                );
                setTabs((current) =>
                    current.map((tab) => {
                        if (!affected(tab, dialog.rootId, dialog.target.path))
                            return tab;
                        const path = `${to}${tab.path.slice(dialog.target.path.length)}`;
                        return {
                            ...tab,
                            path,
                            name: fileName(path),
                            version:
                                tab.path === dialog.target.path &&
                                tab.version === dialog.target.version
                                    ? (result.version ?? tab.version)
                                    : tab.version,
                        };
                    }),
                );
                treeRef.current.removeSubtree(
                    dialog.rootId,
                    dialog.target.path,
                );
                treeRef.current.removeSubtree(dialog.rootId, to);
                treeRef.current.refreshDirectory(dialog.rootId, parent);
                if (parentPath(to) !== parent)
                    treeRef.current.refreshDirectory(
                        dialog.rootId,
                        parentPath(to),
                    );
                if (actionContext.current.rootId === dialog.rootId) {
                    const currentDirectory = actionContext.current.directory;
                    if (withinPath(currentDirectory, dialog.target.path)) {
                        const next = `${to}${currentDirectory.slice(dialog.target.path.length)}`;
                        setDirectory(next);
                        treeRef.current.reveal(next, true);
                    }
                    setSelected(undefined);
                }
                setDialog(undefined);
                setNotice({
                    kind: 'success',
                    text: `已${dialog.kind === 'rename' ? '重命名' : '移动'}到 ${to}`,
                });
            } else if (dialog.kind === 'delete') {
                const dirtyAffected = tabsRef.current.filter(
                    (tab) =>
                        affected(tab, dialog.rootId, dialog.target.path) &&
                        isDirty(tab),
                );
                if (dirtyAffected.length && !fields.has('discard'))
                    throw new Error('请先确认丢弃受影响的未保存草稿。');
                await bridge.request('delete', {
                    rootId: dialog.rootId,
                    path: dialog.target.path,
                    recursive: fields.has('recursive'),
                    expectedVersion: dialog.target.version,
                });
                const remaining = tabsRef.current.filter(
                    (tab) => !affected(tab, dialog.rootId, dialog.target.path),
                );
                setTabs(remaining);
                if (!remaining.some((tab) => tab.id === activeTabId))
                    setActiveTabId(remaining[0]?.id ?? '');
                const parent = parentPath(dialog.target.path);
                treeRef.current.removeSubtree(
                    dialog.rootId,
                    dialog.target.path,
                );
                treeRef.current.refreshDirectory(dialog.rootId, parent);
                if (actionContext.current.rootId === dialog.rootId) {
                    if (
                        withinPath(
                            actionContext.current.directory,
                            dialog.target.path,
                        )
                    ) {
                        setDirectory(parent);
                        treeRef.current.reveal(parent, true);
                    }
                    setSelected(undefined);
                }
                setDialog(undefined);
                setNotice({
                    kind: 'success',
                    text: `已删除 ${dialog.target.name}`,
                });
            } else if (dialog.kind === 'reread') {
                const tab = tabsRef.current.find(
                    (item) => item.id === dialog.tabId,
                );
                if (!tab) throw new Error('文件标签已关闭。');
                await loadText(tab, true);
                if (dialogEpoch.current === actionContext.current.epoch)
                    setDialog(undefined);
            }
        } catch (error) {
            setDialogError(errorMessage(error));
        } finally {
            setDialogBusy(false);
        }
    };

    const chooseFiles = (
        files: File[],
        targetRoot: string,
        targetDirectory: string,
        folder = false,
    ) => {
        if (!files.length) return;
        if (!canWrite(targetRoot)) {
            setNotice({
                kind: 'error',
                text: available
                    ? '此根目录只读或不可用，不能上传。'
                    : '连接不可用，不能上传。',
            });
            return;
        }
        setShowTransfers(true);
        transfers.upload(files, targetRoot, targetDirectory, folder);
    };

    const beginUpload = (
        targetRoot: string,
        targetDirectory: string,
        folder = false,
    ) => {
        if (!canWrite(targetRoot) || !uploadInput.current) return;
        // Selection/directory changes do not invalidate this captured target.
        // Root/connection lifetime changes do: never reuse an old authorization.
        uploadTarget.current = {
            rootId: targetRoot,
            directory: targetDirectory,
            epoch: actionContext.current.epoch,
            folder,
        };
        setContextMenu(undefined);
        uploadInput.current.webkitdirectory = folder;
        uploadInput.current.value = '';
        uploadInput.current.click();
    };

    const download = (
        targetRoot: string,
        path: string,
        size: number,
        archive?: 'zip',
    ) => {
        setShowTransfers(true);
        transfers.download(targetRoot, path, size, archive);
    };

    const editorCommand = (command: 'undo' | 'redo' | 'search') => {
        const view = views.current.get(activeTabId);
        if (
            !view ||
            !activeTab ||
            (command !== 'search' &&
                (activeTab.readOnly || !canWrite(activeTab.rootId)))
        )
            return;
        if (command === 'search') openSearchPanel(view);
        else if (command === 'undo') undo(view);
        else redo(view);
        view.focus();
    };

    const dialogTab =
        dialog && 'tabId' in dialog
            ? tabs.find((tab) => tab.id === dialog.tabId)
            : undefined;
    const closingDrafts =
        dialog?.kind === 'close'
            ? tabs.filter(
                  (tab) => dialog.tabIds.includes(tab.id) && isDirty(tab),
              )
            : [];
    const contextTabIndex = tabMenu
        ? tabs.findIndex((tab) => tab.id === tabMenu.tabId)
        : -1;
    const contextTab = tabs[contextTabIndex];
    const tabCloseActions = contextTab
        ? [
              { label: '关闭当前文件', targets: [contextTab] },
              {
                  label: '关闭其他文件',
                  targets: tabs.filter((tab) => tab.id !== contextTab.id),
              },
              {
                  label: '关闭右侧文件',
                  targets: tabs.slice(contextTabIndex + 1),
              },
              { label: '关闭全部文件', targets: tabs },
          ]
        : [];
    const deleteDrafts =
        dialog?.kind === 'delete'
            ? tabs.filter(
                  (tab) =>
                      affected(tab, dialog.rootId, dialog.target.path) &&
                      isDirty(tab),
              )
            : [];

    const transferErrors = transfers.jobs.some((job) =>
        ['error', 'confirm', 'ready', 'unknown', 'verifying'].includes(
            job.status,
        ),
    );
    const queueVisible = showTransfers || activeTransfers > 0 || transferErrors;
    const parentDirectory = directory.split('/').slice(0, -1).join('/');

    const contextEntry =
        contextMenu?.target.kind === 'entry'
            ? contextMenu.target.entry
            : undefined;
    const contextDirectory =
        contextMenu?.target.kind === 'folder'
            ? contextMenu.target.directory
            : contextEntry?.type === 'directory'
              ? contextEntry.path
              : undefined;

    const fileMenuAction = (action: () => void) => {
        setMenu(null);
        action();
    };

    return (
        <div
            className="file-app"
            data-mobile-view={mobilePane}
            data-has-tabs={tabs.length > 0}
            onDragOverCapture={(event) => {
                if (
                    !hasFilePayload(event.dataTransfer) ||
                    (event.target as Element).closest('.directory-tree')
                )
                    return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'none';
            }}
            onDropCapture={(event) => {
                // Block external-file browser navigation outside the tree, but
                // leave CodeMirror's ordinary text dragging untouched.
                if (
                    hasFilePayload(event.dataTransfer) &&
                    !(event.target as Element).closest('.directory-tree')
                )
                    event.preventDefault();
            }}
        >
            <header className="topbar">
                <IconButton
                    name="back"
                    title={
                        mobilePane === 'editor' ? '返回文件列表' : '上一级目录'
                    }
                    className={mobilePane === 'editor' ? 'pane-back' : ''}
                    disabled={
                        mobilePane !== 'editor' && (!directory || !available)
                    }
                    onClick={() =>
                        mobilePane === 'editor'
                            ? setMobileView('files')
                            : navigate(parentDirectory)
                    }
                />
                {mobilePane === 'editor' && (
                    <IconButton
                        name="back"
                        title="上一级目录"
                        className="wide-up"
                        disabled={!directory || !available}
                        onClick={() => navigate(parentDirectory)}
                    />
                )}
                {roots.length === 1 ? (
                    <span className="root-label" title={roots[0].name}>
                        {roots[0].name}
                    </span>
                ) : (
                    <select
                        aria-label="根目录"
                        className="root-select"
                        value={rootId}
                        disabled={!available || rootsLoading || !roots.length}
                        onChange={(event) => navigate('', event.target.value)}
                    >
                        {!roots.length && <option value="">文件</option>}
                        {roots.map((item) => (
                            <option key={item.rootId} value={item.rootId}>
                                {item.name}
                                {item.readOnly ? ' · 只读' : ''}
                            </option>
                        ))}
                    </select>
                )}
                <nav
                    className="breadcrumbs"
                    aria-label="当前位置"
                    title={`所选位置：/${directory}；右键项目操作，空白处操作根目录`}
                >
                    <button
                        title="返回根目录"
                        disabled={!available}
                        onClick={() => navigate('')}
                    >
                        /
                    </button>
                    {directory
                        .split('/')
                        .filter(Boolean)
                        .map((part, index, parts) => (
                            <button
                                key={index}
                                title={parts.slice(0, index + 1).join('/')}
                                onClick={() =>
                                    navigate(
                                        parts.slice(0, index + 1).join('/'),
                                    )
                                }
                                disabled={!available}
                                aria-current={
                                    index === parts.length - 1
                                        ? 'page'
                                        : undefined
                                }
                            >
                                {part}
                                {index < parts.length - 1 ? ' /' : ''}
                            </button>
                        ))}
                </nav>
                {readOnly && root && (
                    <span className="root-lock" title="此根目录只读">
                        <Icon name="lock" size={13} />
                    </span>
                )}
                {(opening || statLoading) && (
                    <span className="file-operation-status" role="status">
                        {opening ? '正在打开…' : '读取中…'}
                    </span>
                )}
                {tabs.length > 0 && mobilePane === 'files' && (
                    <button
                        className="icon-button show-editor"
                        onClick={() => setMobileView('editor')}
                        title="返回已打开文件"
                        aria-label="返回已打开文件"
                    >
                        <Icon name="code" size={14} />
                        {dirty && <span className="dirty-dot" />}
                    </button>
                )}
                <IconButton
                    name="refresh"
                    title="刷新当前目录"
                    disabled={!available}
                    onClick={refresh}
                />
                <IconButton
                    name="transfers"
                    title="传输记录"
                    aria-expanded={showTransfers}
                    aria-controls="transfer-records"
                    onClick={() => setShowTransfers((value) => !value)}
                />
                <input
                    ref={uploadInput}
                    type="file"
                    multiple
                    hidden
                    aria-label="选择上传文件"
                    onChange={(event) => {
                        const target = uploadTarget.current;
                        uploadTarget.current = undefined;
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = '';
                        if (!target || !files.length) return;
                        if (target.epoch !== actionContext.current.epoch) {
                            setNotice({
                                kind: 'error',
                                text: '连接或根目录已变化，请重新选择上传文件。',
                            });
                            return;
                        }
                        chooseFiles(
                            files,
                            target.rootId,
                            target.directory,
                            target.folder,
                        );
                    }}
                />
            </header>

            {!available && (
                <div className="connection-notice" role="status">
                    <Icon name="warning" size={14} />
                    <span>
                        {lifecycle.message ||
                            (lifecycle.connected
                                ? '连接已暂停，草稿保留'
                                : '等待连接…')}
                    </span>
                </div>
            )}
            {notice && (
                <div
                    className={`notice ${notice.kind}`}
                    role={notice.kind === 'error' ? 'alert' : 'status'}
                >
                    <span>{notice.text}</span>
                    <IconButton
                        name="close"
                        title="关闭提示"
                        onClick={() => setNotice(undefined)}
                    />
                </div>
            )}

            {tabMenu && contextTab && (
                <FileContextMenu
                    label={`${contextTab.name} 的标签操作`}
                    x={tabMenu.x}
                    y={tabMenu.y}
                    trigger={tabMenu.trigger}
                    onClose={() => setTabMenu(undefined)}
                >
                    {tabCloseActions.map(({ label, targets }) => (
                        <button
                            key={label}
                            type="button"
                            role="menuitem"
                            disabled={!targets.length || targets.some(tabBusy)}
                            onClick={() => closeTabs(targets)}
                        >
                            {label}
                        </button>
                    ))}
                </FileContextMenu>
            )}
            {contextMenu && (
                <FileContextMenu
                    label={
                        contextEntry
                            ? `${contextEntry.name} 的操作`
                            : '根目录的操作'
                    }
                    x={contextMenu.x}
                    y={contextMenu.y}
                    trigger={contextMenu.trigger}
                    onClose={() => setContextMenu(undefined)}
                >
                    {contextDirectory !== undefined && (
                        <>
                            <button
                                type="button"
                                role="menuitem"
                                disabled={!canWrite(contextMenu.rootId)}
                                onClick={() =>
                                    beginCreate(
                                        'create',
                                        contextMenu.rootId,
                                        contextDirectory,
                                        contextMenu.trigger,
                                    )
                                }
                            >
                                <Icon name="file" />
                                新建文件
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                disabled={!canWrite(contextMenu.rootId)}
                                onClick={() =>
                                    beginCreate(
                                        'mkdir',
                                        contextMenu.rootId,
                                        contextDirectory,
                                        contextMenu.trigger,
                                    )
                                }
                            >
                                <Icon name="folder" />
                                新建文件夹
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                disabled={!canWrite(contextMenu.rootId)}
                                onClick={() =>
                                    beginUpload(
                                        contextMenu.rootId,
                                        contextDirectory,
                                    )
                                }
                            >
                                <Icon name="upload" />
                                上传文件
                            </button>
                            <button
                                role="menuitem"
                                disabled={!canWrite(contextMenu.rootId)}
                                title="保留相对路径；不会上传浏览器未提供的空目录，覆盖需逐文件确认"
                                onClick={() =>
                                    beginUpload(
                                        contextMenu.rootId,
                                        contextDirectory,
                                        true,
                                    )
                                }
                            >
                                <Icon name="folder" />
                                上传文件夹（不含空目录）
                            </button>
                            {contextEntry && <div role="separator" />}
                        </>
                    )}
                    {contextEntry && (
                        <>
                            <button
                                role="menuitem"
                                disabled={
                                    !available ||
                                    contextEntry.type === 'symlink'
                                }
                                onClick={() => {
                                    const target = contextMenu;
                                    setContextMenu(undefined);
                                    if (contextEntry.type === 'directory')
                                        navigate(
                                            contextEntry.path,
                                            target.rootId,
                                        );
                                    else
                                        void openPath(
                                            target.rootId,
                                            contextEntry.path,
                                            contextEntry,
                                        );
                                }}
                            >
                                <Icon
                                    name={
                                        contextEntry.type === 'directory'
                                            ? 'folder'
                                            : 'file'
                                    }
                                />
                                打开
                            </button>
                            {contextEntry.type === 'file' && (
                                <>
                                    {(['reference', 'content'] as const).map(
                                        (mode) => (
                                            <button
                                                key={mode}
                                                role="menuitem"
                                                disabled={
                                                    !available ||
                                                    !!attaching ||
                                                    (mode === 'content' &&
                                                        contextEntry.size >
                                                            256 * 1024)
                                                }
                                                title={
                                                    mode === 'reference'
                                                        ? '只引用文件，未附加正文；有未保存编辑时请先保存'
                                                        : '附加已保存的正文，上限 256 KiB；有未保存编辑时请先保存'
                                                }
                                                onClick={() => {
                                                    const target = contextMenu;
                                                    setContextMenu(undefined);
                                                    void attachFile(
                                                        target.rootId,
                                                        contextEntry.path,
                                                        contextEntry.name,
                                                        contextEntry.size,
                                                        mode,
                                                    );
                                                }}
                                            >
                                                <Icon name="attach" />
                                                {mode === 'reference'
                                                    ? '引用文件'
                                                    : '附加内容（≤256 KiB）'}
                                            </button>
                                        ),
                                    )}
                                </>
                            )}
                            {contextEntry.type !== 'symlink' && (
                                <button
                                    role="menuitem"
                                    disabled={!available}
                                    onClick={() => {
                                        const target = contextMenu;
                                        setContextMenu(undefined);
                                        download(
                                            target.rootId,
                                            contextEntry.path,
                                            contextEntry.size,
                                            contextEntry.type === 'directory'
                                                ? 'zip'
                                                : undefined,
                                        );
                                    }}
                                >
                                    <Icon name="download" />
                                    {contextEntry.type === 'directory'
                                        ? '下载文件夹（ZIP）'
                                        : '下载'}
                                </button>
                            )}
                            <div role="separator" />
                            {(['rename', 'move'] as const).map((kind) => (
                                <button
                                    key={kind}
                                    role="menuitem"
                                    disabled={
                                        !canWrite(contextMenu.rootId) ||
                                        contextEntry.type === 'symlink'
                                    }
                                    onClick={() => {
                                        const target = contextMenu;
                                        setContextMenu(undefined);
                                        void beginAction(
                                            kind,
                                            target.rootId,
                                            contextEntry,
                                        );
                                    }}
                                >
                                    <Icon
                                        name={
                                            kind === 'rename' ? 'edit' : 'move'
                                        }
                                    />
                                    {kind === 'rename' ? '重命名' : '移动'}
                                </button>
                            ))}
                            <button
                                role="menuitem"
                                onClick={() => {
                                    setContextMenu(undefined);
                                    void copy(contextEntry.path);
                                }}
                            >
                                <Icon name="copy" />
                                复制相对路径
                            </button>
                            <button
                                role="menuitem"
                                className="danger-text"
                                disabled={
                                    !canWrite(contextMenu.rootId) ||
                                    contextEntry.type === 'symlink'
                                }
                                onClick={() => {
                                    const target = contextMenu;
                                    setContextMenu(undefined);
                                    void beginAction(
                                        'delete',
                                        target.rootId,
                                        contextEntry,
                                    );
                                }}
                            >
                                <Icon name="trash" />
                                删除…
                            </button>
                        </>
                    )}
                </FileContextMenu>
            )}

            <div
                ref={workspace}
                className="workspace"
                data-resizing={resizing || undefined}
                style={
                    { '--tree-pane-width': `${treeWidth}px` } as CSSProperties
                }
            >
                <section
                    id="directory-panel"
                    className="directory-panel"
                    aria-label="文件列表"
                >
                    {rootsError && (
                        <div className="list-error" role="alert">
                            <p>{rootsError}</p>
                            <button onClick={() => void loadRoots()}>
                                重试
                            </button>
                        </div>
                    )}
                    <DirectoryTree
                        tree={tree}
                        available={available}
                        activePath={
                            activeTab?.rootId === rootId
                                ? activeTab.path
                                : undefined
                        }
                        selectedPath={selected?.path}
                        interactionEpoch={actionIntent.current}
                        uploadAllowed={canWrite(rootId)}
                        onUpload={(files, path) =>
                            chooseFiles(files, rootId, path)
                        }
                        onPasteFiles={(files, path) =>
                            chooseFiles(files, rootId, path)
                        }
                        onDirectoryDrop={() =>
                            setNotice({
                                kind: 'error',
                                text: '文件夹拖放/粘贴暂不支持。请在目录菜单选择“上传文件夹”；浏览器未提供的空目录不会上传。',
                            })
                        }
                        onSelect={selectEntry}
                        onOpen={openEntry}
                        onMenu={(entry, trigger, x, y) =>
                            showContextMenu(
                                { kind: 'entry', entry },
                                trigger,
                                x,
                                y,
                            )
                        }
                        onBlankMenu={(trigger, x, y) =>
                            showContextMenu(
                                { kind: 'folder', directory: '' },
                                trigger,
                                x,
                                y,
                            )
                        }
                        creation={
                            creation?.rootId === rootId ? creation : undefined
                        }
                        onCreationName={(name) => {
                            const creation = creationRef.current;
                            if (creation && !creation.busy)
                                setCreation({ ...creation, name });
                        }}
                        onCreationSubmit={() => void submitCreation()}
                        onCreationCancel={() => cancelCreation(true)}
                        entryIcon={entryIcon}
                    />
                </section>

                <div
                    className="pane-separator"
                    role="separator"
                    aria-label="文件列表宽度"
                    aria-orientation="vertical"
                    aria-controls="directory-panel"
                    aria-valuemin={MIN_TREE_WIDTH}
                    aria-valuemax={maxTreeWidth}
                    aria-valuenow={treeWidth}
                    tabIndex={0}
                    title="拖动或使用左右方向键调整宽度，双击恢复默认"
                    onPointerDown={(event) => {
                        if (!event.isPrimary || event.button !== 0) return;
                        event.preventDefault();
                        event.currentTarget.focus();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        resizeGesture.current = {
                            element: event.currentTarget,
                            pointerId: event.pointerId,
                            startX: event.clientX,
                            startWidth: treeWidth,
                        };
                        setResizing(true);
                    }}
                    onPointerMove={(event) => {
                        const gesture = resizeGesture.current;
                        if (!gesture || gesture.pointerId !== event.pointerId)
                            return;
                        setRequestedTreeWidth(
                            Math.min(
                                maxTreeWidth,
                                Math.max(
                                    MIN_TREE_WIDTH,
                                    gesture.startWidth +
                                        event.clientX -
                                        gesture.startX,
                                ),
                            ),
                        );
                    }}
                    onPointerUp={finishResize}
                    onPointerCancel={finishResize}
                    onLostPointerCapture={finishResize}
                    onDoubleClick={() =>
                        setRequestedTreeWidth(DEFAULT_TREE_WIDTH)
                    }
                    onKeyDown={(event) => {
                        let next: number;
                        const step = event.shiftKey ? 50 : 10;
                        switch (event.key) {
                            case 'ArrowLeft':
                                next = treeWidth - step;
                                break;
                            case 'ArrowRight':
                                next = treeWidth + step;
                                break;
                            case 'Home':
                                next = MIN_TREE_WIDTH;
                                break;
                            case 'End':
                                next = maxTreeWidth;
                                break;
                            default:
                                return;
                        }
                        event.preventDefault();
                        setRequestedTreeWidth(
                            Math.min(
                                maxTreeWidth,
                                Math.max(MIN_TREE_WIDTH, next),
                            ),
                        );
                    }}
                />

                <section
                    id="editor-section"
                    className="editor-section"
                    aria-label="编辑器"
                >
                    {tabs.length > 0 && (
                        <div
                            className="tab-list"
                            role="tablist"
                            aria-label="文件标签"
                        >
                            {tabs.map((tab) => (
                                <div
                                    key={tab.id}
                                    className={`file-tab ${activeTabId === tab.id ? 'active' : ''}`}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        showTabMenu(
                                            tab.id,
                                            event.currentTarget.querySelector<HTMLElement>(
                                                '[role="tab"]',
                                            )!,
                                            event.clientX,
                                            event.clientY,
                                        );
                                    }}
                                >
                                    <button
                                        id={`${tab.id}-label`}
                                        role="tab"
                                        aria-selected={activeTabId === tab.id}
                                        aria-controls={`${tab.id}-panel`}
                                        tabIndex={
                                            activeTabId === tab.id ? 0 : -1
                                        }
                                        title={`${tab.rootId}:/${tab.path}${isDirty(tab) ? '（未保存）' : ''}`}
                                        onClick={() => {
                                            revealTab(tab);
                                        }}
                                        onKeyDown={(event) => {
                                            if (
                                                event.key === 'ContextMenu' ||
                                                (event.shiftKey &&
                                                    event.key === 'F10')
                                            ) {
                                                event.preventDefault();
                                                const bounds =
                                                    event.currentTarget.getBoundingClientRect();
                                                showTabMenu(
                                                    tab.id,
                                                    event.currentTarget,
                                                    bounds.left,
                                                    bounds.bottom,
                                                );
                                                return;
                                            }
                                            if (
                                                ![
                                                    'ArrowLeft',
                                                    'ArrowRight',
                                                    'Home',
                                                    'End',
                                                ].includes(event.key)
                                            )
                                                return;
                                            event.preventDefault();
                                            const index = tabs.findIndex(
                                                (item) => item.id === tab.id,
                                            );
                                            let next =
                                                index +
                                                (event.key === 'ArrowRight'
                                                    ? 1
                                                    : -1);
                                            if (event.key === 'Home') next = 0;
                                            if (event.key === 'End')
                                                next = tabs.length - 1;
                                            const target =
                                                tabs[
                                                    (next + tabs.length) %
                                                        tabs.length
                                                ];
                                            revealTab(target);
                                            document
                                                .getElementById(
                                                    `${target.id}-label`,
                                                )
                                                ?.focus();
                                        }}
                                    >
                                        <Icon
                                            name={
                                                tab.kind === 'text'
                                                    ? 'code'
                                                    : tab.kind === 'image'
                                                      ? 'image'
                                                      : 'file'
                                            }
                                            size={14}
                                        />
                                        <span className="tab-name">
                                            {tab.name}
                                        </span>
                                        {tab.readOnly && (
                                            <Icon name="lock" size={11} />
                                        )}
                                        {isDirty(tab) && (
                                            <span
                                                className="dirty-dot"
                                                aria-label="未保存"
                                            />
                                        )}
                                    </button>
                                    <button
                                        className="tab-close icon-button"
                                        title={`关闭 ${tab.name}`}
                                        aria-label={`关闭 ${tab.name}`}
                                        disabled={tabBusy(tab)}
                                        onClick={() => closeTabs([tab])}
                                    >
                                        <Icon name="close" size={12} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    {activeTab && (
                        <div
                            className="editor-toolbar"
                            role="toolbar"
                            aria-label="编辑操作"
                        >
                            {activeTab.readOnly && (
                                <span className="readonly-label">只读</span>
                            )}
                            {activeTab.kind === 'text' && (
                                <>
                                    {hasMarkdownPreview(activeTab) && (
                                        <div
                                            className="preview-segment"
                                            role="group"
                                            aria-label="Markdown 视图"
                                        >
                                            <button
                                                aria-pressed={
                                                    !activeTab.preview
                                                }
                                                onClick={() =>
                                                    updateTab(activeTab.id, {
                                                        preview: false,
                                                    })
                                                }
                                            >
                                                编辑
                                            </button>
                                            <button
                                                aria-pressed={
                                                    !!activeTab.preview
                                                }
                                                title="预览当前草稿，包括未保存内容"
                                                onClick={() =>
                                                    updateTab(activeTab.id, {
                                                        preview: true,
                                                    })
                                                }
                                            >
                                                预览
                                            </button>
                                        </div>
                                    )}
                                    <IconButton
                                        name="search"
                                        title="查找与替换（Ctrl/Cmd+F）"
                                        disabled={
                                            hasMarkdownPreview(activeTab) &&
                                            activeTab.preview
                                        }
                                        onClick={() => editorCommand('search')}
                                    />
                                    <IconButton
                                        name="undo"
                                        title="撤销（Ctrl/Cmd+Z）"
                                        disabled={
                                            !available ||
                                            activeTab.readOnly ||
                                            (hasMarkdownPreview(activeTab) &&
                                                activeTab.preview)
                                        }
                                        onClick={() => editorCommand('undo')}
                                    />
                                    <button
                                        className="primary save-button"
                                        title="保存（Ctrl/Cmd+S）"
                                        disabled={
                                            !available ||
                                            activeTab.readOnly ||
                                            !canWrite(activeTab.rootId) ||
                                            activeTab.busy ||
                                            activeTab.conflict ||
                                            !isDirty(activeTab)
                                        }
                                        onClick={() =>
                                            void saveTab(activeTab.id)
                                        }
                                    >
                                        <Icon name="save" size={14} />
                                        {activeTab.busy ? '处理中' : '保存'}
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                className="attach-button"
                                disabled={
                                    !available ||
                                    !!attaching ||
                                    activeTab.busy ||
                                    isDirty(activeTab)
                                }
                                title={
                                    isDirty(activeTab)
                                        ? '请先保存编辑，再引用文件；不会自动保存'
                                        : '只引用文件，未附加正文；不会自动发送'
                                }
                                onClick={() =>
                                    void attachFile(
                                        activeTab.rootId,
                                        activeTab.path,
                                        activeTab.name,
                                        activeTab.size,
                                    )
                                }
                            >
                                <Icon name="attach" size={14} />
                                {attaching?.rootId === activeTab.rootId &&
                                attaching.path === activeTab.path
                                    ? '添加中…'
                                    : isDirty(activeTab)
                                      ? '先保存再引用'
                                      : '引用文件'}
                            </button>
                            <div className="menu-anchor">
                                <IconButton
                                    name="more"
                                    title="更多编辑操作"
                                    aria-haspopup="menu"
                                    aria-expanded={menu === 'editor'}
                                    onClick={() =>
                                        setMenu(
                                            menu === 'editor' ? null : 'editor',
                                        )
                                    }
                                />
                                {menu === 'editor' && (
                                    <Menu
                                        label="更多编辑操作"
                                        onClose={() => setMenu(null)}
                                    >
                                        <button
                                            role="menuitem"
                                            disabled={
                                                !available ||
                                                !!attaching ||
                                                activeTab.busy ||
                                                isDirty(activeTab) ||
                                                activeTab.size > 256 * 1024
                                            }
                                            title="附加已保存的内容，上限 256 KiB；不会自动保存或发送"
                                            onClick={() =>
                                                fileMenuAction(
                                                    () =>
                                                        void attachFile(
                                                            activeTab.rootId,
                                                            activeTab.path,
                                                            activeTab.name,
                                                            activeTab.size,
                                                            'content',
                                                        ),
                                                )
                                            }
                                        >
                                            <Icon name="attach" />
                                            附加内容（≤256 KiB）
                                        </button>
                                        {activeTab.kind === 'text' && (
                                            <>
                                                <button
                                                    role="menuitem"
                                                    disabled={
                                                        !available ||
                                                        activeTab.readOnly
                                                    }
                                                    onClick={() =>
                                                        fileMenuAction(() =>
                                                            editorCommand(
                                                                'redo',
                                                            ),
                                                        )
                                                    }
                                                >
                                                    <Icon name="redo" />
                                                    重做
                                                </button>
                                                <button
                                                    role="menuitem"
                                                    onClick={() =>
                                                        fileMenuAction(
                                                            () =>
                                                                void copy(
                                                                    activeTab.text,
                                                                ),
                                                        )
                                                    }
                                                >
                                                    <Icon name="copy" />
                                                    {activeTab.readOnly
                                                        ? '复制完整文本'
                                                        : '复制完整草稿'}
                                                </button>
                                                <button
                                                    role="menuitem"
                                                    disabled={
                                                        !available ||
                                                        activeTab.busy
                                                    }
                                                    onClick={() =>
                                                        fileMenuAction(() =>
                                                            beginReread(
                                                                activeTab,
                                                            ),
                                                        )
                                                    }
                                                >
                                                    <Icon name="refresh" />
                                                    重新读取…
                                                </button>
                                            </>
                                        )}
                                        <button
                                            role="menuitem"
                                            disabled={!available}
                                            onClick={() =>
                                                fileMenuAction(() =>
                                                    download(
                                                        activeTab.rootId,
                                                        activeTab.path,
                                                        activeTab.size,
                                                    ),
                                                )
                                            }
                                        >
                                            <Icon name="download" />
                                            下载服务器文件
                                        </button>
                                    </Menu>
                                )}
                            </div>
                        </div>
                    )}
                    {!tabs.length && (
                        <div className="empty-state">
                            <Icon name="file" size={28} />
                            <span>从左侧目录树打开文件</span>
                        </div>
                    )}
                    {tabs.map((tab) => (
                        <div
                            key={tab.id}
                            id={`${tab.id}-panel`}
                            role="tabpanel"
                            aria-labelledby={`${tab.id}-label`}
                            hidden={activeTabId !== tab.id}
                            className="tab-panel"
                        >
                            {tab.conflict ? (
                                <div className="conflict-banner" role="alert">
                                    <span>文件已更改，草稿已保留。</span>
                                    <button onClick={() => void copy(tab.text)}>
                                        复制草稿
                                    </button>
                                    <button
                                        disabled={!available || tab.busy}
                                        onClick={() => beginReread(tab)}
                                    >
                                        重新读取
                                    </button>
                                </div>
                            ) : (
                                tab.error && (
                                    <div className="inline-error" role="alert">
                                        {tab.error}
                                    </div>
                                )
                            )}
                            {tab.kind === 'text' ? (
                                <>
                                    <div
                                        className="text-editor-pane"
                                        hidden={
                                            hasMarkdownPreview(tab) &&
                                            tab.preview
                                        }
                                    >
                                        <TextEditor
                                            id={tab.id}
                                            name={tab.name}
                                            text={tab.text}
                                            size={tab.size}
                                            revision={tab.revision}
                                            active={
                                                activeTabId === tab.id &&
                                                mobilePane === 'editor' &&
                                                !(
                                                    hasMarkdownPreview(tab) &&
                                                    tab.preview
                                                )
                                            }
                                            readOnly={
                                                tab.readOnly ||
                                                !canWrite(tab.rootId)
                                            }
                                            onChange={(text) => {
                                                if (
                                                    !tab.readOnly &&
                                                    canWrite(tab.rootId)
                                                )
                                                    updateTab(tab.id, { text });
                                            }}
                                            onSave={() => void saveTab(tab.id)}
                                            onView={onView}
                                        />
                                    </div>
                                    {hasMarkdownPreview(tab) && tab.preview && (
                                        <MarkdownPreview text={tab.text} />
                                    )}
                                </>
                            ) : tab.kind === 'pending' ? (
                                <div className="empty-state binary-state">
                                    <Icon name="file" size={32} />
                                    <span>
                                        {tab.name} · {formatSize(tab.size)}
                                    </span>
                                    <span>
                                        {tab.busy
                                            ? '正在检查或读取文件…'
                                            : tab.size > TEXT_PREVIEW_LIMIT
                                              ? '文件达到 5 MiB，不支持在线文本预览，请下载查看。'
                                              : '文件较大，点击后尝试文本读取。超过 2 MiB 的文本仅供只读查看。'}
                                    </span>
                                    {tab.size <= TEXT_PREVIEW_LIMIT && (
                                        <button
                                            disabled={!available || tab.busy}
                                            onClick={() =>
                                                void loadText(tab, true)
                                            }
                                        >
                                            {tab.busy ? '加载中…' : '加载文本'}
                                        </button>
                                    )}
                                    <button
                                        disabled={!available}
                                        onClick={() =>
                                            download(
                                                tab.rootId,
                                                tab.path,
                                                tab.size,
                                            )
                                        }
                                    >
                                        <Icon name="download" />
                                        下载文件
                                    </button>
                                </div>
                            ) : tab.kind === 'image' && tab.image ? (
                                <div className="image-preview">
                                    <img
                                        src={tab.image}
                                        alt={tab.name}
                                        onError={() =>
                                            updateTab(tab.id, {
                                                image: undefined,
                                                error: '无法解码图片，请下载查看。',
                                            })
                                        }
                                    />
                                    <span>
                                        {tab.name} · {formatSize(tab.size)}
                                    </span>
                                </div>
                            ) : (
                                <div className="empty-state binary-state">
                                    <Icon
                                        name={
                                            tab.kind === 'image'
                                                ? 'image'
                                                : 'file'
                                        }
                                        size={32}
                                    />
                                    <span>
                                        {tab.kind === 'image'
                                            ? '无法预览图片'
                                            : '此文件不支持文本预览或编辑'}
                                    </span>
                                    <button
                                        disabled={!available}
                                        onClick={() =>
                                            download(
                                                tab.rootId,
                                                tab.path,
                                                tab.size,
                                            )
                                        }
                                    >
                                        <Icon name="download" />
                                        下载文件 · {formatSize(tab.size)}
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </section>
            </div>

            {queueVisible && (
                <section
                    id="transfer-records"
                    className={`transfers ${showTransfers ? 'expanded' : ''}`}
                    aria-label="传输队列"
                >
                    <div className="transfer-heading">
                        <button
                            className="transfer-toggle"
                            aria-expanded={showTransfers}
                            onClick={() => setShowTransfers((value) => !value)}
                        >
                            <Icon name="transfers" size={14} />
                            <span>
                                传输
                                {activeTransfers ? ` · ${activeTransfers}` : ''}
                            </span>
                            {transferErrors && (
                                <span className="queue-attention">需处理</span>
                            )}
                            <Icon
                                name={showTransfers ? 'down' : 'chevron'}
                                size={12}
                            />
                        </button>
                        {showTransfers && (
                            <>
                                <button
                                    className="text-button"
                                    onClick={() => {
                                        void transfers.clearFinished();
                                        if (!activeTransfers)
                                            setShowTransfers(false);
                                    }}
                                >
                                    清除已结束
                                </button>
                                <IconButton
                                    name="close"
                                    title="收起传输记录"
                                    onClick={() => setShowTransfers(false)}
                                />
                            </>
                        )}
                    </div>
                    {showTransfers && (
                        <div className="transfer-body">
                            {!transfers.jobs.length && (
                                <span className="transfer-empty">暂无传输</span>
                            )}
                            {transfers.jobs.map((job) => (
                                <div
                                    key={job.id}
                                    className={`transfer-item ${job.status}`}
                                >
                                    <Icon
                                        name={
                                            job.direction === 'upload'
                                                ? 'upload'
                                                : 'download'
                                        }
                                        size={15}
                                    />
                                    <div className="transfer-description">
                                        <div className="transfer-title">
                                            <strong
                                                title={`${job.rootId}:/${job.path}`}
                                            >
                                                {job.name}
                                            </strong>
                                            <span
                                                role="status"
                                                aria-live="polite"
                                            >
                                                {job.direction === 'download' &&
                                                job.status === 'done'
                                                    ? '传输结束，请检查浏览器下载记录'
                                                    : job.direction ===
                                                            'download' &&
                                                        job.status ===
                                                            'running' &&
                                                        job.loaded === job.size
                                                      ? '响应流已传输，等待宿主完整性校验…'
                                                      : transferLabels[
                                                            job.status
                                                        ]}
                                            </span>
                                        </div>
                                        <progress
                                            max={job.size || 1}
                                            value={
                                                [
                                                    'queued',
                                                    'checking',
                                                    'preparing',
                                                    'finishing',
                                                    'cancelling',
                                                    'saving',
                                                ].includes(job.status)
                                                    ? undefined
                                                    : [
                                                            'done',
                                                            'handed-off',
                                                        ].includes(job.status)
                                                      ? job.size || 1
                                                      : job.loaded
                                            }
                                            aria-label={`${job.name} 传输进度`}
                                        />
                                        <div className="transfer-meta">
                                            {job.status === 'preparing'
                                                ? '正在准备源文件快照，尚未开始传输。'
                                                : `${formatSize(job.loaded)} / ${formatSize(job.size)}${job.size > 0 ? ` · ${Math.floor((job.loaded / job.size) * 100)}%` : ''}`}
                                            {job.status === 'ready' &&
                                                ' · 浏览器尚未开始接收；可点击“手动开始下载”。'}
                                            {job.direction === 'download' &&
                                                job.status === 'done' &&
                                                ' · 宿主已校验响应流，不代表文件已写入本地磁盘。'}
                                            {job.status === 'handed-off' &&
                                                ' · 是否保存成功请查看浏览器下载记录。'}
                                        </div>
                                        {job.status === 'confirm' && (
                                            <div className="upload-confirm">
                                                <span>文件已存在</span>
                                                <button
                                                    disabled={!available}
                                                    onClick={() =>
                                                        transfers.retry(
                                                            job.id,
                                                            true,
                                                        )
                                                    }
                                                >
                                                    确认覆盖
                                                </button>
                                            </div>
                                        )}
                                        {job.error && (
                                            <p
                                                className="transfer-error"
                                                role="alert"
                                            >
                                                {job.error}
                                            </p>
                                        )}
                                    </div>
                                    <div className="transfer-actions">
                                        {['unknown', 'verifying'].includes(
                                            job.status,
                                        ) && (
                                            <button
                                                disabled={
                                                    !job.transferId ||
                                                    job.status === 'verifying'
                                                }
                                                onClick={() =>
                                                    void transfers.verify(
                                                        job.id,
                                                    )
                                                }
                                            >
                                                核实状态（只读）
                                            </button>
                                        )}
                                        {job.status === 'ready' && (
                                            <>
                                                <button
                                                    disabled={!available}
                                                    onClick={() =>
                                                        void transfers.save(
                                                            job.id,
                                                        )
                                                    }
                                                >
                                                    手动开始下载
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        void transfers.cancel(
                                                            job.id,
                                                        )
                                                    }
                                                >
                                                    丢弃
                                                </button>
                                            </>
                                        )}
                                        {transferActive(job) &&
                                            job.status !== 'ready' && (
                                                <IconButton
                                                    name="close"
                                                    title={
                                                        job.status ===
                                                        'finishing'
                                                            ? '提交阶段不可取消'
                                                            : '取消传输'
                                                    }
                                                    disabled={
                                                        job.status ===
                                                            'finishing' ||
                                                        job.status ===
                                                            'cancelling' ||
                                                        job.status === 'saving'
                                                    }
                                                    onClick={() =>
                                                        void transfers.cancel(
                                                            job.id,
                                                        )
                                                    }
                                                />
                                            )}
                                        {(['error', 'cancelled'].includes(
                                            job.status,
                                        ) ||
                                            (job.status === 'handed-off' &&
                                                job.direction ===
                                                    'download')) && (
                                            <IconButton
                                                name="refresh"
                                                title="重试传输（重新检查目标）"
                                                disabled={
                                                    !available ||
                                                    (job.direction ===
                                                        'upload' &&
                                                        (job.invalidUpload ||
                                                            job.size >
                                                                MAX_FILE_SIZE))
                                                }
                                                onClick={() =>
                                                    transfers.retry(job.id)
                                                }
                                            />
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            )}
            {dialog && (
                <Modal
                    key={dialog.kind}
                    title={dialogTitles[dialog.kind]}
                    busy={dialogBusy}
                    onClose={() => {
                        setDialog(undefined);
                        setDialogError('');
                    }}
                >
                    {dialog.kind === 'copy' ? (
                        <>
                            <p className="modal-description">
                                宿主剪贴板暂不可用。请选中文本，使用 Ctrl/Cmd+C
                                复制。
                            </p>
                            <textarea
                                className="copy-content"
                                aria-label="待复制内容"
                                data-autofocus
                                readOnly
                                value={dialog.text}
                                onFocus={(event) => event.target.select()}
                            />
                            <div className="modal-actions">
                                <button
                                    className="primary"
                                    onClick={() => setDialog(undefined)}
                                >
                                    完成
                                </button>
                            </div>
                        </>
                    ) : (
                        <form
                            onSubmit={(event) => event.preventDefault()}
                            onKeyDown={(event) => {
                                if (
                                    event.key === 'Enter' &&
                                    event.target instanceof HTMLInputElement &&
                                    event.target.type !== 'checkbox'
                                ) {
                                    event.preventDefault();
                                    void submitDialog(event.currentTarget);
                                }
                            }}
                        >
                            {(dialog.kind === 'rename' ||
                                dialog.kind === 'move') && (
                                <>
                                    <p className="modal-description">
                                        当前：{dialog.rootId}:/
                                        {dialog.target.path}
                                        <br />
                                        仅限同一根目录，目标已存在时会拒绝，不会覆盖。
                                    </p>
                                    <label className="field-label">
                                        {dialog.kind === 'rename'
                                            ? '新名称'
                                            : '根目录内的目标相对路径'}
                                        <input
                                            data-autofocus
                                            name="name"
                                            required
                                            autoComplete="off"
                                            defaultValue={
                                                dialog.kind === 'rename'
                                                    ? dialog.target.name
                                                    : dialog.target.path
                                            }
                                            placeholder="例如：资料/文件.md（不以 / 开头）"
                                            disabled={dialogBusy}
                                            onFocus={(event) =>
                                                event.target.select()
                                            }
                                        />
                                    </label>
                                    <p className="field-hint">
                                        已打开的文件标签会跟随新路径，编辑草稿不会丢失。
                                    </p>
                                </>
                            )}
                            {dialog.kind === 'delete' && (
                                <>
                                    <p className="modal-description">
                                        即将删除{' '}
                                        <strong>{dialog.target.name}</strong>
                                        <br />
                                        <span className="path-wrap">
                                            {dialog.rootId}:/
                                            {dialog.target.path}
                                        </span>
                                    </p>
                                    <div className="destructive-warning">
                                        <Icon name="warning" />
                                        <span>
                                            此操作不可撤销，不会移入回收站。
                                        </span>
                                    </div>
                                    {dialog.target.type === 'directory' && (
                                        <label className="checkbox-label">
                                            <input
                                                name="recursive"
                                                type="checkbox"
                                                disabled={dialogBusy}
                                            />
                                            递归删除此文件夹及其全部内容（非空目录必须明确勾选）
                                        </label>
                                    )}
                                    {deleteDrafts.length > 0 && (
                                        <label className="checkbox-label danger-text">
                                            <input
                                                name="discard"
                                                type="checkbox"
                                                required
                                                disabled={dialogBusy}
                                            />
                                            同时丢弃受影响的{' '}
                                            {deleteDrafts.length}{' '}
                                            个未保存草稿并关闭标签
                                        </label>
                                    )}
                                </>
                            )}
                            {dialog.kind === 'close' && (
                                <>
                                    <p className="modal-description">
                                        以下 {closingDrafts.length}{' '}
                                        个文件的修改尚未写入服务器。
                                        关闭后，这些草稿将丢失；取消会保留本次所有标签。
                                    </p>
                                    <ul className="closing-files">
                                        {closingDrafts.map((tab) => (
                                            <li key={tab.id}>
                                                {tab.rootId}:/{tab.path}
                                            </li>
                                        ))}
                                    </ul>
                                    <p className="modal-description">
                                        不会自动保存或修改服务器文件。
                                    </p>
                                    <div className="dialog-secondary-actions">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                closingDrafts.length === 1 &&
                                                void copy(closingDrafts[0].text)
                                            }
                                            disabled={
                                                closingDrafts.length !== 1
                                            }
                                        >
                                            <Icon name="copy" />
                                            复制草稿
                                        </button>
                                    </div>
                                </>
                            )}
                            {dialog.kind === 'reread' && (
                                <>
                                    <p className="modal-description">
                                        将重新读取{' '}
                                        <strong>{dialogTab?.name}</strong>{' '}
                                        的最新服务器内容。
                                        {dialogTab && isDirty(dialogTab)
                                            ? '当前未保存草稿和撤销历史将被替换，请先复制草稿。'
                                            : '编辑器将切换到最新版本，撤销历史会重置。'}
                                    </p>
                                    <div className="dialog-secondary-actions">
                                        <button
                                            type="button"
                                            disabled={dialogBusy}
                                            onClick={() =>
                                                dialogTab &&
                                                void copy(dialogTab.text)
                                            }
                                        >
                                            <Icon name="copy" />
                                            先复制草稿
                                        </button>
                                    </div>
                                </>
                            )}
                            {dialogError && (
                                <div className="dialog-error" role="alert">
                                    {dialogError}
                                </div>
                            )}
                            {(!available ||
                                dialogEpoch.current !==
                                    actionContext.current.epoch) &&
                                dialog.kind !== 'close' && (
                                    <p className="dialog-error">
                                        连接或根目录已变化。草稿已保留，请关闭后重新发起操作。
                                    </p>
                                )}
                            <div className="modal-actions">
                                <button
                                    type="button"
                                    disabled={dialogBusy}
                                    onClick={() => setDialog(undefined)}
                                >
                                    取消
                                </button>
                                <button
                                    className={
                                        dialog.kind === 'delete' ||
                                        dialog.kind === 'close'
                                            ? 'danger-button'
                                            : 'primary'
                                    }
                                    type="button"
                                    onClick={(event) =>
                                        void submitDialog(
                                            event.currentTarget.closest(
                                                'form',
                                            )!,
                                        )
                                    }
                                    disabled={
                                        dialogBusy ||
                                        ((!available ||
                                            dialogEpoch.current !==
                                                actionContext.current.epoch) &&
                                            dialog.kind !== 'close')
                                    }
                                >
                                    {dialogBusy
                                        ? '处理中…'
                                        : dialog.kind === 'close'
                                          ? '丢弃修改并关闭'
                                          : dialog.kind === 'delete'
                                            ? '确认删除'
                                            : dialog.kind === 'reread'
                                              ? '确认重新读取'
                                              : '确认'}
                                </button>
                            </div>
                        </form>
                    )}
                </Modal>
            )}
        </div>
    );
}
