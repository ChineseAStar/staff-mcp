import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

// Only positioning, dismissal and keyboard focus live here; file actions stay in App.
export function FileContextMenu({
    label,
    x,
    y,
    trigger,
    onClose,
    children,
}: {
    label: string;
    x: number;
    y: number;
    trigger: HTMLElement;
    onClose: () => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const close = useRef(onClose);
    close.current = onClose;

    useLayoutEffect(() => {
        const node = ref.current!;
        const bounds = node.getBoundingClientRect();
        node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
        node.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
        node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({
            preventScroll: true,
        });
        const outside = (event: PointerEvent) => {
            // Do not dismiss on a menu item's pointerdown: it still needs its click.
            if (!node.contains(event.target as Node)) close.current();
        };
        const scroll = (event: Event) => {
            if (!(event.target instanceof Node) || !node.contains(event.target))
                close.current();
        };
        const resize = () => close.current();
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('scroll', scroll, true);
        window.addEventListener('resize', resize);
        return () => {
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('scroll', scroll, true);
            window.removeEventListener('resize', resize);
            // A newly opened dialog or an outside click owns its own focus.
            if (
                trigger.isConnected &&
                (node.contains(document.activeElement) ||
                    document.activeElement === document.body)
            ) {
                trigger.focus({ preventScroll: true });
            }
        };
    }, [x, y, trigger]);

    return (
        <div
            ref={ref}
            role="menu"
            aria-label={label}
            className="overflow-menu file-context-menu"
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
                if (event.key === 'Escape' || event.key === 'Tab') {
                    if (event.key === 'Escape') event.preventDefault();
                    event.stopPropagation();
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
