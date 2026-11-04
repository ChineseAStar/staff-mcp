import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function isMarkdown(name: string) {
    return /\.(md|markdown)$/i.test(name);
}

// No raw HTML, image sources, active links or embedded media cross this view.
// In particular, previewing a draft never asks the host to read another file.
export function MarkdownPreview({ text }: { text: string }) {
    return (
        <div
            className="markdown-preview"
            aria-label="Markdown 草稿预览"
            tabIndex={0}
        >
            <div className="preview-hint">
                当前草稿 · 图片不加载，链接仅展示
            </div>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
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
        </div>
    );
}
