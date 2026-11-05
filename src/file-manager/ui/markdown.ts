import { classHighlighter, highlightTree } from '@lezer/highlight';
import type { ElementContent } from 'hast';
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

// IDs and outline labels share the existing AST pass with bounded highlighting.
// The outline is UI chrome, never injected into the article.
export function remarkPreview({ prefix }: { prefix: string }) {
    return (tree: Root) => {
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
                        hProperties: {
                            id,
                            tabIndex: -1,
                            'data-outline-label': label,
                        },
                    };
                } else if (node.type === 'code') {
                    budget -= highlightBlock(node, budget);
                }
                if ('children' in node) visit(node.children);
            }
        };
        visit(tree.children);
    };
}
