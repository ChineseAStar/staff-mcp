import { classHighlighter, highlightTree } from '@lezer/highlight';
import type { Element, ElementContent } from 'hast';
import type { Code, Heading, PhrasingContent, Root, RootContent } from 'mdast';
import { TEXT_AUTO_LIMIT } from '../text-limits';
import { fenceLanguage } from './languages';

const BLOCK_HIGHLIGHT_LIMIT = 64 * 1024;
const encoder = new TextEncoder();

function headingText(nodes: PhrasingContent[]): string {
    return nodes
        .map((node): string => {
            if (node.type === 'text' || node.type === 'inlineCode')
                return node.value;
            if (node.type === 'image') return node.alt ?? '';
            if ('children' in node) return headingText(node.children);
            return node.type === 'break' ? ' ' : '';
        })
        .join('');
}

function highlightBlock(node: Code, budget: number): number {
    if (!node.lang || node.value.length > BLOCK_HIGHLIGHT_LIMIT) return 0;
    const bytes = encoder.encode(node.value).length;
    if (bytes > BLOCK_HIGHLIGHT_LIMIT || bytes > budget) return 0;
    const language = fenceLanguage(node.lang);
    if (!language) return 0;

    // Only replace the code's children after a complete, successful highlight.
    // Unrecognized/over-budget/failed blocks keep ReactMarkdown's plain text.
    try {
        const children: ElementContent[] = [];
        let position = 0;
        highlightTree(
            language.parser.parse(node.value),
            classHighlighter,
            (from, to, classes) => {
                if (from > position) {
                    children.push({
                        type: 'text',
                        value: node.value.slice(position, from),
                    });
                }
                children.push({
                    type: 'element',
                    tagName: 'span',
                    properties: { className: classes.split(' ') },
                    children: [
                        { type: 'text', value: node.value.slice(from, to) },
                    ],
                });
                position = to;
            },
        );
        children.push({
            type: 'text',
            value: node.value.slice(position) + (node.value ? '\n' : ''),
        });
        node.data = { ...node.data, hChildren: children };
    } catch {
        // A syntax colorer must never hide otherwise readable source text.
    }
    return bytes;
}

function element(
    tagName: string,
    children: ElementContent[],
    properties: Element['properties'] = {},
): Element {
    return { type: 'element', tagName, properties, children };
}

// Reuse ReactMarkdown's existing AST pass: no second full-document parse or
// DOM scanning. Generated TOC controls contain only text, never document HTML.
export function remarkPreview({ prefix }: { prefix: string }) {
    return (tree: Root) => {
        const headings: { id: string; label: string; depth: number }[] = [];
        const occurrences = new Map<string, number>();
        let budget = TEXT_AUTO_LIMIT;
        const visit = (nodes: RootContent[]) => {
            for (const node of nodes) {
                if (node.type === 'heading') {
                    const heading: Heading = node;
                    const label =
                        headingText(heading.children).trim() || '无标题';
                    const slug =
                        label
                            .normalize('NFC')
                            .toLowerCase()
                            .replace(/[^\p{L}\p{N}_-]+/gu, '-')
                            .replace(/^-+|-+$/g, '')
                            .slice(0, 80) || 'section';
                    const occurrence = (occurrences.get(slug) ?? 0) + 1;
                    occurrences.set(slug, occurrence);
                    const id = `${prefix}-heading-${slug}-${occurrence}`;
                    heading.data = {
                        ...heading.data,
                        hProperties: { id, tabIndex: -1 },
                    };
                    headings.push({ id, label, depth: heading.depth });
                } else if (node.type === 'code') {
                    budget -= highlightBlock(node, budget);
                }
                if ('children' in node) visit(node.children);
            }
        };
        visit(tree.children);
        if (!headings.length) return;
        tree.children.unshift({
            type: 'paragraph',
            children: [],
            data: {
                hName: 'details',
                hProperties: { className: ['markdown-toc'] },
                hChildren: [
                    element('summary', [
                        { type: 'text', value: `目录 · ${headings.length}` },
                    ]),
                    element(
                        'nav',
                        [
                            element(
                                'ol',
                                headings.map(({ id, label, depth }) =>
                                    element(
                                        'li',
                                        [
                                            element(
                                                'button',
                                                [
                                                    {
                                                        type: 'text',
                                                        value: label,
                                                    },
                                                ],
                                                {
                                                    type: 'button',
                                                    dataHeadingId: id,
                                                },
                                            ),
                                        ],
                                        {
                                            className: [
                                                `markdown-toc-level-${depth}`,
                                            ],
                                        },
                                    ),
                                ),
                            ),
                        ],
                        { ariaLabel: 'Markdown 标题导航' },
                    ),
                ],
            },
        });
    };
}
