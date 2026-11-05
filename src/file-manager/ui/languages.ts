import { StreamLanguage } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/legacy-modes/mode/python';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { c, cpp, java } from '@codemirror/legacy-modes/mode/clike';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { TEXT_AUTO_LIMIT } from '../text-limits';

export function language(name: string, size: number) {
    // Large, explicitly loaded documents stay plain text: no full syntax parse.
    if (size >= TEXT_AUTO_LIMIT) return [];
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
    if (/\.(py|pyw)$/i.test(name)) return StreamLanguage.define(python);
    if (/\.(sh|bash|zsh|ksh)$/i.test(name)) return StreamLanguage.define(shell);
    if (/\.(ya?ml)$/i.test(name)) return StreamLanguage.define(yaml);
    if (/\.toml$/i.test(name)) return StreamLanguage.define(toml);
    if (/\.sql$/i.test(name)) return StreamLanguage.define(standardSQL);
    if (/\.(c|h)$/i.test(name)) return StreamLanguage.define(c);
    if (/\.(cc|cpp|cxx|c\+\+|hh|hpp|hxx|h\+\+)$/i.test(name)) {
        return StreamLanguage.define(cpp);
    }
    if (/\.java$/i.test(name)) return StreamLanguage.define(java);
    if (/\.go$/i.test(name)) return StreamLanguage.define(go);
    if (/\.rs$/i.test(name)) return StreamLanguage.define(rust);
    if (
        /(?:^|[/\\])Dockerfile(?:\.[^/\\]+)?$/i.test(name) ||
        /\.dockerfile$/i.test(name)
    ) {
        return StreamLanguage.define(dockerFile);
    }
    return [];
}
