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
import {
    MAX_FILE_SIZE,
    transferActive,
    transferLabels,
    useTransfers,
} from './transfers';
import { formatDate, formatSize, Icon, IconButton, Menu, Modal } from './ui';
import type { IconName } from './ui';

interface Root {
    rootId: string;
    name: string;
    readOnly: boolean;
}

interface Entry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    mtime: string | number;
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
    id: string;
    rootId: string;
    path: string;
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

type Dialog =
    | {
          kind: 'create' | 'mkdir';
          rootId: string;
          directory: string;
          content: string;
      }
    | {
          kind: 'rename' | 'move' | 'delete';
          rootId: string;
          target: FileStat & { name: string; version: string };
      }
    | { kind: 'close' | 'reread'; tabId: string }
    | { kind: 'copy'; text: string };

const dialogTitles: Record<Dialog['kind'], string> = {
    create: '新建文件',
    mkdir: '新建文件夹',
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
    return tab.kind === 'text' && tab.text !== tab.savedText;
}

function affected(tab: FileTab, rootId: string, path: string) {
    return (
        tab.rootId === rootId &&
        (tab.path === path || tab.path.startsWith(`${path}/`))
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
    const [entries, setEntries] = useState<Entry[]>([]);
    const [loading, setLoading] = useState(false);
    const [listError, setListError] = useState('');
    const [cursors, setCursors] = useState<string[]>(['']);
    const [page, setPage] = useState(0);
    const [nextCursor, setNextCursor] = useState<string>();
    const [reload, setReload] = useState(0);
    const [selected, setSelected] = useState<Entry>();
    const [stat, setStat] = useState<FileStat>();
    const [statLoading, setStatLoading] = useState(false);
    const [statError, setStatError] = useState('');
    const [tabs, setTabs] = useState<FileTab[]>([]);
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;
    const [activeTabId, setActiveTabId] = useState('');
    const [mobileView, setMobileView] = useState<'files' | 'editor'>('files');
    const [opening, setOpening] = useState(false);
    const openingPaths = useRef(new Set<string>());
    const savingTabs = useRef(new Set<string>());
    const tabSequence = useRef(0);
    const views = useRef(new Map<string, EditorView>());
    const [notice, setNotice] = useState<{
        kind: 'error' | 'success' | 'info';
        text: string;
    }>();
    const [dialog, setDialogState] = useState<Dialog>();
    const actionIntent = useRef(0);
    const actionContext = useRef({ rootId, selected, available });
    actionContext.current = { rootId, selected, available };
    const setDialog = (next: Dialog | undefined) => {
        actionIntent.current++;
        setStatLoading(false);
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
    const dirty =
        tabs.some(isDirty) ||
        (dialog?.kind === 'create' && dialog.content.length > 0);
    const mobilePane = tabs.length ? mobileView : 'files';
    const cursor = cursors[page] ?? '';
    const canMutateSelection =
        available &&
        !readOnly &&
        !!selected &&
        !!stat &&
        !stat.readOnly &&
        !statLoading &&
        !statError;
    const canDownloadSelection =
        available && !!selected && selected.type === 'file';

    const refresh = useCallback(() => {
        setCursors(['']);
        setPage(0);
        setReload((value) => value + 1);
    }, []);

    const transfers = useTransfers(available, refresh);
    const activeTransfers = transfers.jobs.filter(transferActive).length;

    const loadRoots = useCallback(async () => {
        setRootsLoading(true);
        setRootsError('');
        try {
            const result = await bridge.request<{ roots: Root[] }>('roots');
            setRoots(result.roots);
            setRootId((previous) =>
                result.roots.some((item) => item.rootId === previous)
                    ? previous
                    : (result.roots[0]?.rootId ?? ''),
            );
        } catch (error) {
            setRootsError(errorMessage(error));
        } finally {
            setRootsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (available) void loadRoots();
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
        if (!available || !rootId) return;
        let ignore = false;
        setLoading(true);
        setListError('');
        setSelected(undefined);
        setStat(undefined);
        void bridge
            .request<{ entries: Entry[]; nextCursor?: string }>('list', {
                rootId,
                path: directory,
                limit: 100,
                ...(cursor ? { cursor } : {}),
            })
            .then((result) => {
                if (ignore) return;
                setEntries(result.entries);
                setNextCursor(result.nextCursor);
            })
            .catch((error: unknown) => {
                if (!ignore) {
                    setListError(errorMessage(error));
                    setEntries([]);
                    setNextCursor(undefined);
                }
            })
            .finally(() => {
                if (!ignore) setLoading(false);
            });
        return () => {
            ignore = true;
        };
    }, [available, rootId, directory, cursor, reload]);

    useEffect(() => {
        setStat(undefined);
        setStatError('');
        if (!selected || !available) return;
        let ignore = false;
        setStatLoading(true);
        void bridge
            .request<FileStat>('stat', { rootId, path: selected.path })
            .then((result) => {
                if (!ignore) setStat(result);
            })
            .catch((error: unknown) => {
                if (!ignore) setStatError(errorMessage(error));
            })
            .finally(() => {
                if (!ignore) setStatLoading(false);
            });
        return () => {
            ignore = true;
        };
    }, [selected, rootId, available]);

    // Visibility changes must not recreate editors or discard selection/undo history.
    useEffect(() => {
        if (mobilePane === 'editor') {
            views.current.get(activeTabId)?.requestMeasure();
        }
    }, [mobilePane, activeTabId]);

    const navigate = (path: string, nextRoot = rootId) => {
        setMobileView('files');
        setRootId(nextRoot);
        setDirectory(path);
        setCursors(['']);
        setPage(0);
        setSelected(undefined);
        setReload((value) => value + 1);
    };

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

    const openPath = async (
        targetRoot: string,
        path: string,
        entry?: Entry,
    ) => {
        const existing = tabsRef.current.find(
            (tab) => tab.rootId === targetRoot && tab.path === path,
        );
        if (existing) {
            setActiveTabId(existing.id);
            setMobileView('editor');
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
                        { rootId: targetRoot, path },
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
        if (entry.type === 'directory') navigate(entry.path);
        else void openPath(rootId, entry.path, entry);
    };

    const saveTab = async (id: string) => {
        const tab = tabsRef.current.find((item) => item.id === id);
        if (
            !tab ||
            tab.kind !== 'text' ||
            tab.busy ||
            savingTabs.current.has(id) ||
            tab.readOnly ||
            !available ||
            !isDirty(tab)
        )
            return;
        if (tab.conflict) {
            setNotice({
                kind: 'error',
                text: '文件存在版本冲突，请先复制草稿或重新读取。不会强制覆盖服务器文件。',
            });
            return;
        }
        const text = tab.text;
        savingTabs.current.add(id);
        updateTab(id, { busy: true, error: undefined });
        try {
            const result = await bridge.request<{
                version: string;
                size?: number;
            }>('saveText', {
                rootId: tab.rootId,
                path: tab.path,
                text,
                expectedVersion: tab.version,
            });
            updateTab(id, {
                savedText: text,
                version: result.version,
                size: result.size ?? new TextEncoder().encode(text).byteLength,
                conflict: false,
                error: undefined,
            });
            setNotice({ kind: 'success', text: `已保存 ${tab.name}` });
            refresh();
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

    const beginAction = async (kind: 'rename' | 'move' | 'delete') => {
        if (!selected || !stat || !canMutateSelection || statLoading) return;
        // Content versions are needed for mutations, not every row selection.
        const target = selected;
        const intent = ++actionIntent.current;
        const currentIntent = () =>
            actionIntent.current === intent &&
            actionContext.current.rootId === rootId &&
            actionContext.current.selected === target &&
            actionContext.current.available;
        setStatLoading(true);
        try {
            const current = await bridge.request<
                FileStat & { version: string }
            >('stat', {
                rootId,
                path: target.path,
                includeVersion: true,
            });
            if (!currentIntent()) return;
            setDialog({
                kind,
                rootId,
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

    const beginCreate = (kind: 'create' | 'mkdir') => {
        setDialog({ kind, rootId, directory, content: '' });
        setDialogError('');
    };

    const beginReread = (tab: FileTab) => {
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
        if (!available) {
            setDialogError('连接当前不可用，未执行操作。');
            return;
        }
        setDialogBusy(true);
        try {
            if (dialog.kind === 'create' || dialog.kind === 'mkdir') {
                const name = String(fields.get('name') ?? '');
                if (!name.trim()) throw new Error('请输入名称。');
                const path = joinPath(dialog.directory, name);
                await bridge.request(
                    dialog.kind === 'create' ? 'createFile' : 'mkdir',
                    {
                        rootId: dialog.rootId,
                        path,
                        ...(dialog.kind === 'create'
                            ? { text: dialog.content }
                            : {}),
                    },
                );
                setDialog(undefined);
                refresh();
                setNotice({ kind: 'success', text: `已创建 ${name}` });
                if (dialog.kind === 'create')
                    void openPath(dialog.rootId, path);
            } else if (dialog.kind === 'rename' || dialog.kind === 'move') {
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
                setDialog(undefined);
                refresh();
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
                setDialog(undefined);
                refresh();
                setNotice({
                    kind: 'success',
                    text: `已删除 ${dialog.target.name}`,
                });
            } else if (dialog.kind === 'reread') {
                const tab = tabsRef.current.find(
                    (item) => item.id === dialog.tabId,
                );
                if (!tab) throw new Error('标签已关闭。');
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
                      isDirty(tab),
              )
            : [];

    const transferErrors = transfers.jobs.some(
        (job) => job.status === 'error' || job.status === 'confirm',
    );
    const queueVisible = showTransfers || activeTransfers > 0 || transferErrors;
    const parentDirectory = directory.split('/').slice(0, -1).join('/');

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
                <nav className="breadcrumbs" aria-label="当前位置">
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
                                    fileMenuAction(() => beginCreate('mkdir'))
                                }
                            >
                                <Icon name="folder" />
                                新建文件夹
                            </button>
                            <button
                                role="menuitem"
                                disabled={!available}
                                onClick={() =>
                                    fileMenuAction(() => {
                                        refresh();
                                        void loadRoots();
                                    })
                                }
                            >
                                <Icon name="refresh" />
                                刷新
                            </button>
                            <div role="separator" />
                            <button
                                role="menuitem"
                                disabled={!canMutateSelection}
                                onClick={() =>
                                    fileMenuAction(() => beginAction('rename'))
                                }
                            >
                                <Icon name="edit" />
                                重命名
                            </button>
                            <button
                                role="menuitem"
                                disabled={!canMutateSelection}
                                onClick={() =>
                                    fileMenuAction(() => beginAction('move'))
                                }
                            >
                                <Icon name="move" />
                                移动
                            </button>
                            <button
                                role="menuitem"
                                disabled={!canDownloadSelection}
                                onClick={() =>
                                    fileMenuAction(
                                        () =>
                                            selected &&
                                            download(
                                                rootId,
                                                selected.path,
                                                selected.size,
                                            ),
                                    )
                                }
                            >
                                <Icon name="download" />
                                下载
                            </button>
                            <button
                                role="menuitem"
                                disabled={!selected}
                                onClick={() =>
                                    fileMenuAction(
                                        () =>
                                            selected &&
                                            void copy(selected.path),
                                    )
                                }
                            >
                                <Icon name="copy" />
                                复制相对路径
                            </button>
                            <button
                                role="menuitem"
                                className="danger-text"
                                disabled={!canMutateSelection}
                                onClick={() =>
                                    fileMenuAction(() => beginAction('delete'))
                                }
                            >
                                <Icon name="trash" />
                                删除…
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

            <div className="workspace">
                <section
                    id="directory-panel"
                    className="directory-panel"
                    aria-label="文件列表"
                >
                    <div className="list-heading">
                        <span>{selected ? selected.name : '名称'}</span>
                        {opening ? (
                            <span role="status">正在打开…</span>
                        ) : (
                            <span>
                                {loading ? '读取中…' : `${entries.length} 项`}
                            </span>
                        )}
                        {tabs.length > 0 && (
                            <button
                                className="text-button show-editor"
                                onClick={() => setMobileView('editor')}
                                title="返回已打开文件"
                                aria-label="返回已打开文件"
                            >
                                <Icon name="code" size={14} />
                                {tabs.length}
                                {dirty && <span className="dirty-dot" />}
                            </button>
                        )}
                    </div>
                    {rootsError || listError ? (
                        <div className="list-error" role="alert">
                            <p>{rootsError || listError}</p>
                            <button
                                onClick={() =>
                                    rootsError ? void loadRoots() : refresh()
                                }
                            >
                                重试
                            </button>
                        </div>
                    ) : (
                        <div
                            className="file-list"
                            role="list"
                            aria-busy={loading}
                        >
                            {entries.map((entry) => (
                                <div
                                    key={entry.path}
                                    role="listitem"
                                    className={`file-row ${selected?.path === entry.path ? 'selected' : ''}`}
                                >
                                    <button
                                        className="entry-open"
                                        disabled={!available || loading}
                                        title={`${entry.path}\n${formatDate(entry.mtime)}`}
                                        onClick={() => openEntry(entry)}
                                    >
                                        <span
                                            className={`entry-icon ${entry.type}`}
                                        >
                                            <Icon
                                                name={entryIcon(entry)}
                                                size={19}
                                            />
                                        </span>
                                        <span className="entry-name">
                                            {entry.name}
                                        </span>
                                        {entry.type === 'directory' ? (
                                            <Icon name="chevron" size={13} />
                                        ) : (
                                            <span className="entry-size">
                                                {formatSize(entry.size)}
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        className="entry-select icon-button"
                                        title={`选择 ${entry.name} 的操作`}
                                        aria-label={`选择 ${entry.name} 的操作`}
                                        aria-pressed={
                                            selected?.path === entry.path
                                        }
                                        disabled={!available || loading}
                                        onClick={() =>
                                            setSelected(
                                                selected?.path === entry.path
                                                    ? undefined
                                                    : entry,
                                            )
                                        }
                                    >
                                        <Icon name="more" size={16} />
                                    </button>
                                </div>
                            ))}
                            {!entries.length && (
                                <div className="empty-state">
                                    <Icon name="folder" size={28} />
                                    <span>
                                        {loading || rootsLoading
                                            ? '读取中…'
                                            : !available
                                              ? '尚未连接'
                                              : !roots.length
                                                ? '没有可用目录'
                                                : '空文件夹'}
                                    </span>
                                    {available &&
                                        root &&
                                        !readOnly &&
                                        !loading && (
                                            <button
                                                className="text-button"
                                                onClick={() =>
                                                    uploadInput.current?.click()
                                                }
                                            >
                                                上传文件
                                            </button>
                                        )}
                                </div>
                            )}
                        </div>
                    )}
                    {selected && (
                        <div
                            className="selection-toolbar"
                            role="toolbar"
                            aria-label={`${selected.name} 的操作`}
                        >
                            <span
                                className="selection-name"
                                title={selected.name}
                            >
                                {selected.name}
                            </span>
                            {statLoading && (
                                <span className="muted" role="status">
                                    …
                                </span>
                            )}
                            <IconButton
                                name="edit"
                                title="重命名所选项目"
                                disabled={!canMutateSelection}
                                onClick={() => beginAction('rename')}
                            />
                            <IconButton
                                name="move"
                                title="移动所选项目"
                                disabled={!canMutateSelection}
                                onClick={() => beginAction('move')}
                            />
                            <IconButton
                                name="trash"
                                title="删除所选项目"
                                disabled={!canMutateSelection}
                                onClick={() => beginAction('delete')}
                            />
                            <IconButton
                                name="close"
                                title="取消选择"
                                onClick={() => setSelected(undefined)}
                            />
                        </div>
                    )}
                    {statError && selected && (
                        <div className="inline-error" role="alert">
                            {statError}
                        </div>
                    )}
                    {(page > 0 || nextCursor) && (
                        <nav className="pagination" aria-label="目录分页">
                            <button
                                disabled={!available || loading || !page}
                                onClick={() => setPage((value) => value - 1)}
                            >
                                上一页
                            </button>
                            <span>第 {page + 1} 页</span>
                            <button
                                disabled={!available || loading || !nextCursor}
                                onClick={() => {
                                    if (!nextCursor) return;
                                    setCursors((current) => [
                                        ...current.slice(0, page + 1),
                                        nextCursor,
                                    ]);
                                    setPage((value) => value + 1);
                                }}
                            >
                                下一页
                            </button>
                        </nav>
                    )}
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
                                        title={`${tab.path}${isDirty(tab) ? '（未保存）' : ''}`}
                                        onClick={() => {
                                            setActiveTabId(tab.id);
                                            setMobileView('editor');
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
                                            setActiveTabId(target.id);
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
                            <span
                                className="editor-file-path"
                                title={`${activeTab.rootId}:/${activeTab.path}`}
                            >
                                {activeTab.path}
                            </span>
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
                                            activeTab.busy ||
                                            activeTab.conflict ||
                                            !isDirty(activeTab)
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
                                <TextEditor
                                    id={tab.id}
                                    name={tab.name}
                                    text={tab.text}
                                    revision={tab.revision}
                                    active={
                                        activeTabId === tab.id &&
                                        mobilePane === 'editor'
                                    }
                                    readOnly={tab.readOnly || !available}
                                    onChange={(text) =>
                                        updateTab(tab.id, { text })
                                    }
                                    onSave={() => void saveTab(tab.id)}
                                    onView={onView}
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
                                        transfers.clearFinished();
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
                                            <span>
                                                {transferLabels[job.status]}
                                            </span>
                                        </div>
                                        <progress
                                            max={job.size || 1}
                                            value={
                                                job.status === 'done'
                                                    ? job.size || 1
                                                    : job.loaded
                                            }
                                            aria-label={`${job.name} 传输进度`}
                                        />
                                        <div className="transfer-meta">
                                            {formatSize(job.loaded)} /{' '}
                                            {formatSize(job.size)}
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
                                        {transferActive(job) && (
                                            <IconButton
                                                name="close"
                                                title={
                                                    job.status === 'finishing'
                                                        ? '提交阶段不可取消'
                                                        : '取消传输'
                                                }
                                                disabled={
                                                    job.status ===
                                                        'finishing' ||
                                                    job.status === 'cancelling'
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
                                            (job.status === 'done' &&
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
                            {(dialog.kind === 'create' ||
                                dialog.kind === 'mkdir') && (
                                <>
                                    <p className="modal-description">
                                        位置：{dialog.rootId}:/
                                        {dialog.directory}
                                        <br />
                                        不会覆盖已有内容；如包含子目录，父目录须已存在。
                                    </p>
                                    <label className="field-label">
                                        {dialog.kind === 'create'
                                            ? '文件名称'
                                            : '文件夹名称'}
                                        <input
                                            data-autofocus
                                            name="name"
                                            required
                                            autoComplete="off"
                                            placeholder={
                                                dialog.kind === 'create'
                                                    ? '例如：新文档.md'
                                                    : '例如：项目资料'
                                            }
                                            disabled={dialogBusy}
                                        />
                                    </label>
                                    {dialog.kind === 'create' && (
                                        <label className="field-label">
                                            初始内容{' '}
                                            <span className="field-hint">
                                                留空即创建空文件 · UTF-8
                                            </span>
                                            <textarea
                                                name="content"
                                                value={dialog.content}
                                                onChange={(event) =>
                                                    setDialog({
                                                        ...dialog,
                                                        content:
                                                            event.target.value,
                                                    })
                                                }
                                                rows={4}
                                                placeholder="在这里输入文件内容（可选）"
                                                disabled={dialogBusy}
                                            />
                                        </label>
                                    )}
                                </>
                            )}
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
                            {!available && dialog.kind !== 'close' && (
                                <p className="dialog-error">
                                    连接已暂停或断开。草稿已保留，操作尚不可用。
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
                                        (!available && dialog.kind !== 'close')
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
                                              : dialog.kind === 'create' ||
                                                  dialog.kind === 'mkdir'
                                                ? '创建'
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
