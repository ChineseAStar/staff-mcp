import { useEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const paths = {
    attach: 'm8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3m-8 14 10-10a2 2 0 0 1 3 3L8 20',
    back: 'm14 6-6 6 6 6',
    down: 'm6 9 6 6 6-6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
    file: 'M14 3H5v18h14V8Zm0 0v5h5M8 13h8M8 17h6',
    image: 'M3 3h18v18H3ZM3 17l6-6 4 4 3-3 5 5M15 7h.01',
    code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-5 3 2-16',
    link: 'm10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
    refresh:
        'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 14-2l1 6M4 12l1 6a8 8 0 0 0 14-2',
    up: 'm6 11 6-6 6 6M12 5v15',
    chevron: 'm9 5 7 7-7 7',
    plus: 'M12 4v16M4 12h16',
    upload: 'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5',
    download: 'M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5',
    copy: 'M8 8h13v13H8ZM16 8V3H3v13h5',
    edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z',
    move: 'M12 3v18M3 12h18m-6-6-3-3-3 3m0 12 3 3 3-3M6 9l-3 3 3 3m12 0 3-3-3-3',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    save: 'M4 3h13l4 4v14H3V3Zm3 0v6h10V3M7 21v-8h10v8',
    close: 'm6 6 12 12M6 18 18 6',
    search: 'M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16m6-2 6 6',
    undo: 'M4 4v6h6M4 10a8 8 0 1 1 1 8',
    redo: 'M20 4v6h-6m6 0a8 8 0 1 0-1 8',
    lock: 'M5 10h14v11H5Zm3 0V6a4 4 0 0 1 8 0v4m-4 5v2',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20m0-12v7m0-11h.01',
    check: 'm4 12 5 5L20 6',
    warning: 'm12 3 10 18H2Zm0 5v6m0 3h.01',
    grid: 'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z',
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={paths[name]} />
        </svg>
    );
}

export function formatSize(bytes: number) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const unit = bytes < 1024 ** 2 ? 'KiB' : bytes < 1024 ** 3 ? 'MiB' : 'GiB';
    const divisor =
        unit === 'KiB' ? 1024 : unit === 'MiB' ? 1024 ** 2 : 1024 ** 3;
    return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

export function formatDate(value: string | number) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? '—'
        : date.toLocaleString('zh-CN', { hour12: false });
}

export function Modal({
    title,
    children,
    onClose,
    busy = false,
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    busy?: boolean;
}) {
    const container = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const busyRef = useRef(busy);
    busyRef.current = busy;

    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const node = container.current!;
        const focusables = () =>
            Array.from(
                node.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
                ),
            );
        (
            node.querySelector<HTMLElement>('[data-autofocus]') ??
            focusables()[0] ??
            node
        ).focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !busyRef.current) {
                event.preventDefault();
                closeRef.current();
            }
            if (event.key !== 'Tab') return;
            const elements = focusables();
            const first = elements[0];
            const last = elements[elements.length - 1];
            if (!first) {
                event.preventDefault();
                node.focus();
            } else if (
                event.shiftKey &&
                (document.activeElement === first ||
                    !node.contains(document.activeElement))
            ) {
                event.preventDefault();
                last.focus();
            } else if (
                !event.shiftKey &&
                (document.activeElement === last ||
                    !node.contains(document.activeElement))
            ) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', keydown);
        return () => {
            document.removeEventListener('keydown', keydown);
            previous?.focus();
        };
    }, []);

    return (
        <div
            className="modal-backdrop"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !busy) onClose();
            }}
        >
            <div
                ref={container}
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
            >
                <div className="modal-heading">
                    <h2>{title}</h2>
                    <button
                        className="icon-button"
                        aria-label="关闭对话框"
                        title="关闭对话框"
                        disabled={busy}
                        onClick={onClose}
                    >
                        <Icon name="close" />
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

export function IconButton({
    name,
    title,
    className = '',
    ...props
}: {
    name: IconName;
    title: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            type="button"
            {...props}
            className={`icon-button ${className}`}
            title={title}
            aria-label={title}
        >
            <Icon name={name} />
        </button>
    );
}

export function Menu({
    label,
    onClose,
    children,
}: {
    label: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        const trigger = document.activeElement as HTMLElement | null;
        const node = ref.current!;
        node.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
        const outside = (event: PointerEvent) => {
            if (!node.parentElement?.contains(event.target as Node))
                close.current();
        };
        document.addEventListener('pointerdown', outside);
        return () => {
            document.removeEventListener('pointerdown', outside);
            // Do not steal focus from a newly opened dialog.
            if (
                node.contains(document.activeElement) ||
                document.activeElement === document.body
            )
                trigger?.focus();
        };
    }, []);
    return (
        <div
            ref={ref}
            role="menu"
            aria-label={label}
            className="overflow-menu"
            onKeyDown={(event) => {
                if (event.key === 'Escape' || event.key === 'Tab') {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                    }
                    onClose();
                    return;
                }
                if (
                    !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
                )
                    return;
                event.preventDefault();
                const items = Array.from(
                    ref.current!.querySelectorAll<HTMLButtonElement>(
                        'button:not(:disabled)',
                    ),
                );
                if (!items.length) return;
                let index = items.indexOf(
                    document.activeElement as HTMLButtonElement,
                );
                index += event.key === 'ArrowDown' ? 1 : -1;
                if (event.key === 'Home') index = 0;
                if (event.key === 'End') index = items.length - 1;
                items[(index + items.length) % items.length].focus();
            }}
        >
            {children}
        </div>
    );
}
