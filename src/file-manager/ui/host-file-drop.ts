import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { bridge } from './bridge';

export interface DropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export type HostDropEvent =
    | {
          type: 'file-drop-start';
          batchId: string;
          epoch: string;
          revision: number;
          token: string;
      }
    | {
          type: 'file-drop-hover';
          epoch: string;
          revision: number;
          token: string | null;
      }
    | { type: 'file-drop-error'; message: string };

export interface DropTarget {
    directory: string;
    row?: string;
}
export interface HostDropLayout {
    epoch: string;
    revision: number;
    surface: DropRect | null;
    rootToken: string;
    targets: Array<{ token: string; rect: DropRect }>;
    // Never sent to the host. Only the tree resolves opaque tokens to paths.
    destinations: ReadonlyMap<string, DropTarget>;
    refresh: () => void;
}

// getRandomValues also works in the opaque, non-secure srcdoc fallback.
function opaqueToken() {
    return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
        value.toString(16).padStart(8, '0'),
    ).join('');
}

function intersect(a: DropRect, b: DropRect): DropRect | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > x && bottom > y
        ? { x, y, width: right - x, height: bottom - y }
        : null;
}

function bounds(element: HTMLElement): DropRect {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
}

// Called by DirectoryTree: geometry and token/path authority stay with the tree.
export function useHostFileDrop(
    list: RefObject<HTMLDivElement | null>,
    scope: string,
    enabled: boolean,
    onLayout: (layout: HostDropLayout | undefined) => void,
    onHover: (target: DropTarget | undefined) => void,
) {
    const callbacks = useRef({ onLayout, onHover, enabled });
    callbacks.current = { onLayout, onHover, enabled };
    const update = useRef<() => void>(() => {});
    const activate = useRef<() => boolean>(() => false);
    useLayoutEffect(() => {
        const element = list.current;
        if (!element) return;
        let epoch = opaqueToken();
        let revision = 0;
        let previous = '';
        let layout: HostDropLayout | undefined;
        let configured = false;
        let unsupported = false;
        let activating = false;
        let disposed = false;
        let pageHidden = false;
        let rootToken = opaqueToken();
        const tokens = new Map<string, { token: string; directory: string }>();
        const publish = (forceNull = false) => {
            const state = bridge.snapshot();
            let surface: DropRect | null = null;
            const destinations = new Map<string, DropTarget>();
            const targets: HostDropLayout['targets'] = [];
            if (
                !forceNull &&
                !pageHidden &&
                callbacks.current.enabled &&
                state.enabled &&
                state.connected &&
                state.visible &&
                element.getClientRects().length &&
                getComputedStyle(element).visibility !== 'hidden'
            ) {
                const box = bounds(element);
                // The scrollport excludes borders and the native scrollbar.
                surface = intersect(
                    {
                        x: box.x + element.clientLeft,
                        y: box.y + element.clientTop,
                        width: element.clientWidth,
                        height: element.clientHeight,
                    },
                    {
                        x: 0,
                        y: 0,
                        width: window.innerWidth,
                        height: window.innerHeight,
                    },
                );
                // Respect clipping/hidden ancestors (including the narrow pane).
                for (
                    let parent = element.parentElement;
                    parent && surface;
                    parent = parent.parentElement
                ) {
                    const style = getComputedStyle(parent);
                    if (
                        style.display === 'none' ||
                        style.visibility === 'hidden'
                    )
                        surface = null;
                    else if (
                        /(auto|scroll|hidden|clip)/.test(
                            `${style.overflowX} ${style.overflowY}`,
                        )
                    )
                        surface = intersect(surface, bounds(parent));
                }
            }
            if (surface) {
                destinations.set(rootToken, { directory: '' });
                for (const node of element.querySelectorAll<HTMLElement>(
                    '[role="treeitem"]',
                )) {
                    // A treeitem includes its expanded subtree; measure only
                    // its own row, never the enclosing node's rectangle.
                    const row = node.querySelector<HTMLElement>(
                        ':scope > .file-row[data-entry-path][data-upload-directory]',
                    );
                    if (!row || !row.getClientRects().length) continue;
                    const rect = intersect(bounds(row), surface);
                    if (!rect) continue;
                    const path = row.dataset.entryPath!;
                    const directory = row.dataset.uploadDirectory!;
                    let target = tokens.get(path);
                    if (!target || target.directory !== directory) {
                        target = { token: opaqueToken(), directory };
                        tokens.set(path, target);
                    }
                    targets.push({ token: target.token, rect });
                    destinations.set(target.token, { directory, row: path });
                }
            }
            const geometry = JSON.stringify({ surface, rootToken, targets });
            if (geometry === previous) return;
            previous = geometry;
            revision++;
            configured = false;
            callbacks.current.onHover(undefined);
            layout = {
                epoch,
                revision,
                surface,
                rootToken,
                targets,
                destinations,
                refresh: () => publish(),
            };
            callbacks.current.onLayout(unsupported ? undefined : layout);
            // Host lifecycle already unregisters hidden instances. Sending a
            // hidden configure can be rejected without implying unsupported API.
            if (
                unsupported ||
                !state.connected ||
                !state.enabled ||
                !state.visible
            )
                return;
            const sent = layout;
            void bridge
                .request<{
                    version: number;
                }>('fileDropConfigure', {
                    version: 1,
                    epoch,
                    revision,
                    surface,
                    rootToken,
                    targets,
                })
                .then(
                    (result) => {
                        if (disposed || layout !== sent) return;
                        configured = result?.version === 1;
                        if (!configured) {
                            unsupported = true;
                            callbacks.current.onLayout(undefined);
                        }
                    },
                    () => {
                        if (disposed || layout !== sent) return;
                        const current = bridge.snapshot();
                        if (
                            current.connected &&
                            current.enabled &&
                            current.visible
                        )
                            unsupported = true;
                        callbacks.current.onLayout(undefined);
                    },
                );
        };
        update.current = () => publish();
        activate.current = () => {
            // Capture current scroll/resize geometry before native activation.
            publish();
            // While negotiation/activation is pending, only a host hover means
            // the overlay is ready. Legacy hosts retain direct-file highlighting.
            const delegated = !unsupported && !!layout?.surface;
            if (!configured || !layout?.surface || activating) return delegated;
            activating = true;
            // Hover is exclusively host-owned once delegated; an activate
            // response must not erase a newer ready-hover event.
            void bridge
                .request<{ active: boolean }>('fileDropActivate')
                .catch(() => {})
                .finally(() => {
                    activating = false;
                });
            return true;
        };
        const stopEvents = bridge.onHostDrop((event) => {
            if (event.type !== 'file-drop-hover') return;
            // Also flush geometry before accepting hover from a queued old event.
            publish();
            if (
                event.epoch !== layout?.epoch ||
                event.revision !== layout.revision
            )
                return;
            callbacks.current.onHover(
                event.token === null
                    ? undefined
                    : layout.destinations.get(event.token),
            );
        });
        let state = bridge.snapshot();
        const stopLifecycle = bridge.subscribe(() => {
            const next = bridge.snapshot();
            if (
                state.connected !== next.connected ||
                state.enabled !== next.enabled ||
                state.visible !== next.visible
            ) {
                // Even a hide/show pair batched by React must get a fresh epoch.
                epoch = opaqueToken();
                rootToken = opaqueToken();
                tokens.clear();
                revision = 0;
                previous = '';
                configured = false;
                activating = false;
                // One fresh negotiation per restored lifetime, never a scroll/
                // render retry loop against a genuinely old host.
                if (next.connected && next.enabled && next.visible)
                    unsupported = false;
                callbacks.current.onLayout(undefined);
                publish();
            }
            state = next;
        });
        const resize = new ResizeObserver(() => publish());
        // Ancestor sizing moves the tree without necessarily resizing a row.
        for (
            let parent: HTMLElement | null = element;
            parent;
            parent = parent.parentElement
        )
            resize.observe(parent);
        const scroll = () => publish();
        const pagehide = () => {
            pageHidden = true;
            publish(true);
        };
        const pageshow = () => {
            pageHidden = false;
            publish();
        };
        document.addEventListener('scroll', scroll, true);
        window.addEventListener('resize', scroll);
        window.addEventListener('pagehide', pagehide);
        window.addEventListener('pageshow', pageshow);
        publish();
        return () => {
            publish(true);
            disposed = true;
            update.current = () => {};
            activate.current = () => false;
            callbacks.current.onLayout(undefined);
            callbacks.current.onHover(undefined);
            stopEvents();
            stopLifecycle();
            resize.disconnect();
            document.removeEventListener('scroll', scroll, true);
            window.removeEventListener('resize', scroll);
            window.removeEventListener('pagehide', pagehide);
            window.removeEventListener('pageshow', pageshow);
        };
    }, [list, scope]);
    // Includes row expansion, pagination, inline naming and pane visibility.
    useLayoutEffect(() => update.current());
    return { activate: () => activate.current() };
}
