import {
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkPreview } from './markdown';

export function isMarkdown(name: string) {
    return /\.(md|markdown)$/i.test(name);
}

const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 24;

// No raw HTML, image sources, active links or embedded media cross this view.
// In particular, previewing a draft never asks the host to read another file.
export function MarkdownPreview({
    text,
    toolbarTarget,
    active,
}: {
    text: string;
    toolbarTarget: HTMLElement | null;
    active: boolean;
}) {
    const prefix = useId();
    const panel = useRef<HTMLDivElement>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const outline = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
    const [wide, setWide] = useState(false);
    const [showOutline, setShowOutline] = useState(true);
    const [popover, setPopover] = useState(false);
    const [headings, setHeadings] = useState<HTMLElement[]>([]);
    const [activeId, setActiveId] = useState('');
    const outlineVisible =
        active && headings.length > 0 && (wide ? showOutline : popover);

    // Font/outline interactions do not reparse or rehighlight the draft.
    const document = useMemo(
        () => (
            <ReactMarkdown
                remarkPlugins={[remarkGfm, [remarkPreview, { prefix }]]}
                skipHtml
                urlTransform={() => ''}
                components={{
                    a: ({ children }) => (
                        <span
                            className="markdown-link"
                            title="预览中不打开链接"
                        >
                            {children}
                        </span>
                    ),
                    img: ({ alt }) => (
                        <span className="markdown-image-placeholder">
                            [图片未加载{alt ? `：${alt}` : ''}]
                        </span>
                    ),
                }}
            >
                {text}
            </ReactMarkdown>
        ),
        [text, prefix],
    );

    // Only collect the rendered heading elements, once per draft; no second
    // Markdown parse. IDs and plain labels come from the existing AST pass.
    useLayoutEffect(() => {
        setHeadings(
            Array.from(
                scroll.current!.querySelectorAll<HTMLElement>(
                    'h1,h2,h3,h4,h5,h6',
                ),
            ),
        );
    }, [text]);

    useLayoutEffect(() => {
        const observer = new ResizeObserver(([entry]) => {
            // Reserve comfortable article width even when the file tree grows.
            setWide(entry.contentRect.width >= 980);
            setPopover(false);
        });
        observer.observe(panel.current!);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!active) setPopover(false);
    }, [active]);

    useEffect(() => {
        if (!active) return;
        const container = scroll.current!;
        let frame = 0;
        const update = () => {
            frame = 0;
            const top = container.getBoundingClientRect().top + 32;
            let current: HTMLElement | undefined = headings[0];
            for (const heading of headings) {
                if (heading.getBoundingClientRect().top > top) break;
                current = heading;
            }
            // At the end, short last sections still become the active heading.
            if (
                container.scrollTop > 0 &&
                container.scrollTop + container.clientHeight >=
                    container.scrollHeight - 2
            )
                current = headings.at(-1);
            setActiveId(current?.id ?? '');
        };
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(update);
        };
        update();
        container.addEventListener('scroll', schedule, { passive: true });
        const observer = new ResizeObserver(schedule);
        observer.observe(container);
        return () => {
            container.removeEventListener('scroll', schedule);
            observer.disconnect();
            cancelAnimationFrame(frame);
        };
    }, [headings, active, fontSize, wide, showOutline]);

    useEffect(() => {
        const list = outline.current;
        const selected = list?.querySelector<HTMLElement>(
            '[aria-current="location"]',
        );
        if (!list || !selected) return;
        const bounds = list.getBoundingClientRect();
        const item = selected.getBoundingClientRect();
        if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
        else if (item.bottom > bounds.bottom)
            list.scrollTop += item.bottom - bounds.bottom;
    }, [activeId, outlineVisible]);

    useEffect(() => {
        if (!outlineVisible || wide) return;
        const node = outline.current!;
        (
            node.querySelector<HTMLElement>('[aria-current="location"]') ??
            node.querySelector<HTMLElement>('button')
        )?.focus({ preventScroll: true });
        const close = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setPopover(false);
            trigger.current?.focus();
        };
        const outside = (event: PointerEvent) => {
            if (
                !node.contains(event.target as Node) &&
                !trigger.current?.contains(event.target as Node)
            )
                setPopover(false);
        };
        const focusOutside = (event: FocusEvent) => {
            if (
                !node.contains(event.target as Node) &&
                !trigger.current?.contains(event.target as Node)
            )
                setPopover(false);
        };
        window.addEventListener('keydown', close, true);
        window.addEventListener('pointerdown', outside, true);
        window.addEventListener('focusin', focusOutside);
        return () => {
            window.removeEventListener('keydown', close, true);
            window.removeEventListener('pointerdown', outside, true);
            window.removeEventListener('focusin', focusOutside);
        };
    }, [outlineVisible, wide]);

    const jump = (heading: HTMLElement) => {
        const container = scroll.current!;
        container.scrollTo({
            top:
                container.scrollTop +
                heading.getBoundingClientRect().top -
                container.getBoundingClientRect().top -
                16,
            behavior: 'instant',
        });
        setActiveId(heading.id);
        if (!wide) setPopover(false);
        heading.focus({ preventScroll: true });
    };

    return (
        <div
            ref={panel}
            className="markdown-preview"
            aria-label="Markdown 草稿预览"
            style={{ '--markdown-font-size': `${fontSize}px` } as CSSProperties}
        >
            {active &&
                toolbarTarget &&
                createPortal(
                    <>
                        <div
                            className="markdown-font-controls"
                            role="group"
                            aria-label="预览字号"
                        >
                            <button
                                type="button"
                                className="font-step"
                                aria-label="减小预览字号"
                                disabled={fontSize <= MIN_FONT_SIZE}
                                onClick={() =>
                                    setFontSize((size) =>
                                        Math.max(MIN_FONT_SIZE, size - 1),
                                    )
                                }
                            >
                                A−
                            </button>
                            <select
                                aria-label="预览字号"
                                title="预览字号（默认 15px）"
                                value={fontSize}
                                onChange={(event) =>
                                    setFontSize(Number(event.target.value))
                                }
                            >
                                {Array.from(
                                    {
                                        length:
                                            MAX_FONT_SIZE - MIN_FONT_SIZE + 1,
                                    },
                                    (_, index) => MIN_FONT_SIZE + index,
                                ).map((size) => (
                                    <option key={size} value={size}>
                                        {size}px
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                className="font-step"
                                aria-label="增大预览字号"
                                disabled={fontSize >= MAX_FONT_SIZE}
                                onClick={() =>
                                    setFontSize((size) =>
                                        Math.min(MAX_FONT_SIZE, size + 1),
                                    )
                                }
                            >
                                A+
                            </button>
                        </div>
                        {headings.length > 0 && (
                            <button
                                ref={trigger}
                                type="button"
                                className="outline-toggle"
                                aria-label="Markdown 目录"
                                title={`当前草稿 · ${headings.length} 个标题 · 图片不加载，链接仅展示`}
                                aria-expanded={outlineVisible}
                                aria-controls={`${prefix}-outline`}
                                aria-haspopup={wide ? undefined : 'dialog'}
                                onClick={() =>
                                    wide
                                        ? setShowOutline((value) => !value)
                                        : setPopover((value) => !value)
                                }
                            >
                                目录
                            </button>
                        )}
                        <span
                            className="preview-hint"
                            title="当前草稿 · 图片不加载，链接仅展示"
                        >
                            草稿 · {headings.length} 个标题 · 图片/链接仅展示
                        </span>
                    </>,
                    toolbarTarget,
                )}
            <div ref={scroll} className="markdown-preview-scroll" tabIndex={0}>
                <article className="markdown-body">{document}</article>
            </div>
            {outlineVisible && headings.length > 0 && (
                <div
                    ref={outline}
                    id={`${prefix}-outline`}
                    className={`markdown-outline ${wide ? 'docked' : 'popover'}`}
                    role={wide ? 'complementary' : 'dialog'}
                    aria-label="Markdown 目录"
                >
                    <div className="outline-heading">
                        <strong>目录 · {headings.length}</strong>
                        <button
                            type="button"
                            aria-label="收起目录"
                            onClick={() => {
                                if (wide) setShowOutline(false);
                                else setPopover(false);
                                trigger.current?.focus();
                            }}
                        >
                            ×
                        </button>
                    </div>
                    <nav aria-label="Markdown 标题导航">
                        <ol>
                            {headings.map((heading) => (
                                <li
                                    key={heading.id}
                                    className={`markdown-toc-level-${heading.tagName.slice(1)}`}
                                >
                                    <button
                                        type="button"
                                        aria-current={
                                            heading.id === activeId
                                                ? 'location'
                                                : undefined
                                        }
                                        onClick={() => jump(heading)}
                                    >
                                        {heading.dataset.outlineLabel ??
                                            heading.textContent}
                                    </button>
                                </li>
                            ))}
                        </ol>
                    </nav>
                </div>
            )}
        </div>
    );
}
