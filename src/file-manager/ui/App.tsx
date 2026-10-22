import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import type { DragEvent } from 'react';
import type { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { bridge, BridgeError, errorMessage } from './bridge';
import { TextEditor } from './Editor';
import { FileContextMenu } from './FileContextMenu';
import { DirectoryTree } from './DirectoryTree';
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

interface TabContents {
    id: string;
    rootId: string;
    name: string;
    kind: 'text' | 'image' | 'binary';
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
}

type FileTab = TabContents &
    (
        | { state: 'saved'; path: string }
        | {
              state: 'draft';
              directory: string;
              fileName: string;
              naming: boolean;
          }
    );

interface FolderCreation {
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
    | { kind: 'close' | 'reread'; tabId: string }
    | { kind: 'copy'; text: string };

const dialogTitles: Record<Dialog['kind'], string> = {
    rename: '重命名',
    move: '移动到同一根目录',
    delete: '确认删除',
    close: '此文件有未保存的修改',
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
    return (
        tab.kind === 'text' &&
        (tab.text !== tab.savedText ||
            (tab.state === 'draft' && tab.fileName.length > 0))
    );
}

function affected(tab: FileTab, rootId: string, path: string) {
    return (
        tab.rootId === rootId &&
        withinPath(tab.state === 'draft' ? tab.directory : tab.path, path)
    );
}

function entryIcon(entry: Pick<Entry, 'type' | 'name'>): IconName {
    if (entry.type === 'directory') return 'folder';
    if (entry.type === 'symlink') return 'link';
    if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(entry.name))
        return 'image';
    if (/\.(json|md|html?|svg|[jt]sx?|css|xml)$/i.test(entry.name))
        return 'code';
    return 'file';
}

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
        { rootId: string; path: string; includeDirectory?: boolean } | undefined
    >(undefined);
    const [mobileView, setMobileView] = useState<'files' | 'editor'>('files');
    const [opening, setOpening] = useState(false);
    const openingPaths = useRef(new Set<string>());
    const savingTabs = useRef(new Set<string>());
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
    const [notice, setNotice] = useState<{
        kind: 'error' | 'success' | 'info';
        text: string;
    }>();
    const [folderCreation, setFolderCreationState] = useState<FolderCreation>();
    const folderCreationRef = useRef(folderCreation);
    const setFolderCreation = (next: FolderCreation | undefined) => {
        folderCreationRef.current = next;
        setFolderCreationState(next);
    };
    const cancelFolderCreation = (restoreFocus = false) => {
        const trigger = folderCreationRef.current?.trigger;
        setFolderCreation(undefined);
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
    const [menu, setMenu] = useState<'files' | 'editor' | null>(null);
    const [dragging, setDragging] = useState(false);
    const dragDepth = useRef(0);
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
        cancelFolderCreation();
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
        if (mobilePane === 'editor') cancelFolderCreation();
        actionIntent.current++;
        setStatLoading(false);
    }, [rootId, available, mobilePane]);

    useEffect(() => {
        cancelFolderCreation();
    }, [rootId, available]);

    useEffect(() => {
        if (folderCreation && !canWrite(folderCreation.rootId))
            cancelFolderCreation();
    }, [roots]);

    // Visibility changes must not recreate editors or discard selection/undo history.
    useEffect(() => {
        if (mobilePane === 'editor') {
            views.current.get(activeTabId)?.requestMeasure();
        }
    }, [mobilePane, activeTabId]);

    const selectEntry = (entry: Entry) => {
        cancelFolderCreation();
        actionIntent.current++;
        setStatLoading(false);
        setContextMenu(undefined);
        setSelected(entry);
        setDirectory(
            entry.type === 'directory' ? entry.path : parentPath(entry.path),
        );
    };

    // Navigation chooses a mutation/upload destination; the tree root is fixed.
    const navigate = (path: string, nextRoot = rootId) => {
        cancelFolderCreation();
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
        cancelFolderCreation();
        actionIntent.current++;
        setStatLoading(false);
        setContextMenu(undefined);
        setActiveTabId(tab.id);
        setMobileView('editor');
        const parent =
            tab.state === 'draft' ? tab.directory : parentPath(tab.path);
        const revealPath = tab.state === 'draft' ? tab.directory : tab.path;
        setDirectory(parent);
        if (tab.rootId !== rootId) {
            pendingTabReveal.current = {
                rootId: tab.rootId,
                path: revealPath,
                includeDirectory: tab.state === 'draft',
            };
            setRootId(tab.rootId);
        } else tree.reveal(revealPath, tab.state === 'draft');
        setSelected(
            tab.state === 'saved'
                ? {
                      name: tab.name,
                      path: tab.path,
                      type: 'file',
                      size: tab.size,
                      mtime: '',
                  }
                : undefined,
        );
    };

    // A tab explicitly activated across roots may reveal ancestors after the
    // new cache exists. A root-selector change itself loads only the root.
    useEffect(() => {
        const pending = pendingTabReveal.current;
        if (pending?.rootId === rootId) {
            tree.reveal(pending.path, pending.includeDirectory);
            pendingTabReveal.current = undefined;
        }
    }, [rootId]);

    const updateTab = useCallback((id: string, patch: Partial<TabContents>) => {
        setTabs((current) =>
            current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
        );
    }, []);

    const updateDraft = (
        id: string,
        patch: { fileName?: string; naming?: boolean },
    ) => {
        setTabs((current) =>
            current.map((tab) =>
                tab.id === id && tab.state === 'draft'
                    ? { ...tab, ...patch }
                    : tab,
            ),
        );
    };

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

    const openPath = async (
        targetRoot: string,
        path: string,
        entry?: Entry,
    ) => {
        const existing = tabsRef.current.find(
            (tab) =>
                tab.state === 'saved' &&
                tab.rootId === targetRoot &&
                tab.path === path,
        );
        if (existing) {
            revealTab(existing);
            return;
        }
        const key = `${targetRoot}\0${path}`;
        if (openingPaths.current.has(key)) return;
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
            const image = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(path);
            const tab: FileTab = {
                id: `tab-${++tabSequence.current}`,
                state: 'saved',
                rootId: targetRoot,
                path,
                name: fileName(path),
                kind: 'binary',
                text: '',
                savedText: '',
                version: '',
                encoding: '',
                size: entry?.size ?? 0,
                readOnly: !!roots.find((item) => item.rootId === targetRoot)
                    ?.readOnly,
                revision: 0,
            };
            if (!image && (entry?.size ?? 0) <= 2 * 1024 * 1024) {
                try {
                    const result = await bridge.request<TextResult>(
                        'readText',
                        {
                            rootId: targetRoot,
                            path,
                        },
                    );
                    Object.assign(tab, {
                        kind: 'text',
                        text: result.text,
                        savedText: result.text,
                        version: result.version,
                        encoding: result.encoding,
                        size: result.size,
                    });
                } catch (error) {
                    if (
                        error instanceof BridgeError &&
                        [
                            'TOO_LARGE',
                            'BINARY_FILE',
                            'NOT_TEXT',
                            'UNSUPPORTED_ENCODING',
                        ].includes(error.code)
                    ) {
                        tab.error = errorMessage(error);
                    } else throw error;
                }
            } else if (image) {
                tab.kind = 'image';
                try {
                    const result = await bridge.request<{
                        mimeType: string;
                        data: string;
                    }>('preview', { rootId: targetRoot, path });
                    if (
                        ![
                            'image/png',
                            'image/jpeg',
                            'image/gif',
                            'image/webp',
                            'image/avif',
                            'image/bmp',
                            'image/x-icon',
                        ].includes(result.mimeType)
                    ) {
                        throw new Error(
                            '该图片类型不支持安全预览，请下载查看。',
                        );
                    }
                    tab.image = `data:${result.mimeType};base64,${result.data}`;
                } catch (error) {
                    tab.error = errorMessage(error);
                }
            }
            setTabs((current) => [...current, tab]);
            setActiveTabId(tab.id);
            setMobileView('editor');
        } catch (error) {
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
            !canWrite(tab.rootId) ||
            (tab.state === 'saved' && !isDirty(tab))
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
        if (tab.state === 'draft' && !tab.naming) {
            updateDraft(id, { naming: true });
            return;
        }
        if (tab.conflict) {
            setNotice({
                kind: 'error',
                text: '文件存在版本冲突，请先复制草稿或重新读取。不会强制覆盖服务器文件。',
            });
            return;
        }
        const text = tab.text;
        const name = tab.state === 'draft' ? tab.fileName : tab.name;
        if (
            tab.state === 'draft' &&
            (!name.trim() ||
                /[\/\\]/.test(name) ||
                name === '.' ||
                name === '..')
        ) {
            updateTab(id, {
                error: '请输入文件名，不含目录分隔符。保存位置在创建时已固定。',
            });
            document.getElementById(`${id}-filename`)?.focus();
            return;
        }
        if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) {
            updateTab(id, { error: '文本编辑上限为 2 MiB，正文已保留。' });
            return;
        }
        const path =
            tab.state === 'draft' ? joinPath(tab.directory, name) : tab.path;
        savingTabs.current.add(id);
        updateTab(id, { busy: true, error: undefined });
        try {
            const result = await bridge.request<{
                version: string;
                size?: number;
            }>(tab.state === 'draft' ? 'createFile' : 'saveText', {
                rootId: tab.rootId,
                path,
                text,
                ...(tab.state === 'saved'
                    ? { expectedVersion: tab.version }
                    : {}),
            });
            // Keep the stable editor identity and current text/undo. The server
            // saved this request's snapshot, not edits made while it was in flight.
            setTabs((current) =>
                current.map((item): FileTab => {
                    if (item.id !== id) return item;
                    const contents: TabContents = {
                        id: item.id,
                        rootId: item.rootId,
                        name,
                        kind: item.kind,
                        text: item.text,
                        savedText: text,
                        version: result.version,
                        encoding: item.encoding,
                        size:
                            result.size ??
                            new TextEncoder().encode(text).byteLength,
                        readOnly: item.readOnly,
                        revision: item.revision,
                        busy: item.busy,
                        conflict: false,
                        error: undefined,
                    };
                    return { ...contents, state: 'saved', path };
                }),
            );
            setNotice({ kind: 'success', text: `已保存 ${name}` });
            treeRef.current.refreshDirectory(tab.rootId, parentPath(path));
        } catch (error) {
            updateTab(id, {
                error: errorMessage(error),
                conflict:
                    tab.state === 'saved' &&
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

    const removeTab = (id: string) => {
        setTabs((current) => {
            const remaining = current.filter((tab) => tab.id !== id);
            if (activeTabId === id) {
                const index = current.findIndex((tab) => tab.id === id);
                setActiveTabId(
                    remaining[Math.min(index, remaining.length - 1)]?.id ?? '',
                );
            }
            return remaining;
        });
    };

    const closeTab = (tab: FileTab) => {
        if (tab.busy) return;
        if (isDirty(tab)) {
            setDialog({ kind: 'close', tabId: tab.id });
            setDialogError('');
        } else removeTab(tab.id);
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
        cancelFolderCreation();
        actionIntent.current++;
        setStatLoading(false);
        setMenu(null);
        if (target.kind === 'entry') selectEntry(target.entry);
        setContextMenu({ rootId, target, trigger, x, y });
    };

    const attachFile = async (
        targetRoot: string,
        path: string,
        name: string,
        size: number,
    ) => {
        if (!available || attachmentPending.current) return;
        if (
            tabsRef.current.some(
                (tab) =>
                    tab.state === 'saved' &&
                    tab.rootId === targetRoot &&
                    tab.path === path &&
                    isDirty(tab),
            )
        ) {
            setNotice({
                kind: 'error',
                text: `${name} 有未保存的编辑，请先保存后再添加到对话。不会自动保存或附加旧的服务器内容。`,
            });
            return;
        }
        if (size > 256 * 1024) {
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
            });
            if (result.attached !== true)
                throw new Error('宿主未确认添加附件。');
        } catch (error) {
            const message =
                error instanceof BridgeError && error.code === 'TOO_LARGE'
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
        targetRoot = rootId,
        parent = directory,
        trigger?: HTMLElement,
    ) => {
        if (!canWrite(targetRoot)) return;
        cancelFolderCreation();
        actionIntent.current++;
        setStatLoading(false);
        setContextMenu(undefined);
        setMenu(null);
        if (kind === 'mkdir') {
            setMobileView('files');
            tree.reveal(parent, true);
            setFolderCreation({
                rootId: targetRoot,
                directory: parent,
                name: '',
                busy: false,
                trigger,
                epoch: actionContext.current.epoch,
            });
            return;
        }
        const tab: FileTab = {
            id: `tab-${++tabSequence.current}`,
            state: 'draft',
            rootId: targetRoot,
            directory: parent,
            fileName: '',
            naming: false,
            name: `未命名文件 ${tabSequence.current}`,
            kind: 'text',
            text: '',
            savedText: '',
            version: '',
            encoding: 'utf-8',
            size: 0,
            readOnly: false,
            revision: 0,
        };
        setTabs((current) => [...current, tab]);
        setActiveTabId(tab.id);
        setMobileView('editor');
    };

    const submitFolder = async () => {
        const folder = folderCreationRef.current;
        if (
            !folder ||
            folder.busy ||
            !canWrite(folder.rootId) ||
            folder.epoch !== actionContext.current.epoch
        )
            return;
        const name = folder.name;
        if (
            !name.trim() ||
            /[\/\\]/.test(name) ||
            name === '.' ||
            name === '..'
        ) {
            setFolderCreation({
                ...folder,
                error: '请输入文件夹名，不含目录分隔符。',
            });
            return;
        }
        const pending = { ...folder, busy: true, error: undefined };
        setFolderCreation(pending);
        try {
            await bridge.request('mkdir', {
                rootId: folder.rootId,
                path: joinPath(folder.directory, name),
            });
            treeRef.current.refreshDirectory(folder.rootId, folder.directory);
            if (
                folderCreationRef.current !== pending ||
                folder.epoch !== actionContext.current.epoch
            )
                return;
            cancelFolderCreation(true);
            setNotice({ kind: 'success', text: `已创建 ${name}` });
        } catch (error) {
            if (
                folderCreationRef.current === pending &&
                folder.epoch === actionContext.current.epoch
            )
                setFolderCreation({ ...folder, error: errorMessage(error) });
        }
    };

    const beginReread = (tab: FileTab) => {
        if (tab.state === 'draft') return;
        setDialog({ kind: 'reread', tabId: tab.id });
        setDialogError('');
    };

    const submitDialog = async (form: HTMLFormElement) => {
        if (!dialog || dialogBusy || dialog.kind === 'copy') return;
        const fields = new FormData(form);
        setDialogError('');
        if (dialog.kind === 'close') {
            removeTab(dialog.tabId);
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
                            tab.state === 'saved' &&
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
                        if (tab.state === 'draft')
                            return {
                                ...tab,
                                directory: `${to}${tab.directory.slice(dialog.target.path.length)}`,
                            };
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
                        (isDirty(tab) || tab.state === 'draft'),
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
                if (!tab || tab.state === 'draft')
                    throw new Error('文件尚未保存或标签已关闭。');
                const result = await bridge.request<TextResult>('readText', {
                    rootId: tab.rootId,
                    path: tab.path,
                });
                updateTab(tab.id, {
                    text: result.text,
                    savedText: result.text,
                    version: result.version,
                    size: result.size,
                    encoding: result.encoding,
                    conflict: false,
                    error: undefined,
                    revision: tab.revision + 1,
                });
                setDialog(undefined);
                setNotice({ kind: 'success', text: '已重新读取服务器内容。' });
            }
        } catch (error) {
            setDialogError(errorMessage(error));
        } finally {
            setDialogBusy(false);
        }
    };

    const chooseFiles = (files: File[]) => {
        if (!available || readOnly || !rootId) {
            setNotice({
                kind: 'error',
                text: readOnly
                    ? '当前根目录只读，不能上传。'
                    : '连接不可用，不能上传。',
            });
            return;
        }
        if (!files.length) return;
        setShowTransfers(true);
        transfers.upload(files, rootId, directory);
    };

    const drop = (event: DragEvent) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const hasDirectory = Array.from(event.dataTransfer.items).some(
            (item) => item.webkitGetAsEntry?.()?.isDirectory,
        );
        if (hasDirectory) {
            setNotice({
                kind: 'error',
                text: '不支持文件夹拖放。请展开文件夹后选择文件，可一次上传多个。',
            });
            return;
        }
        chooseFiles(Array.from(event.dataTransfer.files));
    };

    const download = (targetRoot: string, path: string, size: number) => {
        setShowTransfers(true);
        transfers.download(targetRoot, path, size);
    };

    const editorCommand = (command: 'undo' | 'redo' | 'search') => {
        const view = views.current.get(activeTabId);
        if (!view) return;
        if (command === 'search') openSearchPanel(view);
        else if (command === 'undo') undo(view);
        else redo(view);
        view.focus();
    };

    const dialogTab =
        dialog && 'tabId' in dialog
            ? tabs.find((tab) => tab.id === dialog.tabId)
            : undefined;
    const deleteDrafts =
        dialog?.kind === 'delete'
            ? tabs.filter(
                  (tab) =>
                      affected(tab, dialog.rootId, dialog.target.path) &&
                      (isDirty(tab) || tab.state === 'draft'),
              )
            : [];

    const transferErrors = transfers.jobs.some((job) =>
        ['error', 'confirm', 'ready'].includes(job.status),
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
            className={`file-app ${dragging ? 'is-dragging' : ''}`}
            data-mobile-view={mobilePane}
            data-has-tabs={tabs.length > 0}
            onDragEnter={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
            }}
            onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                event.dataTransfer.dropEffect =
                    available && !readOnly ? 'copy' : 'none';
            }}
            onDragLeave={(event) => {
                event.preventDefault();
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (!dragDepth.current) setDragging(false);
            }}
            onDrop={drop}
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
                    title={`当前目录：/${directory}；新建和上传到此目录`}
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
                    name="plus"
                    title="新建文件"
                    disabled={!available || readOnly}
                    onClick={() => beginCreate('create')}
                />
                <div className="menu-anchor">
                    <IconButton
                        name="more"
                        title="文件操作"
                        aria-haspopup="menu"
                        aria-expanded={menu === 'files'}
                        onClick={() =>
                            setMenu(menu === 'files' ? null : 'files')
                        }
                    />
                    {menu === 'files' && (
                        <Menu label="文件操作" onClose={() => setMenu(null)}>
                            <button
                                role="menuitem"
                                disabled={!available || readOnly}
                                onClick={() =>
                                    fileMenuAction(() =>
                                        uploadInput.current?.click(),
                                    )
                                }
                            >
                                <Icon name="upload" />
                                上传文件
                            </button>
                            <button
                                role="menuitem"
                                disabled={!available || readOnly}
                                onClick={() =>
                                    fileMenuAction(() => beginCreate('create'))
                                }
                            >
                                <Icon name="file" />
                                新建文件
                            </button>
                            <button
                                role="menuitem"
                                disabled={!available || readOnly}
                                onClick={() =>
                                    fileMenuAction(() => beginCreate('mkdir'))
                                }
                            >
                                <Icon name="folder" />
                                新建文件夹
                            </button>
                            <div role="separator" />
                            <button
                                role="menuitem"
                                onClick={() =>
                                    fileMenuAction(() =>
                                        setShowTransfers((value) => !value),
                                    )
                                }
                            >
                                <Icon name="upload" />
                                传输记录
                                {activeTransfers ? ` · ${activeTransfers}` : ''}
                            </button>
                        </Menu>
                    )}
                </div>
                <input
                    ref={uploadInput}
                    type="file"
                    multiple
                    hidden
                    aria-label="选择上传文件"
                    onChange={(event) => {
                        chooseFiles(Array.from(event.target.files ?? []));
                        event.target.value = '';
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

            {contextMenu && (
                <FileContextMenu
                    label={
                        contextEntry
                            ? `${contextEntry.name} 的操作`
                            : '当前目录的操作'
                    }
                    x={contextMenu.x}
                    y={contextMenu.y}
                    trigger={contextMenu.trigger}
                    onClose={() => setContextMenu(undefined)}
                >
                    {contextDirectory !== undefined &&
                        canWrite(contextMenu.rootId) && (
                            <>
                                <button
                                    role="menuitem"
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
                                    role="menuitem"
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
                                    <button
                                        role="menuitem"
                                        disabled={
                                            !available ||
                                            !!attaching ||
                                            contextEntry.size > 256 * 1024
                                        }
                                        title="添加已保存的文件内容，上限 256 KiB；有未保存编辑时请先保存"
                                        onClick={() => {
                                            const target = contextMenu;
                                            setContextMenu(undefined);
                                            void attachFile(
                                                target.rootId,
                                                contextEntry.path,
                                                contextEntry.name,
                                                contextEntry.size,
                                            );
                                        }}
                                    >
                                        <Icon name="attach" />
                                        {attaching
                                            ? '正在添加…'
                                            : contextEntry.size > 256 * 1024
                                              ? '添加到对话（超过 256 KiB）'
                                              : '添加到对话'}
                                    </button>
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
                                            );
                                        }}
                                    >
                                        <Icon name="download" />
                                        下载
                                    </button>
                                </>
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
                    {!contextEntry && !canWrite(contextMenu.rootId) && (
                        <button role="menuitem" disabled>
                            此目录不可创建
                        </button>
                    )}
                </FileContextMenu>
            )}

            <div className="workspace">
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
                        directory={directory}
                        activePath={
                            activeTab?.rootId === rootId &&
                            activeTab.state === 'saved'
                                ? activeTab.path
                                : undefined
                        }
                        selectedPath={
                            selected?.path ??
                            (activeTab?.rootId === rootId &&
                            activeTab.state === 'saved'
                                ? activeTab.path
                                : undefined)
                        }
                        menuPath={
                            contextMenu?.rootId === rootId
                                ? contextEntry?.path
                                : undefined
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
                                { kind: 'folder', directory },
                                trigger,
                                x,
                                y,
                            )
                        }
                        folderCreation={
                            folderCreation?.rootId === rootId
                                ? folderCreation
                                : undefined
                        }
                        onFolderName={(name) => {
                            const folder = folderCreationRef.current;
                            if (folder && !folder.busy)
                                setFolderCreation({ ...folder, name });
                        }}
                        onFolderSubmit={() => void submitFolder()}
                        onFolderCancel={() => cancelFolderCreation(true)}
                        entryIcon={entryIcon}
                    />
                </section>

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
                                >
                                    <button
                                        id={`${tab.id}-label`}
                                        role="tab"
                                        aria-selected={activeTabId === tab.id}
                                        aria-controls={`${tab.id}-panel`}
                                        tabIndex={
                                            activeTabId === tab.id ? 0 : -1
                                        }
                                        title={`${tab.rootId}:/${tab.state === 'draft' ? tab.directory + '（新文件，尚未保存）' : tab.path}${isDirty(tab) ? '（未保存）' : ''}`}
                                        onClick={() => {
                                            revealTab(tab);
                                        }}
                                        onKeyDown={(event) => {
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
                                        <span>{tab.name}</span>
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
                                        disabled={tab.busy}
                                        onClick={() => closeTab(tab)}
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
                                    <IconButton
                                        name="search"
                                        title="查找与替换（Ctrl/Cmd+F）"
                                        onClick={() => editorCommand('search')}
                                    />
                                    <IconButton
                                        name="undo"
                                        title="撤销（Ctrl/Cmd+Z）"
                                        disabled={
                                            !available || activeTab.readOnly
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
                                            (activeTab.state === 'saved' &&
                                                !isDirty(activeTab))
                                        }
                                        onClick={() =>
                                            void saveTab(activeTab.id)
                                        }
                                    >
                                        <Icon name="save" size={14} />
                                        {activeTab.busy ? '保存中' : '保存'}
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
                                    activeTab.state === 'draft' ||
                                    isDirty(activeTab) ||
                                    activeTab.size > 256 * 1024
                                }
                                title={
                                    activeTab.state === 'draft' ||
                                    isDirty(activeTab)
                                        ? '请先保存编辑，再添加到对话；不会自动保存'
                                        : activeTab.size > 256 * 1024
                                          ? '附件上限为 256 KiB'
                                          : '添加服务器最新快照，不会自动发送'
                                }
                                onClick={() =>
                                    activeTab.state === 'saved' &&
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
                                activeTab.state === 'saved' &&
                                attaching.path === activeTab.path
                                    ? '添加中…'
                                    : activeTab.state === 'draft' ||
                                        isDirty(activeTab)
                                      ? '先保存再添加'
                                      : activeTab.size > 256 * 1024
                                        ? '超过 256 KiB'
                                        : '添加到对话'}
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
                                                    复制完整草稿
                                                </button>
                                                <button
                                                    role="menuitem"
                                                    disabled={
                                                        !available ||
                                                        activeTab.state ===
                                                            'draft' ||
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
                                            disabled={
                                                !available ||
                                                activeTab.state === 'draft'
                                            }
                                            title={
                                                activeTab.state === 'draft'
                                                    ? '请先保存新文件'
                                                    : undefined
                                            }
                                            onClick={() =>
                                                fileMenuAction(
                                                    () =>
                                                        activeTab.state ===
                                                            'saved' &&
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
                            {tab.state === 'draft' && tab.naming && (
                                <form
                                    className="inline-name-bar"
                                    aria-label="保存新文件"
                                    onSubmit={(event) => event.preventDefault()}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Escape') {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            if (!tab.busy) {
                                                updateDraft(tab.id, {
                                                    naming: false,
                                                });
                                                views.current
                                                    .get(tab.id)
                                                    ?.focus();
                                            }
                                        }
                                    }}
                                >
                                    <span
                                        title={`${tab.rootId}:/${tab.directory}`}
                                    >
                                        保存到 {tab.rootId}:/
                                        {tab.directory || ''}
                                    </span>
                                    <input
                                        id={`${tab.id}-filename`}
                                        aria-label="文件名"
                                        autoFocus
                                        autoComplete="off"
                                        placeholder="文件名，例如 notes.md"
                                        onKeyDown={(event) => {
                                            if (event.key !== 'Enter') return;
                                            event.preventDefault();
                                            event.stopPropagation();
                                            if (
                                                !event.nativeEvent
                                                    .isComposing &&
                                                event.keyCode !== 229
                                            )
                                                void saveTab(tab.id);
                                        }}
                                        value={tab.fileName}
                                        disabled={
                                            tab.busy || !canWrite(tab.rootId)
                                        }
                                        onChange={(event) =>
                                            updateDraft(tab.id, {
                                                fileName: event.target.value,
                                            })
                                        }
                                    />
                                    <button
                                        type="button"
                                        className="primary"
                                        onClick={() => void saveTab(tab.id)}
                                        disabled={
                                            tab.busy || !canWrite(tab.rootId)
                                        }
                                    >
                                        {tab.busy ? '保存中…' : '保存'}
                                    </button>
                                </form>
                            )}
                            {tab.kind === 'text' ? (
                                <TextEditor
                                    id={tab.id}
                                    name={tab.name}
                                    text={tab.text}
                                    revision={tab.revision}
                                    active={
                                        activeTabId === tab.id &&
                                        mobilePane === 'editor'
                                    }
                                    readOnly={
                                        tab.readOnly || !canWrite(tab.rootId)
                                    }
                                    onChange={(text) =>
                                        updateTab(tab.id, { text })
                                    }
                                    onSave={() => void saveTab(tab.id)}
                                    onView={(id, view) => {
                                        onView(id, view);
                                        if (
                                            view &&
                                            tab.state === 'draft' &&
                                            activeTabId === id
                                        )
                                            view.focus();
                                    }}
                                />
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
                                            : '此文件不支持文本编辑'}
                                    </span>
                                    <button
                                        disabled={!available}
                                        onClick={() =>
                                            tab.state === 'saved' &&
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
                    className={`transfers ${showTransfers ? 'expanded' : ''}`}
                    aria-label="传输队列"
                >
                    <div className="transfer-heading">
                        <button
                            className="transfer-toggle"
                            aria-expanded={showTransfers}
                            onClick={() => setShowTransfers((value) => !value)}
                        >
                            <Icon name="upload" size={14} />
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
                                                job.status === 'running' &&
                                                job.loaded === job.size
                                                    ? '接收完毕，等待完整性校验…'
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
                                                            'ready',
                                                            'handed-off',
                                                        ].includes(job.status)
                                                      ? job.size || 1
                                                      : job.loaded
                                            }
                                            aria-label={`${job.name} 传输进度`}
                                        />
                                        <div className="transfer-meta">
                                            {job.status === 'preparing'
                                                ? '正在准备文件或等待服务器响应，尚未收到数据。'
                                                : `${formatSize(job.loaded)} / ${formatSize(job.size)}${job.size > 0 ? ` · ${Math.floor((job.loaded / job.size) * 100)}%` : ''}`}
                                            {job.status === 'ready' &&
                                                ' · 文件已完整接收，请在 5 分钟内保存或丢弃。'}
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
                                                    保存到本机
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
                                                        job.size >
                                                            MAX_FILE_SIZE)
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
            {dragging && (
                <div className="drop-overlay">
                    <Icon name="upload" size={30} />
                    <strong>
                        {!available
                            ? '连接不可用'
                            : readOnly
                              ? '此位置只读'
                              : '松开以上传文件'}
                    </strong>
                </div>
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
                                        <strong>{dialogTab?.name}</strong>{' '}
                                        的修改尚未写入服务器。关闭后，当前草稿将丢失。
                                    </p>
                                    <div className="dialog-secondary-actions">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                dialogTab &&
                                                void copy(dialogTab.text)
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
