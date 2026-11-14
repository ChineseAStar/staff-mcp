import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import type { IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { bridge } from '../../file-manager/ui/bridge';
import { TerminalSession, terminalSize } from './session';
import { terminalPresentation } from './stream-adapter';
import type { SessionView } from './session';

export function App() {
    const lifecycle = useSyncExternalStore(bridge.subscribe, bridge.snapshot);
    const mount = useRef<HTMLDivElement>(null);
    const session = useRef<TerminalSession | undefined>(undefined);
    const terminal = useRef<Terminal | undefined>(undefined);
    const [visible, setVisible] = useState(
        document.visibilityState === 'visible' && bridge.snapshot().visible,
    );
    const [view, setView] = useState<SessionView>({
        phase: 'idle',
        message: '等待宿主连接…',
    });
    const [confirmEnd, setConfirmEnd] = useState(false);
    const active = view.phase === 'running' || view.phase === 'opening';
    const available = lifecycle.enabled && lifecycle.connected && visible;

    useEffect(() => {
        if (view.phase !== 'running' || view.ending || !available)
            setConfirmEnd(false);
    }, [view.phase, view.ending, available]);

    useEffect(() => {
        const container = mount.current!;
        let term = new Terminal({
            cols: 80,
            rows: 24,
            fontSize: 13,
            lineHeight: 1.2,
            cursorBlink: true,
            scrollback: 2000,
            screenReaderMode: true,
            disableStdin: true,
            allowProposedApi: false,
            logLevel: 'off',
            // No WebLinks addon, clipboard addon, or window-operation permissions.
            // Escape sequences are rendered by xterm, never as page HTML.
        });
        let fit = new FitAddon();
        let bindings: IDisposable[] = [];
        let initialSurface = true;
        const disposeSurface = () => {
            for (const binding of bindings) binding.dispose();
            bindings = [];
            fit.dispose();
            term.dispose();
        };
        const bindSurface = () => {
            term.loadAddon(fit);
            term.open(container);
            // Terminal output cannot access the clipboard or create hyperlinks.
            bindings = [
                term.parser.registerOscHandler(52, () => true),
                term.parser.registerOscHandler(8, () => true),
                term.onData((value) => current.input(value)),
                term.onResize(({ cols, rows }) => current.resize(cols, rows)),
            ];
            terminal.current = term;
        };
        const current = new TerminalSession(
            terminalPresentation(bridge),
            term,
            setView,
            () => {
                if (initialSurface) {
                    initialSurface = false;
                    return term;
                }
                const options = {
                    ...term.options,
                    cols: term.cols,
                    rows: term.rows,
                    disableStdin: true,
                };
                disposeSurface();
                term = new Terminal(options);
                fit = new FitAddon();
                bindSurface();
                theme();
                return term;
            },
        );
        session.current = current;
        bindSurface();

        let pageHidden = false;
        let disposed = false;
        let fontsReady = false;
        const isVisible = () =>
            !pageHidden &&
            document.visibilityState === 'visible' &&
            bridge.snapshot().visible;
        let frame = 0;
        const scheduleFit = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const state = bridge.snapshot();
                if (
                    fontsReady &&
                    isVisible() &&
                    state.enabled &&
                    state.connected &&
                    container.clientWidth > 0 &&
                    container.clientHeight > 0
                ) {
                    const dimensions = fit.proposeDimensions();
                    const size =
                        dimensions &&
                        terminalSize(dimensions.cols, dimensions.rows);
                    if (!size) return;
                    term.resize(size.cols, size.rows);
                    // A view switch may need a remote resize even when the
                    // fitted local dimensions did not change.
                    current.resize(term.cols, term.rows);
                    // Availability opens the initial PTY. Fit first so the shell
                    // never prints its first prompt using xterm's default 80x24.
                    current.setAvailability(true);
                }
            });
        };
        const visibility = () => {
            const visible = isVisible();
            current.setVisible(visible);
            setVisible(visible);
            if (visible) scheduleFit();
        };
        const syncLifecycle = () => {
            const state = bridge.snapshot();
            const available = state.enabled && state.connected;
            // Fence real loss before visibility can reopen a never-opened idle.
            if (!available) current.setAvailability(false);
            // A usable bridge alone is not enough to start a shell: the next
            // visible fit enables the session with the measured viewport size.
            visibility();
        };
        const unsubscribe = bridge.subscribe(syncLifecycle);
        syncLifecycle();
        const pagehide = (event: PageTransitionEvent) => {
            pageHidden = true;
            visibility();
            if (!event.persisted) current.close();
        };
        const pageshow = () => {
            pageHidden = false;
            syncLifecycle();
        };
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pagehide', pagehide);
        window.addEventListener('pageshow', pageshow);

        const theme = () => {
            const style = getComputedStyle(document.documentElement);
            const color = (name: string, fallback: string) =>
                style.getPropertyValue(name).trim() || fallback;
            const dark = document.documentElement.classList.contains('dark');
            term.options.fontFamily = color(
                '--font-code-family',
                'ui-monospace, monospace',
            );
            term.options.theme = {
                background: color('--bg-primary', dark ? '#101316' : '#ffffff'),
                foreground: color(
                    '--text-primary',
                    dark ? '#f1f2f4' : '#111827',
                ),
                cursor: color('--color-primary', '#3b82f6'),
                cursorAccent: color(
                    '--bg-primary',
                    dark ? '#101316' : '#ffffff',
                ),
                selectionBackground: dark ? '#35578099' : '#bdd7ff99',
                black: dark ? '#394150' : '#111827',
                red: dark ? '#ff7b86' : '#b42332',
                green: dark ? '#91d5a5' : '#18753c',
                yellow: dark ? '#ebcb8b' : '#8b6600',
                blue: dark ? '#8ab4f8' : '#255dc4',
                magenta: dark ? '#d0a2f7' : '#8b3eaf',
                cyan: dark ? '#88d7df' : '#087d88',
                white: dark ? '#dce2ea' : '#c7cdd5',
                brightBlack: '#6b7280',
                brightRed: dark ? '#ffa4ac' : '#d02f43',
                brightGreen: dark ? '#b0ecc1' : '#258543',
                brightYellow: dark ? '#f5dfa8' : '#987000',
                brightBlue: dark ? '#aecbfa' : '#3372db',
                brightMagenta: dark ? '#e0baff' : '#a34cc3',
                brightCyan: dark ? '#b1ecf1' : '#098d98',
                brightWhite: dark ? '#ffffff' : '#e5e7eb',
            };
            scheduleFit();
        };
        const observer = new ResizeObserver(scheduleFit);
        observer.observe(container);
        const themeObserver = new MutationObserver(theme);
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style'],
        });
        theme();
        void document.fonts.ready.then(() => {
            if (disposed) return;
            fontsReady = true;
            scheduleFit();
        });

        return () => {
            disposed = true;
            unsubscribe();
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pagehide', pagehide);
            window.removeEventListener('pageshow', pageshow);
            observer.disconnect();
            themeObserver.disconnect();
            cancelAnimationFrame(frame);
            current.dispose();
            disposeSurface();
            session.current = undefined;
            terminal.current = undefined;
        };
    }, []);

    return (
        <main className="terminal-app" aria-label="终端">
            <header className="toolbar">
                <div className="location">
                    <span className="terminal-mark" aria-hidden="true">
                        ❯_
                    </span>
                    <span className="shell" title={view.shell}>
                        {view.shell || '终端'}
                    </span>
                    {view.path && (
                        <span className="path" title={view.path}>
                            {view.path}
                        </span>
                    )}
                </div>
                <div className="actions">
                    {active ? (
                        <>
                            <button
                                type="button"
                                disabled={
                                    view.phase !== 'running' || !available
                                }
                                onClick={() => {
                                    if (!available) return;
                                    terminal.current?.clear();
                                    terminal.current?.focus();
                                }}
                                title="仅清除本地屏幕与回滚，不向 shell 发送命令"
                            >
                                清屏
                            </button>
                            <button
                                type="button"
                                disabled={
                                    view.phase !== 'running' ||
                                    !!view.ending ||
                                    !available
                                }
                                onClick={() => {
                                    if (!available || view.ending) return;
                                    if (!confirmEnd) {
                                        setConfirmEnd(true);
                                        return;
                                    }
                                    setConfirmEnd(false);
                                    void session.current?.terminate();
                                }}
                                title="结束原 shell，运行程序可能被中断；不保证结束所有子进程或撤销外部操作。关闭应用仅断开连接"
                            >
                                {confirmEnd ? '确认结束' : '结束会话'}
                            </button>
                            {confirmEnd && (
                                <button
                                    type="button"
                                    onClick={() => setConfirmEnd(false)}
                                >
                                    取消
                                </button>
                            )}
                        </>
                    ) : view.phase === 'stopped' ? (
                        <button
                            className="primary"
                            type="button"
                            disabled={!available || view.recovery === 'app'}
                            onClick={() => void session.current?.open()}
                        >
                            重新连接
                        </button>
                    ) : null}
                </div>
            </header>
            <div
                className="status"
                role="status"
                aria-live="polite"
                data-error={view.error || undefined}
            >
                <span
                    className={`status-dot ${view.phase === 'running' ? 'connected' : ''}`}
                    aria-hidden="true"
                />
                {active && !visible && !view.error
                    ? '终端已隐藏；暂停新输入，返回后继续当前会话；长时间冻结可能被回收。'
                    : view.message}
                {view.code && ` [${view.code}]`}
            </div>
            <div className="terminal-surface" ref={mount} />
            <footer>
                本地回滚最近 2000 行 · 离线输出不保存 ·
                关闭应用仅断开连接，不撤销外部操作
            </footer>
        </main>
    );
}
