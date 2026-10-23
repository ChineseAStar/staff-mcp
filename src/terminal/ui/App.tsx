import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { bridge } from '../../file-manager/ui/bridge';
import { TerminalSession } from './session';
import type { SessionView } from './session';

export function App() {
    const lifecycle = useSyncExternalStore(bridge.subscribe, bridge.snapshot);
    const mount = useRef<HTMLDivElement>(null);
    const session = useRef<TerminalSession | undefined>(undefined);
    const terminal = useRef<Terminal | undefined>(undefined);
    const [visible, setVisible] = useState(
        document.visibilityState === 'visible',
    );
    const [view, setView] = useState<SessionView>({
        phase: 'idle',
        message: '等待宿主连接…',
    });
    const active = view.phase === 'running' || view.phase === 'opening';
    const available = lifecycle.enabled && lifecycle.connected && visible;

    useEffect(() => {
        const container = mount.current!;
        const term = new Terminal({
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
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(container);
        // Explicitly consume OSC 52; terminal output cannot access the clipboard.
        const clipboardGuard = term.parser.registerOscHandler(52, () => true);
        const linkGuard = term.parser.registerOscHandler(8, () => true);
        const current = new TerminalSession(bridge, term, setView);
        session.current = current;
        terminal.current = term;
        const data = term.onData((value) => current.input(value));
        const resized = term.onResize(({ cols, rows }) =>
            current.resize(cols, rows),
        );

        const syncLifecycle = () => {
            const state = bridge.snapshot();
            // Synchronous fencing, independent of React's next render/effect.
            current.setAvailability(
                state.enabled && state.connected,
                state.message,
            );
        };
        const unsubscribe = bridge.subscribe(syncLifecycle);
        current.setVisible(document.visibilityState === 'visible');
        syncLifecycle();
        const visibility = () => {
            const isVisible = document.visibilityState === 'visible';
            current.setVisible(isVisible);
            setVisible(isVisible);
            if (isVisible) scheduleFit();
        };
        const pagehide = () => current.setVisible(false);
        const pageshow = () => visibility();
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pagehide', pagehide);
        window.addEventListener('pageshow', pageshow);

        let frame = 0;
        const scheduleFit = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                if (container.clientWidth > 0 && container.clientHeight > 0)
                    fit.fit();
            });
        };
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

        return () => {
            unsubscribe();
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pagehide', pagehide);
            window.removeEventListener('pageshow', pageshow);
            observer.disconnect();
            themeObserver.disconnect();
            cancelAnimationFrame(frame);
            current.dispose();
            data.dispose();
            resized.dispose();
            clipboardGuard.dispose();
            linkGuard.dispose();
            term.dispose();
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
                                disabled={view.phase !== 'running'}
                                onClick={() => {
                                    terminal.current?.clear();
                                    terminal.current?.focus();
                                }}
                                title="仅清除本地屏幕与回滚，不向 shell 发送命令"
                            >
                                清屏
                            </button>
                            <button
                                type="button"
                                onClick={() => session.current?.close()}
                                title="请求关闭远端终端"
                            >
                                关闭终端
                            </button>
                        </>
                    ) : view.phase === 'stopped' ? (
                        <button
                            className="primary"
                            type="button"
                            disabled={!available}
                            onClick={() => void session.current?.open()}
                        >
                            重连
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
                {view.message}
            </div>
            <div className="terminal-surface" ref={mount} />
            <footer>回滚保留最近 2000 行 · 关闭不撤销已执行的操作</footer>
        </main>
    );
}
