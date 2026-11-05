import { useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
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
export function MarkdownPreview({ text }: { text: string }) {
    const prefix = useId();
    const scroll = useRef<HTMLDivElement>(null);
    const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
    // Font/TOC interactions do not reparse or rehighlight the draft.
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
                    button: ({ node, children }) => (
                        <button
                            type="button"
                            onClick={() => {
                                const container = scroll.current;
                                const id = node?.properties.dataHeadingId;
                                if (!container || typeof id !== 'string')
                                    return;
                                const heading =
                                    container.querySelector<HTMLElement>(
                                        `#${CSS.escape(id)}`,
                                    );
                                if (!heading) return;
                                container.scrollTo({
                                    top:
                                        container.scrollTop +
                                        heading.getBoundingClientRect().top -
                                        container.getBoundingClientRect().top -
                                        16,
                                    behavior: 'instant',
                                });
                                heading.focus({ preventScroll: true });
                            }}
                        >
                            {children}
                        </button>
                    ),
                }}
            >
                {text}
            </ReactMarkdown>
        ),
        [text, prefix],
    );

    return (
        <div
            className="markdown-preview"
            aria-label="Markdown 草稿预览"
            style={{ '--markdown-font-size': `${fontSize}px` } as CSSProperties}
        >
            <div className="markdown-preview-toolbar">
                <span className="preview-hint">
                    当前草稿 · 图片不加载，链接仅展示
                </span>
                <div
                    className="markdown-font-controls"
                    role="group"
                    aria-label="预览字号"
                >
                    <button
                        type="button"
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
                    <button
                        type="button"
                        aria-label="重置预览字号"
                        title={`重置为 ${DEFAULT_FONT_SIZE}px`}
                        onClick={() => setFontSize(DEFAULT_FONT_SIZE)}
                    >
                        {fontSize}px
                    </button>
                    <button
                        type="button"
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
            </div>
            <div ref={scroll} className="markdown-preview-scroll" tabIndex={0}>
                <article className="markdown-body">{document}</article>
            </div>
        </div>
    );
}
