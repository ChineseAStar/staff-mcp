import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { indentWithTab } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';

interface Props {
    id: string;
    name: string;
    text: string;
    revision: number;
    active: boolean;
    readOnly: boolean;
    onChange: (text: string) => void;
    onSave: () => void;
    onView: (id: string, view: EditorView | null) => void;
}

const chinesePhrases = {
    Find: '查找',
    Replace: '替换为',
    next: '下一处',
    previous: '上一处',
    all: '全部匹配',
    'match case': '区分大小写',
    regexp: '正则表达式',
    'by word': '全字匹配',
    replace: '替换',
    'replace all': '全部替换',
    close: '关闭搜索',
    'Go to line': '跳转到行',
    go: '跳转',
    'Fold line': '折叠此行',
    'Unfold line': '展开此行',
    'to line': '到行',
    'folded code': '已折叠代码',
    unfold: '展开',
    'No diagnostics': '没有诊断信息',
    'current match': '当前匹配',
    'on line': '位于行',
    'replaced $ matches': '已替换 $ 处匹配',
    'replaced match on line $': '已替换第 $ 行的匹配',
};

function language(name: string) {
    if (/\.(json|jsonc)$/i.test(name)) return json();
    if (/\.(md|markdown)$/i.test(name)) return markdown();
    if (/\.(html?|svg|xml)$/i.test(name)) return html();
    if (/\.(jsx?|tsx?|mjs|cjs)$/i.test(name)) {
        return javascript({
            typescript: /\.(ts|tsx)$/i.test(name),
            jsx: /\.[jt]sx$/i.test(name),
        });
    }
    if (/\.css$/i.test(name)) return css();
    return [];
}

// Each tab keeps its own mounted editor, including selection and undo history.
export function TextEditor(props: Props) {
    const container = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const editable = useRef(new Compartment());
    const wrapping = useRef(new Compartment());
    const current = useRef(props);
    current.current = props;

    useEffect(() => {
        if (!container.current) return;
        const initial = current.current;
        const compact = window.matchMedia(
            '(max-width: 599px), (max-width: 1000px) and (max-height: 500px)',
        );
        const lineBreak = initial.text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
        const instance = new EditorView({
            parent: container.current,
            state: EditorState.create({
                doc: initial.text,
                extensions: [
                    basicSetup,
                    syntaxHighlighting(
                        HighlightStyle.define([
                            {
                                tag: tags.keyword,
                                color: 'var(--syntax-keyword)',
                            },
                            {
                                tag: [tags.name, tags.propertyName],
                                color: 'var(--text-primary)',
                            },
                            {
                                tag: [tags.string, tags.inserted],
                                color: 'var(--syntax-string)',
                            },
                            {
                                tag: [tags.number, tags.bool, tags.null],
                                color: 'var(--syntax-number)',
                            },
                            {
                                tag: [
                                    tags.function(tags.variableName),
                                    tags.tagName,
                                ],
                                color: 'var(--syntax-function)',
                            },
                            {
                                tag: [tags.comment, tags.meta],
                                color: 'var(--text-muted)',
                            },
                            {
                                tag: [tags.heading, tags.strong],
                                fontWeight: 'bold',
                            },
                            { tag: tags.emphasis, fontStyle: 'italic' },
                            {
                                tag: tags.link,
                                color: 'var(--color-primary)',
                                textDecoration: 'underline',
                            },
                            {
                                tag: [tags.invalid, tags.deleted],
                                color: 'var(--syntax-invalid)',
                            },
                        ]),
                    ),
                    wrapping.current.of(
                        compact.matches ? EditorView.lineWrapping : [],
                    ),
                    language(initial.name),
                    EditorState.lineSeparator.of(lineBreak),
                    EditorState.phrases.of(chinesePhrases),
                    EditorView.contentAttributes.of({
                        'aria-label': `编辑 ${initial.name}`,
                        'aria-multiline': 'true',
                        spellcheck: 'false',
                    }),
                    editable.current.of([
                        EditorState.readOnly.of(initial.readOnly),
                        EditorView.editable.of(!initial.readOnly),
                    ]),
                    keymap.of([
                        {
                            key: 'Mod-s',
                            run: () => {
                                current.current.onSave();
                                return true;
                            },
                        },
                        indentWithTab,
                    ]),
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) {
                            current.current.onChange(update.state.sliceDoc());
                        }
                    }),
                    EditorView.theme({
                        '&': {
                            height: '100%',
                            fontSize: '13px',
                            backgroundColor: 'var(--bg-primary)',
                            color: 'var(--text-primary)',
                        },
                        '.cm-scroller': {
                            overflow: 'auto',
                            fontFamily: 'var(--font-code-family)',
                            lineHeight: '1.75',
                        },
                        '.cm-content': { padding: '12px 0', minHeight: '100%' },
                        '.cm-gutters': {
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-muted)',
                            borderRight: '1px solid var(--color-border-light)',
                        },
                        '.cm-activeLine, .cm-activeLineGutter': {
                            backgroundColor: 'var(--color-primary-light)',
                        },
                        '&.cm-focused': { outline: 'none' },
                        '.cm-cursor': {
                            borderLeftColor: 'var(--color-primary)',
                        },
                        '.cm-selectionBackground': {
                            backgroundColor:
                                'var(--color-surface-active) !important',
                        },
                        '.cm-searchMatch': { backgroundColor: '#fff0b2' },
                        '.cm-searchMatch-selected': {
                            backgroundColor: '#ffd887',
                        },
                        '.cm-panels': {
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                        },
                        '.cm-textfield': {
                            background: 'var(--input-bg)',
                            border: '1px solid var(--input-border)',
                            borderRadius: '4px',
                        },
                        '.cm-button': {
                            backgroundImage: 'none',
                            background: 'var(--input-bg)',
                            border: '1px solid var(--input-border)',
                            borderRadius: '4px',
                        },
                    }),
                ],
            }),
        });
        view.current = instance;
        const updateWrapping = () => {
            instance.dispatch({
                effects: wrapping.current.reconfigure(
                    compact.matches ? EditorView.lineWrapping : [],
                ),
            });
        };
        compact.addEventListener('change', updateWrapping);
        initial.onView(initial.id, instance);
        return () => {
            compact.removeEventListener('change', updateWrapping);
            initial.onView(initial.id, null);
            view.current = null;
            instance.destroy();
        };
    }, [props.id, props.revision]);

    useEffect(() => {
        view.current?.dispatch({
            effects: editable.current.reconfigure([
                EditorState.readOnly.of(props.readOnly),
                EditorView.editable.of(!props.readOnly),
            ]),
        });
    }, [props.readOnly, props.revision]);

    useEffect(() => {
        if (props.active) view.current?.requestMeasure();
    }, [props.active]);

    return <div ref={container} className="code-editor" />;
}
